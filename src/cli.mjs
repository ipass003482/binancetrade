#!/usr/bin/env node
import { join } from 'node:path';
import { writeFile,unlink,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from './paths.mjs';
import { modeArgs,modeLocal } from './mode.mjs';
import { loadPolicy } from './config.mjs';
import { readJson,writeJson,exists,lock,journalRead } from './io.mjs';
import { setup } from './setup.mjs';
import { setupDemo } from './demo-setup.mjs';
import { collect,web3 } from './research.mjs';
import { analyze } from './codex.mjs';
import { FreqtradeClient } from './freqtrade.mjs';
import { execute } from './bridge.mjs';
import { startEngine,PYTHON } from './engine.mjs';
import { runCycle } from './workflow.mjs';
import { reconcile } from './reconcile.mjs';
import { healthStatus,healthUpdate,recoverLock,safeError } from './health.mjs';
import { buildReport } from './report.mjs';
const out=x=>console.log(JSON.stringify(x,null,2));
const parsed=modeArgs(process.argv.slice(2)),mode=parsed.mode,LOCAL=modeLocal(mode);
const [command,...args]=parsed.args;
function count(n){if(args.length!==n)throw new Error('INVALID_ARGUMENTS: run help');}
async function client(){return new FreqtradeClient(await loadPolicy(mode),await readJson(join(LOCAL,'api-auth.json')));}
async function saveResearch(){
 const snapshot=await collect(await loadPolicy(mode)),file=join(LOCAL,'runs',snapshot.id+'.snapshot.json');
 await writeJson(file,snapshot);return {snapshot,file};
}
async function cycle(signal){return runCycle({local:LOCAL,policy:await loadPolicy(mode),client:await client(),signal});}
async function doctor(){
 const report={node:process.version,mode,dockerRequired:false,checks:{}};
 for(const[name,exe,argv]of[['codex',process.platform==='win32'?'codex.exe':'codex',['--version']],['freqtrade',PYTHON,['-m','freqtrade','--version']]]){
  try{report.checks[name]={ok:true,version:execFileSync(exe,argv,{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim()};}
  catch{report.checks[name]={ok:false,message:name==='freqtrade'?'Run bootstrap-native.ps1':'Check native Codex installation/login'};}
 }
 report.checks.setup={ok:await exists(join(LOCAL,'api-auth.json'))};
 if(mode!=='dry-run')report.checks.credentials={ok:await exists(join(LOCAL,'credentials.dpapi.json')),note:'Presence only; no secret read by doctor'};
 try{report.health=await healthStatus(LOCAL,await client(),await loadPolicy(mode));}
 catch(e){report.health={healthy:false,error:safeError(e)};}
 return report;
}
async function watch(){
 return lock(join(LOCAL,'watch.lock'),async()=>{
  const abort=new AbortController(),stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let pending=Promise.resolve();
  const heartbeat=()=>{pending=pending.then(()=>writeJson(join(LOCAL,'watch-heartbeat.json'),{pid:process.pid,at:new Date().toISOString()})).catch(()=>{});};
  heartbeat();const timer=setInterval(heartbeat,15000);
  try{
   while(!abort.signal.aborted){
    if(await exists(join(LOCAL,'STOP'))){out({status:'stopped'});break;}
    try{out(await cycle(abort.signal));}
    catch(e){out({status:'cycle_failed',error:safeError(e)});}
    const end=Date.now()+(await loadPolicy(mode)).intervalSeconds*1000;
    while(Date.now()<end&&!abort.signal.aborted&&!await exists(join(LOCAL,'STOP'))){
     try{await delay(Math.min(1000,end-Date.now()),null,{signal:abort.signal});}catch{break;}
    }
   }
  }finally{
   clearInterval(timer);await pending;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
 });
}
async function main(){
 switch(command){
 case 'setup':count(0);return out(mode!=='dry-run'?await setupDemo(await loadPolicy(mode)):await setup());
 case 'doctor':count(0);return out(await doctor());
 case 'engine':count(0);return startEngine(mode);
 case 'research':count(0);{const r=await saveResearch();return out({mode,file:r.file,coverage:r.snapshot.researchCoverage,errors:r.snapshot.errors});}
 case 'web3':count(3);return out(await web3(args[0],args[1],JSON.parse(args[2])));
 case 'analyze':case 'codex-smoke':count(1);{
  const s=await readJson(args[0]);if(s.mode!==mode)throw new Error('SNAPSHOT_MODE_MISMATCH');
  return out(await analyze(s,await loadPolicy(mode),{trades:[]},{forceHold:command==='codex-smoke'}));
 }
 case 'execute':count(2);return out(await execute({snapshot:await readJson(args[0]),proposal:await readJson(args[1]),
  policy:await loadPolicy(mode),client:await client(),local:LOCAL}));
 case 'cycle':count(0);{
  const abort=new AbortController(),stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return out(await cycle(abort.signal));}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
 case 'watch':count(0);return watch();
 case 'stop':count(0);await mkdir(LOCAL,{recursive:true});await writeFile(join(LOCAL,'STOP'),new Date().toISOString());
  return out({mode,status:'entry_stopped',message:'Existing positions remain managed by engine exits. No liquidation requested.'});
 case 'resume':count(0);{
  await(await client()).snapshot();
  const records=await journalRead(join(LOCAL,'orders.jsonl')),latest=new Map(records.map(r=>[r.id,r]));
  if([...latest.values()].some(r=>['pending','unknown'].includes(r.status)))throw new Error('UNRESOLVED_SUBMISSION');
  if(await exists(join(LOCAL,'STOP')))await unlink(join(LOCAL,'STOP'));
  await healthUpdate(LOCAL,{consecutiveFailures:0,lastError:null,stage:'idle'});
  return out({mode,status:'entry_enabled',message:'Run cycle or watch explicitly.'});
 }
 case 'status':count(0);{
  let engine;try{engine=await(await client()).snapshot();}catch(e){engine={available:false,error:safeError(e)};}
  return out({mode,stopped:await exists(join(LOCAL,'STOP')),engine,journal:(await journalRead(join(LOCAL,'orders.jsonl'))).slice(-10)});
 }
 case 'health':count(0);return out(await healthStatus(LOCAL,await client(),await loadPolicy(mode)));
 case 'recover-lock':count(1);return out(await recoverLock(LOCAL,args[0]));
 case 'reconcile':count(0);return out(await reconcile(LOCAL,await client()));
 case 'report':count(0);return out(await buildReport(LOCAL,await client(),mode));
 case 'demo-check':count(0);{
  if(mode==='dry-run')throw new Error('DEMO_MODE_REQUIRED');
  try{
   const result=execFileSync(PYTHON,[join(ROOT,mode==='demo-futures'?'scripts/demo-futures-engine.py':'scripts/demo-check.py'),...(mode==='demo-futures'?['--check']:[])],{cwd:ROOT,encoding:'utf8',timeout:90000,
    windowsHide:true,stdio:['ignore','pipe','pipe']});
   return out(JSON.parse(result));
  }catch(e){
   try{const value=JSON.parse(e.stdout);if(value.status==='failed'){process.exitCode=1;return out(value);}}catch{}
   throw new Error('DEMO_CHECK_FAILED');
  }
 }
 case 'help':case undefined:return console.log(
  'Binance trade | native Windows | dry-run default; --mode demo for spot; --mode demo-futures for isolated perpetuals (max 3x)\n'+
  'setup / doctor / engine       Prepare, inspect, start selected engine\n'+
  'research / analyze <snapshot> Collect evidence or produce a proposal\n'+
  'codex-smoke <snapshot>        Force HOLD to check native CLI integration\n'+
  'cycle / watch                One guarded cycle or foreground repeat\n'+
  'stop / resume                Pause or enable entries; no liquidation\n'+
  'status / health / report     Account, health, Markdown + JSON report\n'+
  'reconcile                    Resolve only proven submission outcomes\n'+
  'recover-lock <name>          Remove one lock only after proving no owner/child/project process\n'+
  'demo-check --mode demo       Read-only Demo account/market connectivity\n'+
  'execute <snapshot> <proposal> Guarded execution of saved proposal\n'+
  'web3 <skill> <cmd> <json>     Reviewed public query\n'+
  'Demo credentials: powershell.exe -NoProfile -File scripts/configure-demo.ps1');
 default:throw new Error('UNKNOWN_COMMAND');
 }
}
main().catch(e=>{console.error(JSON.stringify({error:safeError(e)}));process.exitCode=1;});
