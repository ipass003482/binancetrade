// Start-only supervisor: never kill an uncertain process, clear STOP, or send orders.
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync,closeSync } from 'node:fs';
import { appendFile,mkdir,readFile,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from './paths.mjs';
import { modeLocal } from './mode.mjs';
import { loadPolicy } from './config.mjs';
import { FreqtradeClient } from './freqtrade.mjs';
import { exists,readJson,writeJson,lock,journalRead } from './io.mjs';
import { pidState,safeError } from './health.mjs';
import { createPausedEvidenceSampler } from './paused-evidence.mjs';
import {cycleTimingLimits} from './candle-schedule.mjs';
const runFile=promisify(execFile),MODES=['demo','demo-futures'];
export const SUPERVISOR_LOCAL=join(ROOT,'local','supervisor');
export function supervisorDecision(s){
 if(!s.continuous)return {action:'observe',reason:'CONTINUOUS_NOT_REQUESTED'};
 if(s.inventoryUnknown)return {action:'alert',reason:'PROCESS_INVENTORY_UNAVAILABLE'};
 if(!s.engineAvailable){
  if(s.engineOwnerAlive||s.engineProcesses||s.portOpen)return {action:'alert',reason:'ENGINE_UNAVAILABLE_PROCESS_PRESENT'};
  if(s.unavailableCount<3)return {action:'observe',reason:'ENGINE_RECONNECTING'};
  return {action:'start_engine',reason:'ENGINE_CONFIRMED_ABSENT'};
 }
 if(s.stopped)return {action:'observe',reason:'ENTRY_STOPPED'};
 if(s.unresolved)return {action:'alert',reason:'UNRESOLVED_SUBMISSION'};
 if(!s.watchOwnerAlive){
  if(s.watchProcesses)return {action:'alert',reason:'WATCH_PROCESS_PRESENT_WITHOUT_LOCK'};
  return {action:'start_watch',reason:'WATCH_CONFIRMED_ABSENT'};
 }
 if(!s.heartbeatFresh)return {action:'alert',reason:'WATCH_HEARTBEAT_STALE'};
 if(!s.cycleFresh)return {action:'alert',reason:'CYCLE_STALE'};
 return {action:'observe',reason:'RUNNING'};
}
export async function recoverAbsentWorkerLock(local,role,{state=pidState,processes=[]}={}){
 if(!['engine','watch','cycle','execution','health','events','forward','equity','entry'].includes(role))throw Error('SUPERVISOR_LOCK_ROLE_REJECTED');
 return lock(join(local,'supervisor-recovery.lock'),async()=>{
  const file=join(local,role+'.lock');if(!await exists(file))return;
  const before=await readFile(file,'utf8'),owner=JSON.parse(before);
  if(state(owner.pid)!=='dead'||(owner.childPid&&state(owner.childPid)!=='dead')||processes.length)throw Error('SUPERVISOR_OWNER_NOT_PROVEN_ABSENT');
  if(await readFile(file,'utf8')!==before)throw Error('SUPERVISOR_LOCK_CHANGED');
  await unlink(file);
 });
}
async function portOpen(port){return new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});let done=false;const end=v=>{if(done)return;done=true;socket.destroy();resolve(v);};socket.setTimeout(1000,()=>end(true));socket.once('connect',()=>end(true));socket.once('error',e=>end(e.code!=='ECONNREFUSED'));});}
async function processList(){const {stdout}=await runFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(ROOT,'scripts/supervisor-inventory.ps1'),'-ExcludePid',String(process.pid)],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!Array.isArray(rows))throw Error('PROCESS_INVENTORY_INVALID');return rows;}
async function lockState(local,role){try{return await readJson(join(local,role+'.lock'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function alive(owner){return owner&&[owner.pid,owner.childPid].filter(Boolean).some(id=>pidState(id)!=='dead');}
async function startWorker(mode,role){
 const local=modeLocal(mode),stdout=openSync(join(local,'supervised-'+role+'.out.log'),'a',0o600),stderr=openSync(join(local,'supervised-'+role+'.err.log'),'a',0o600);
 // Windows otherwise places children in the supervisor's kill-on-close job.
 // Detached workers must survive a supervisor restart, especially open exits.
 try{const child=spawn(process.execPath,[join(ROOT,'src/cli.mjs'),role,'--mode',mode],{cwd:ROOT,windowsHide:true,detached:true,shell:false,stdio:['ignore',stdout,stderr]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('SUPERVISOR_START_FAILED')));});child.unref();return child.pid;}
 finally{closeSync(stdout);closeSync(stderr);}
}
export async function runSupervisor({signal,allowDemoSupervision=false}={}){
 if(!allowDemoSupervision)throw Error('SUPERVISOR_EXPLICIT_AUTHORIZATION_REQUIRED');
 await mkdir(SUPERVISOR_LOCAL,{recursive:true});
 return lock(join(SUPERVISOR_LOCAL,'supervisor.lock'),async()=>{
  const counters={},lastAlerts={},attemptFile=join(SUPERVISOR_LOCAL,'attempts.json'),samplePaused=createPausedEvidenceSampler();
  const attempts=await exists(attemptFile)?await readJson(attemptFile):{};
  const alert=async(mode,code)=>{if(lastAlerts[mode]===code)return;lastAlerts[mode]=code;await appendFile(join(SUPERVISOR_LOCAL,'alerts.jsonl'),JSON.stringify({at:new Date().toISOString(),mode,code})+'\n');};
  while(!signal?.aborted&&!await exists(join(SUPERVISOR_LOCAL,'STOP'))){
   let inventory=[],inventoryUnknown=false;try{inventory=await processList();inventoryUnknown=inventory.some(p=>p.inventoryUnknown===true);}catch{inventoryUnknown=true;}
   const states=[];
   for(const mode of MODES){
    try{
     const local=modeLocal(mode),policy=await loadPolicy(mode),continuousState=await exists(join(local,'continuous.json'))?await readJson(join(local,'continuous.json')):{},continuous=continuousState.enabled===true;
     if(!continuous){states.push({mode,action:'observe',reason:'CONTINUOUS_NOT_REQUESTED'});continue;}
     const client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
     let engineAvailable=false;try{await client.snapshot();engineAvailable=true;}catch{}
     counters[mode]=engineAvailable?0:(counters[mode]??0)+1;
     const engineOwner=await lockState(local,'engine'),watchOwner=await lockState(local,'watch'),now=Date.now();
     const beat=await exists(join(local,'watch-heartbeat.json'))?await readJson(join(local,'watch-heartbeat.json')):null;
     const health=await exists(join(local,'health.json'))?await readJson(join(local,'health.json')):{};
     const records=await journalRead(join(local,'orders.jsonl')),latest=[...new Map(records.map(r=>[r.id,r])).values()];
     const processes=inventory.filter(p=>p.mode===mode),start=Date.parse(watchOwner?.at),last=Date.parse(health.lastSuccessAt);
     const timingLimits=cycleTimingLimits(mode,{health,continuous:continuousState,timeframe:policy.timeframe});
     const snapshot={continuous,inventoryUnknown,engineAvailable,engineOwnerAlive:alive(engineOwner),engineProcesses:processes.some(p=>p.role==='engine'),portOpen:engineAvailable?true:await portOpen(Number(new URL(policy.freqtrade.url).port)),unavailableCount:counters[mode],stopped:await exists(join(local,'STOP')),unresolved:latest.some(r=>['pending','unknown'].includes(r.status)),watchOwnerAlive:alive(watchOwner),watchProcesses:processes.some(p=>p.role==='watch'),heartbeatFresh:beat?.pid===watchOwner?.pid&&now-Date.parse(beat.at)>=0&&now-Date.parse(beat.at)<45000,cycleFresh:Number.isFinite(last)&&now-last>=0&&now-last<=timingLimits.cycleMaxAgeMs||Number.isFinite(start)&&now-start>=0&&now-start<=timingLimits.startupGraceMs};
     let decision=supervisorDecision(snapshot);
     if(decision.action.startsWith('start_')){
      const role=decision.action.slice(6),key=mode+':'+role,previous=(attempts[key]??[]).filter(t=>now-t<600000);
      if(previous.length>=3){decision={action:'alert',reason:'RESTART_BACKOFF_LIMIT'};}
      else{
       if(role==='watch'){
        for(const related of ['cycle','execution','health','events','forward','equity']){
         const owner=await lockState(local,related);
         if(owner&&pidState(owner.pid)==='dead')await recoverAbsentWorkerLock(local,related,{processes:processes.filter(p=>p.role==='watch')});
        }
        const portfolioLocal=join(ROOT,'local','portfolio'),portfolioOwner=await lockState(portfolioLocal,'entry');
        if(portfolioOwner&&pidState(portfolioOwner.pid)==='dead'){
         for(const checkedMode of MODES){
          const journal=await journalRead(join(modeLocal(checkedMode),'orders.jsonl'));
          if([...new Map(journal.map(r=>[r.id,r])).values()].some(r=>['pending','unknown'].includes(r.status)))throw Error('UNRESOLVED_SUBMISSION');
         }
         await recoverAbsentWorkerLock(portfolioLocal,'entry');
        }
       }
       await recoverAbsentWorkerLock(local,role,{processes:processes.filter(p=>p.role===role)});
       // Every restart keeps user STOP and submission journals unchanged.
       attempts[key]=[...previous,now];await writeJson(attemptFile,attempts);
       const pid=await startWorker(mode,role);decision={...decision,pid};await alert(mode,'RECOVERED_'+role.toUpperCase());
      }
     }
     if(decision.action==='alert')await alert(mode,decision.reason);else if(decision.reason==='RUNNING')lastAlerts[mode]=null;
     const evidenceSampling=await samplePaused({mode,local,client,continuous,stopped:snapshot.stopped,engineAvailable});
     if(evidenceSampling&&(evidenceSampling.forward?.status==='unavailable'||evidenceSampling.portfolio?.status==='unavailable'))
      await alert(mode,'PAUSED_EVIDENCE_UNAVAILABLE');
     states.push({mode,...decision,engineAvailable,watchRunning:snapshot.watchOwnerAlive,cycleFresh:snapshot.cycleFresh,stopped:snapshot.stopped,
      ...(evidenceSampling?{evidenceSampling}:{})});
    }catch(e){const code=safeError(e);await alert(mode,code);states.push({mode,action:'alert',reason:code});}
   }
   await writeJson(join(SUPERVISOR_LOCAL,'status.json'),{pid:process.pid,observedAt:new Date().toISOString(),states});
   try{await delay(15000,null,{signal});}catch{break;}
  }
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
 if(process.argv.slice(2).join(' ')!=='--allow-demo-supervision')throw Error('SUPERVISOR_EXPLICIT_AUTHORIZATION_REQUIRED');
 runSupervisor({signal:controller.signal,allowDemoSupervision:true}).catch(e=>{console.error(safeError(e));process.exitCode=1;});
}
