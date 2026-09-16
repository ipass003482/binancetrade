// Operational process recovery only. No accounts, network, orders or inference.
import {readFile,writeFile,open,mkdir,rename,unlink,stat,readdir,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,dirname,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';

export const SETTINGS=Object.freeze({intervalMs:10000,heartbeatStaleMs:90000,sourceStaleMs:600000,
 restartWindowMs:1800000,maxRestarts:3,restartBackoffMs:60000});
export const SOURCE_FILES=Object.freeze(['src/pretrained_model.py','scripts/kronos-worker.py','scripts/setup_kronos.py','config/model-research.json']);
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),BASE=join(ROOT,'local','model-watchdog');
const HEX=/^[a-f0-9]{64}$/,sha=value=>createHash('sha256').update(value).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=code=>{throw Error('WATCHDOG_'+code);};
const millis=value=>{const n=typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;if(!Number.isSafeInteger(n)||n<0)fail('TIME_INVALID');return n;};
const normalized=path=>typeof path==='string'?win32.normalize(path).toLowerCase():'';
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const quotePS=value=>"'"+value.replace(/'/g,"''")+"'";
const safeError=error=>/^WATCHDOG_[A-Z_]+$/.test(error?.message??'')?error.message:
 /^(?:EACCES|EPERM|EBUSY|ENOSPC|ENOENT|ETIMEDOUT)$/.test(error?.code??'')?'WATCHDOG_IO_'+error.code:'WATCHDOG_OPERATION_FAILED';

export function verifyIdentity({loaded,execution,computedFingerprint,sourceHashes}){
 if(!object(loaded)||loaded.schemaVersion!==1||loaded.model!=='kronos-small-pretrained-v1'||
  loaded.pretrained!==true||loaded.fineTuned!==false||!HEX.test(loaded.fingerprint??'')||
  loaded.fingerprint!==computedFingerprint||!object(execution)||execution.schemaVersion!==1||
  execution.model!==loaded.model||execution.modelFingerprint!==loaded.fingerprint||typeof execution.enabled!=='boolean')fail('IDENTITY_INVALID');
 if(!object(loaded.implementation)||Object.keys(loaded.implementation).sort().join('|')!==[...SOURCE_FILES].sort().join('|')||
  !object(sourceHashes)||Object.keys(sourceHashes).sort().join('|')!==[...SOURCE_FILES].sort().join('|')||
  SOURCE_FILES.some(path=>!HEX.test(loaded.implementation[path]??'')||sourceHashes[path]!==loaded.implementation[path]))fail('SOURCE_CHANGED');
 millis(loaded.loadedAt);
 return {fingerprint:loaded.fingerprint,executionEnabled:execution.enabled,loadedAt:loaded.loadedAt,sourceHashes};
}

export function classifyProcesses(processes,root){
 if(!Array.isArray(processes))fail('PROCESS_INVENTORY_INVALID');
 const worker=normalized(win32.join(root,'scripts','kronos-worker.py')),
  venv=normalized(win32.join(root,'.venv-model','Scripts','python.exe')),
  runtimePrefix=normalized(win32.join(root,'.runtime','python'))+'\\';
 const exact=[],ambiguous=[],seen=new Set();
 for(const row of processes){
  if(!object(row)||!Number.isSafeInteger(row.pid)||row.pid<=0||seen.has(row.pid)||
    !Number.isSafeInteger(row.parentPid)||row.parentPid<0||typeof row.name!=='string')fail('PROCESS_INVENTORY_INVALID');
  seen.add(row.pid);
  const exe=normalized(row.executablePath),line=typeof row.commandLine==='string'?row.commandLine.trim():'',lower=line.toLowerCase();
  const scriptHint=lower.includes(worker),projectPython=exe===venv||exe.startsWith(runtimePrefix);
  if(!scriptHint){if(/^python(?:w)?\.exe$/i.test(row.name)&&(!line&&!exe||projectPython&&!line))ambiguous.push({pid:row.pid,reason:'unreadable_python_identity'});continue;}
  const allowedExe=exe===venv||exe.startsWith(runtimePrefix)&&/^python(?:w)?\.exe$/i.test(win32.basename(exe));
  const atom=p=>'(?:"'+escaped(p)+'"|'+escaped(p)+')';
  const shape=new RegExp('^'+atom(exe)+'\\s+(?:-u\\s+)?'+atom(worker)+'\\s+watch\\s*$','i');
  if(!allowedExe||!/^python(?:w)?\.exe$/i.test(row.name)||!shape.test(line)){
   ambiguous.push({pid:row.pid,reason:'worker_command_or_executable_mismatch'});continue;
  }
  const createdAt=millis(row.createdAt);
  exact.push({pid:row.pid,parentPid:row.parentPid,createdAt});
 }
 const roots=exact.filter(p=>!exact.some(parent=>parent.pid===p.parentPid));
 const leaves=exact.filter(p=>!exact.some(child=>child.parentPid===p.pid));
 if(exact.length>2||roots.length>1||exact.length>0&&leaves.length!==1)ambiguous.push({reason:'multiple_worker_chains'});
 return {exact,ambiguous,pids:exact.map(p=>p.pid),leafPid:leaves.length===1?leaves[0].pid:null,
  alive:exact.length>0,unambiguous:ambiguous.length===0};
}

export function validateBudget(value,now){
 if(!object(value)||value.schemaVersion!==1||!HEX.test(value.modelFingerprint??'')||!Array.isArray(value.attempts)||
  value.attempts.length>1000||millis(value.createdAt)>now)fail('BUDGET_INVALID');
 const ids=new Set();let last=-1;
 for(const item of value.attempts){
  if(!object(item)||!HEX.test(item.id??'')||ids.has(item.id)||!['reserved','started','already_present','failed','cancelled'].includes(item.status))fail('BUDGET_INVALID');
  const at=millis(item.at);if(at>now||at<last)fail('BUDGET_CLOCK_REVERSED');last=at;ids.add(item.id);
 }
 return value;
}

export function decideRecovery({now,root,processes,identity,status,budget,stops}){
 if(!Number.isSafeInteger(now)||now<0||!object(stops)||['watchdog','model','demo','demo-futures'].some(k=>typeof stops[k]!=='boolean'))fail('INPUT_INVALID');
 validateBudget(budget,now);
 if(identity.fingerprint!==budget.modelFingerprint)fail('PIN_CHANGED');
 const inventory=classifyProcesses(processes,root),result={action:'none',status:'healthy',pids:inventory.pids,
  modelFingerprint:identity.fingerprint,heartbeat:null,source:null,restart:false};
 if(stops.watchdog||stops.model||stops.demo&&stops['demo-futures']||!identity.executionEnabled)
  return {...result,status:'paused',reason:stops.watchdog?'watchdog_stop':stops.model?'model_stop':!identity.executionEnabled?'execution_disabled':'both_demo_modes_stopped'};
 if(!inventory.unambiguous)return {...result,status:'degraded',reason:'ambiguous_worker_process',processEvidence:inventory.ambiguous};
 if(status!==null){
  if(!object(status)||!Number.isSafeInteger(status.pid)||status.pid<=0||status.modelFingerprint!==identity.fingerprint||
   status.usedForOrders!==false||!Array.isArray(status.states))fail('MODEL_STATUS_INVALID');
  const modeSeen=new Set();
  for(const state of status.states){
   if(!object(state)||!['demo','demo-futures'].includes(state.mode)||modeSeen.has(state.mode)||
    !['predicted','awaiting_next_cycle','stale_source','unavailable'].includes(state.status)||
    state.errors!==undefined&&!Array.isArray(state.errors))fail('MODEL_STATUS_INVALID');
   modeSeen.add(state.mode);
  }
  const at=millis(status.at);if(at>now)fail('MODEL_STATUS_FUTURE');
  result.heartbeat={at:status.at,ageMs:now-at,stale:now-at>SETTINGS.heartbeatStaleMs,pidMatches:status.pid===inventory.leafPid};
  result.source=Object.fromEntries(['demo','demo-futures'].map(mode=>{
   const rows=status.states.filter(s=>s?.mode===mode),state=rows.length===1?rows[0]:null,
    freshness=state?.sourceFreshness,boundary=freshness?.lastSourceBoundary,
    lower=freshness?.sourceAgeLowerMs,upper=freshness?.sourceAgeUpperMs;
   if(boundary!=null&&(!Number.isSafeInteger(boundary)||boundary<0))fail('MODEL_SOURCE_INVALID');
   const hasBounds=lower!=null&&upper!=null;
   if((lower!=null)!==(upper!=null)||hasBounds&&(!Number.isSafeInteger(lower)||!Number.isSafeInteger(upper)||lower>upper)||hasBounds&&boundary==null)fail('MODEL_SOURCE_INVALID');
   const elapsed=now-at,ageLower=hasBounds?lower+elapsed:null,ageUpper=hasBounds?upper+elapsed:null;
   return [mode,{lastSourceBoundary:boundary??null,lastSourceBoundaryAt:boundary==null?null:new Date(boundary).toISOString(),
    ageLowerMs:ageLower,ageUpperMs:ageUpper,ageMs:ageUpper,stale:ageUpper===null||ageUpper>SETTINGS.sourceStaleMs,
    clockBasis:hasBounds?'Producer archived exchange clock bounds at heartbeat plus elapsed local time.':'Producer exchange clock bounds unavailable.',
    producerClockBasis:freshness?.clockBasis??null,
    producerStatus:state?.status??'unavailable',producerReason:state?.reason??null,
    predictionErrors:state?.errors?.length??0,available:!!state&&['predicted','awaiting_next_cycle'].includes(state.status)&&!(state.errors?.length),
    stopped:stops[mode]}];
  }));
 }
 if(inventory.alive){
  const started=Math.min(...inventory.exact.map(p=>p.createdAt));if(started>now)fail('PROCESS_TIME_FUTURE');
  if(!result.heartbeat?.pidMatches||result.heartbeat.stale||millis(status.at)<started)
   return {...result,status:now-started<=SETTINGS.heartbeatStaleMs?'starting':'degraded',reason:'alive_missing_or_stale_model_heartbeat'};
  if(Object.values(result.source??{}).some(s=>!s.stopped&&s.stale))return {...result,status:'degraded',reason:'model_source_stale'};
  if(Object.values(result.source??{}).some(s=>!s.stopped&&!s.available))return {...result,status:'degraded',reason:'model_prediction_unavailable_or_partial'};
  return result;
 }
 const recent=budget.attempts.filter(a=>now-millis(a.at)<SETTINGS.restartWindowMs),last=budget.attempts.at(-1);
 if(recent.length>=SETTINGS.maxRestarts)return {...result,status:'blocked',reason:'restart_budget_exhausted',recentRestarts:recent.length};
 if(last&&now-millis(last.at)<SETTINGS.restartBackoffMs)return {...result,status:'backoff',reason:'restart_backoff',retryAt:new Date(millis(last.at)+SETTINGS.restartBackoffMs).toISOString()};
 return {...result,action:'restart',restart:true,status:'missing',reason:'confirmed_no_worker_process',recentRestarts:recent.length};
}

export async function atomicJson(path,value,{write=writeFile,move=rename,wait=sleep,makeDir=mkdir}={}){
 await makeDir(dirname(path),{recursive:true});
 const temp=path+'.'+randomUUID()+'.tmp';
 await write(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
 for(let attempt=0;;attempt++){
  try{await move(temp,path);return;}catch(error){
   if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
   await wait(25*2**attempt);
  }
 }
}

// Ordering is deliberate: durable budget -> preserved evidence -> recheck -> launch.
// A failed/ambiguous launch still consumes the reservation, including after a
// watchdog restart. Never kill or replace an existing process.
export async function recoveryCycle(io){
 const observed=await io.observe(),decision=decideRecovery(observed);
 if(!decision.restart){await io.publish(decision,observed.now);return decision;}
 const id=sha(randomUUID()),at=new Date(observed.now).toISOString();
 const reserved={...observed.budget,attempts:[...observed.budget.attempts.filter(a=>observed.now-millis(a.at)<SETTINGS.restartWindowMs),{id,at,status:'reserved'}]};
 await io.saveBudget(reserved);
 try{
  const archive=await io.archive(id,observed);
  // Use the pre-reservation budget to evaluate current liveness/STOP/pin again;
  // the newly saved reservation is already charged and must not block itself.
  const fresh=await io.observe(),again=decideRecovery({...fresh,budget:observed.budget});
  if(fresh.identity.fingerprint!==observed.identity.fingerprint||!again.restart){
   reserved.attempts.at(-1).status='cancelled';await io.saveBudget(reserved);
   const result={...again,action:'none',restart:false,status:'recovery_cancelled',archive};
   await io.event({id,at,status:'cancelled',reason:again.reason??'state_changed'});await io.publish(result,fresh.now);return result;
  }
  const receipt=await io.launch();
  if(!object(receipt)||!['started','already_present'].includes(receipt.status)||
   receipt.status==='started'&&(!Number.isSafeInteger(receipt.pid)||receipt.pid<=0)||
   receipt.status==='already_present'&&(!Array.isArray(receipt.pids)||!receipt.pids.length||receipt.pids.some(p=>!Number.isSafeInteger(p)||p<=0)))fail('LAUNCH_RECEIPT_INVALID');
  reserved.attempts.at(-1).status=receipt.status;await io.saveBudget(reserved);
  const result={status:'recovery_requested',action:'none',restart:false,modelFingerprint:observed.identity.fingerprint,
   receipt,archive,reason:'await_fresh_process_identity_and_heartbeat'};
  await io.event({id,at,status:receipt.status,receipt,archive});await io.publish(result,fresh.now);return result;
 }catch(error){
  reserved.attempts.at(-1).status='failed';await io.saveBudget(reserved);
  const result={status:'recovery_failed',action:'none',restart:false,reason:safeError(error)};
  await io.event({id,at,status:'failed',reason:result.reason});await io.publish(result,observed.now);return result;
 }
}

const runFile=promisify(execFile);
async function runPowerShell(script){
 const result=await runFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
  {cwd:ROOT,windowsHide:true,timeout:15000,maxBuffer:2_000_000});
 return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
async function readJson(path,{missing=false}={}){
 try{const info=await stat(path);if(!info.isFile()||info.size>2_000_000)fail('FILE_INVALID');
  return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
 }catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
}
async function present(path){try{await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
const IDENTITY_SCRIPT="import sys,json,hashlib,pathlib; p=pathlib.Path(sys.argv[1]); d=json.loads(p.read_text(encoding='utf-8')); c={k:v for k,v in d.items() if k not in ('fingerprint','loadSeconds','parameters','loadedAt')}; print(json.dumps({'computedFingerprint':hashlib.sha256(json.dumps(c,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()}))";

export function createRuntime({root=ROOT,base=join(root,'local','model-watchdog'),now=()=>Date.now(),exec=runFile,powershell=runPowerShell}={}){
 const model=join(root,'local','model-research'),budgetPath=join(base,'budget.json');let identityCache=null;
 async function identity(){
  const [loaded,execution]=await Promise.all([readJson(join(model,'loaded-model.json')),readJson(join(root,'config','model-execution.json'))]);
  const raw=await readFile(join(model,'loaded-model.json')),key=sha(raw);
  let computedFingerprint;
  if(identityCache?.key===key)computedFingerprint=identityCache.computedFingerprint;
  else{
   const result=await exec(join(root,'.venv-model','Scripts','python.exe'),['-I','-B','-c',IDENTITY_SCRIPT,join(model,'loaded-model.json')],
    {cwd:root,windowsHide:true,timeout:10000,maxBuffer:10000});
   ({computedFingerprint}=JSON.parse(result.stdout));
   if(sha(await readFile(join(model,'loaded-model.json')))!==key)fail('IDENTITY_CHANGED_DURING_READ');
   identityCache={key,computedFingerprint};
  }
  const sourceHashes=Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path=>[path,sha(await readFile(join(root,path)))])));
  return verifyIdentity({loaded,execution,computedFingerprint,sourceHashes});
 }
 async function processes(){
  const script="$ErrorActionPreference='Stop'; $taskRoot="+quotePS(win32.resolve(root))+"; $taskRows=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python(?:w)?\\.exe$' -and ((!$_.CommandLine -and !$_.ExecutablePath) -or ($_.CommandLine -and $_.CommandLine.IndexOf($taskRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskRoot,[StringComparison]::OrdinalIgnoreCase))) } | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath;createdAt=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}} }); ConvertTo-Json -InputObject $taskRows -Depth 4 -Compress";
  return powershell(script);
 }
 async function stops(){return Object.fromEntries(await Promise.all([
  ['watchdog',join(base,'STOP')],['model',join(model,'STOP')],['demo',join(root,'local','demo','STOP')],['demo-futures',join(root,'local','demo-futures','STOP')]
 ].map(async([key,path])=>[key,await present(path)])));}
 async function budget(pin,at,{readOnly=false}={}){
  let value=await readJson(budgetPath,{missing:true});
  if(value===null){
   if(await present(join(base,'events.jsonl'))||await present(join(base,'recoveries'))||await present(join(base,'status.json')))fail('PERSISTED_BUDGET_MISSING');
   value={schemaVersion:1,modelFingerprint:pin,createdAt:new Date(at).toISOString(),attempts:[]};
   if(!readOnly){
    await mkdir(base,{recursive:true});
    try{await writeFile(budgetPath,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});}
    catch(error){if(error.code!=='EEXIST')throw error;value=await readJson(budgetPath);}
   }
  }
  return validateBudget(value,at);
 }
 async function event(value){
  await mkdir(base,{recursive:true});const handle=await open(join(base,'events.jsonl'),'a',0o600);
  try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
 }
 async function observe({readOnly=false}={}){
  const [verified,inventory,stopState,status]=await Promise.all([identity(),processes(),stops(),readJson(join(model,'status.json'),{missing:true})]);
  const at=now(),ledger=await budget(verified.fingerprint,at,{readOnly});
  return {now:at,root,identity:verified,processes:inventory,stops:stopState,status,budget:ledger};
 }
 async function archive(id,observed){
  const directory=join(base,'recoveries',new Date(observed.now).toISOString().replace(/[:.]/g,'-')+'-'+id.slice(0,12));
  await mkdir(directory,{recursive:true});const files=[];
  const names=(await readdir(model)).filter(name=>['worker.out.log','worker.err.log','status.json','review.json','loaded-model.json','report.md','report.tmp'].includes(name)||/^(?:status|review)\.json\.\d+\.tmp$/.test(name));
  for(const name of names){
   const source=join(model,name),info=await stat(source);if(!info.isFile())fail('ARCHIVE_FILE_INVALID');
   await copyFile(source,join(directory,name),constants.COPYFILE_EXCL);
   files.push({name,bytes:info.size,sha256:sha(await readFile(join(directory,name)))});
  }
  await atomicJson(join(directory,'manifest.json'),{id,at:new Date(observed.now).toISOString(),modelFingerprint:observed.identity.fingerprint,
   processes:classifyProcesses(observed.processes,root),files});
  return directory;
 }
 async function launch(){
  const finalStops=await stops();if(finalStops.watchdog||finalStops.model||finalStops.demo&&finalStops['demo-futures'])fail('STOP_BEFORE_LAUNCH');
  const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts','start-model-worker.ps1')],
   {cwd:root,windowsHide:true,timeout:15000,maxBuffer:100000});
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
 }
 async function publish(result,at){
  // An initial transient read failure must not manufacture evidence of a prior
  // ledger. Existing status still makes a later missing ledger fail closed.
  if(!await present(budgetPath)&&!await present(join(base,'status.json')))fail('BUDGET_UNINITIALIZED');
  return atomicJson(join(base,'status.json'),{schemaVersion:1,pid:process.pid,at:new Date(at).toISOString(),
   ...result,orderAuthority:'none',killsProcesses:false,nativeRunningIsModelHealthProof:false,settings:SETTINGS});
 }
 return {observe,saveBudget:value=>atomicJson(budgetPath,value),event,archive,launch,publish};
}

async function withSingleton(fn){
 await mkdir(BASE,{recursive:true});const path=join(BASE,'worker.lock'),token=randomUUID();let handle;
 try{handle=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('SINGLETON_BUSY_OR_STALE');throw error;}
 await handle.writeFile(JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()})+'\n');await handle.sync();
 try{return await fn();}finally{await handle.close();const owner=await readJson(path);if(owner.token===token)await unlink(path);}
}

export async function main(){
 const command=process.argv[2];if(!['check','once','watch'].includes(command))fail('COMMAND_REQUIRED');
 const io=createRuntime();
 if(command==='check'){const observed=await io.observe({readOnly:true});console.log(JSON.stringify(decideRecovery(observed)));return;}
 let ending=false;process.once('SIGINT',()=>{ending=true;});process.once('SIGTERM',()=>{ending=true;});
 await withSingleton(async()=>{
  do{
   try{console.log(JSON.stringify(await recoveryCycle(io)));}
   catch(error){const result={status:'blocked',reason:safeError(error),restart:false};
    try{await io.publish(result,Date.now());}catch(writeError){console.error(JSON.stringify({status:'status_write_failed',reason:safeError(writeError)}));}
    console.error(JSON.stringify(result));
   }
   if(command==='once'||ending||await present(join(BASE,'STOP')))break;
   await sleep(SETTINGS.intervalMs);
  }while(!ending);
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(safeError(error));process.exitCode=1;});
