import { join } from 'node:path';
import { readFile,unlink,stat,appendFile,rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './paths.mjs';
import { exists,readJson,writeJson,lock,journalRead } from './io.mjs';
import { tradingTimeframe } from './timeframe.mjs';
import { cycleTimingLimits } from './candle-schedule.mjs';
import { dailyEntryAllowance } from './entry-wait.mjs';
const exec=promisify(execFile);
export function safeError(error){
 if(error?.name==='ZodError')return 'SCHEMA_INVALID';
 const value=String(error?.code??error?.message??'UNKNOWN_ERROR');
 return /^[A-Z][A-Z0-9_]{2,80}/.exec(value)?.[0]??'OPERATION_FAILED';
}
// Background samplers and the cycle share this process. Serialize only their
// health/event writes; the filesystem lock still rejects an external owner.
const statusWrites=new Map();
function statusLock(file,fn){
 const prior=statusWrites.get(file)??Promise.resolve();
 const result=prior.then(()=>lock(file,fn));
 const settled=result.then(()=>{},()=>{});
 statusWrites.set(file,settled);
 void settled.then(()=>{if(statusWrites.get(file)===settled)statusWrites.delete(file);});
 return result;
}
export async function event(local,value){
 const file=join(local,'events.jsonl');
 await statusLock(join(local,'events.lock'),async()=>{
  if(await exists(file)&&(await stat(file)).size>2_000_000){
   const old=file+'.1';if(await exists(old))await unlink(old);await rename(file,old);
  }
  await appendFile(file,JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600});
 });
}
export async function healthUpdate(local,update){
 return statusLock(join(local,'health.lock'),async()=>{
  const file=join(local,'health.json'),old=await exists(file)?await readJson(file):{};
  const value={...old,...update,updatedAt:new Date().toISOString()};
  await writeJson(file,value);return value;
 });
}
export async function recordFailure(local,error){
 const old=await exists(join(local,'health.json'))?await readJson(join(local,'health.json')):{};
 const failures=(old.consecutiveFailures??0)+1,code=safeError(error);
 const h=await healthUpdate(local,{stage:'failed',consecutiveFailures:failures,lastError:code,lastFailureAt:new Date().toISOString()});
 await event(local,{type:'cycle_failed',code,consecutiveFailures:failures});
 if(failures>=3){
  await writeJson(join(local,'STOP'),{reason:'THREE_CONSECUTIVE_FAILURES',at:new Date().toISOString()});
  await event(local,{type:'entries_paused',code:'THREE_CONSECUTIVE_FAILURES'});
 }
 return h;
}
export function pidState(pid){
 if(!Number.isInteger(pid)||pid<1)return 'unknown';
 try{process.kill(pid,0);return 'alive';}catch(e){return e.code==='ESRCH'?'dead':'unknown';}
}
export async function inventory(){
 const {stdout}=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(ROOT,'scripts/process-inventory.ps1'),'-ExcludePid',String(process.pid)],
  {windowsHide:true,timeout:20000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout.replace(/^\uFEFF/,''));
 if(!Array.isArray(result))throw new Error('PROCESS_INVENTORY_INVALID');
 return result;
}
export const LOCK_NAMES=['engine','watch','cycle','execution','health','events','forward','equity'];
export async function inspectLocks(local,{state=pidState}={}){
 const result=[];
 for(const name of LOCK_NAMES){
  const file=join(local,name+'.lock');
  if(!await exists(file))continue;
  try{
   const value=await readJson(file);
   result.push({name,...value,owner:state(value.pid),child:value.childPid?state(value.childPid):'none'});
  }catch(error){if(error.code!=='ENOENT')result.push({name,owner:'unknown',child:'unknown'});}
 }
 return result;
}
export async function recoverLock(local,name,{state=pidState,processes=inventory}={}){
 if(!LOCK_NAMES.includes(name))throw new Error('INVALID_LOCK_NAME');
 return lock(join(local,'recovery.lock'),async()=>{
  const file=join(local,name+'.lock'),before=await readFile(file,'utf8'),owner=JSON.parse(before.replace(/^\uFEFF/,''));
  if(state(owner.pid)!=='dead'||(owner.childPid&&state(owner.childPid)!=='dead'))throw new Error('LOCK_OWNER_NOT_PROVEN_DEAD');
  if((await processes()).length)throw new Error('PROJECT_PROCESSES_STILL_RUNNING');
  if(await readFile(file,'utf8')!==before)throw new Error('LOCK_CHANGED');
  await unlink(file);
  return {status:'lock_recovered',name,message:'Orders unchanged; run reconcile before resume.'};
 });
}
export async function healthStatus(local,client,policy,{now=Date.now(),state=pidState}={}){
 if(!Number.isFinite(now))throw Error('INVALID_HEALTH_TIME');
 const stored=await exists(join(local,'health.json'))?await readJson(join(local,'health.json')):{};
 let engine;
 try{const s=await client.snapshot();engine={available:true,mode:policy.mode,openTrades:s.trades.length};}
 catch(e){engine={available:false,error:safeError(e)};}
 const heartbeat=await exists(join(local,'watch-heartbeat.json'))?await readJson(join(local,'watch-heartbeat.json')):null;
 const age=heartbeat?.at?now-Date.parse(heartbeat.at):null;
 const locks=await inspectLocks(local,{state}),watch=locks.find(l=>l.name==='watch');
 const stopped=await exists(join(local,'STOP'));
 const continuous=await exists(join(local,'continuous.json'))?await readJson(join(local,'continuous.json')):null;
 const continuousRequested=continuous?.enabled===true;
 const startedAge=now-Date.parse(continuous?.updatedAt);
 const heartbeatFresh=age!==null&&Number.isFinite(age)&&age>=0&&age<=45000&&heartbeat?.pid===watch?.pid;
 const watchRunning=!!watch&&watch.owner==='alive'&&heartbeatFresh;
 const {cycleMaxAgeMs,startupGraceMs}=cycleTimingLimits(policy.mode,{health:stored,continuous:continuous??{},timeframe:policy.timeframe??tradingTimeframe(policy.mode)});
 const completedAt=stored.lastCycleCompletedAt??stored.lastSuccessAt??null;
 const cycleAge=completedAt===null?null:now-Date.parse(completedAt);
 const freshCycle=cycleAge!==null&&Number.isFinite(cycleAge)&&cycleAge>=0&&cycleAge<=cycleMaxAgeMs;
 const inStartupWindow=continuousRequested&&Number.isFinite(startedAge)&&startedAge>=0;
 const watchStartupGrace=inStartupWindow&&startedAge<=45000;
 // Startup may wait for the next decision slot and complete its first cycle.
 // The marker is written once on watch startup, never by its heartbeat.
 const cycleStartupGrace=inStartupWindow&&startedAge<=startupGraceMs;
 const problems=[];
 if(!engine.available)problems.push('ENGINE_UNAVAILABLE');
 if(locks.some(l=>l.owner!=='alive'||l.child==='dead'))problems.push('STALE_OR_UNVERIFIED_LOCK');
 if(stored.lastError||stored.stage==='failed')problems.push(stored.lastError??'CYCLE_FAILED');
 if(watch&&!heartbeatFresh&&!watchStartupGrace)problems.push('WATCH_HEARTBEAT_STALE');
 if(continuousRequested&&!stopped){
  if(!watchRunning&&!watchStartupGrace)problems.push('CONTINUOUS_WATCH_NOT_RUNNING');
  if(!freshCycle&&!cycleStartupGrace)problems.push('CYCLE_STALE');
 }
 let allowance=null;
 try{allowance=dailyEntryAllowance(await journalRead(join(local,'orders.jsonl')),policy,now);}
 catch(error){problems.push(safeError(error));}
 const entryState=stopped?'paused':!engine.available?'engine_unavailable':problems.length?'fault':
  stored.entryWait?'waiting_risk':continuousRequested&&(!watchRunning&&watchStartupGrace||!freshCycle&&cycleStartupGrace)?'starting':
  stored.lastDecisionStatus==='hold'||stored.lastDecisionStatus==='filtered'?'waiting_signal':
  watchRunning?'running':'manual';
 return {mode:policy.mode,observedAt:new Date(now).toISOString(),healthy:problems.length===0,stopped,
  problems:[...new Set(problems)],engine,engineAvailable:engine.available,watchRunning,freshCycle,
  entryState,entryWait:stored.entryWait??null,dailyEntryAllowance:allowance,
  continuous:{requested:continuousRequested,updatedAt:continuous?.updatedAt??null,
   watchStartupGrace,cycleStartupGrace},
  freshness:{heartbeatAgeMs:Number.isFinite(age)?age:null,cycleAgeMs:Number.isFinite(cycleAge)?cycleAge:null,
   cycleMaxAgeMs,lastCycleCompletedAt:completedAt},cycle:stored,locks};
}
