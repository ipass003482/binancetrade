// Public reporting boundary only. No broker, reset, order or configuration writes.
import {join,resolve,relative} from 'node:path';
import {ROOT} from './paths.mjs';
import {readJson} from './io.mjs';

export const DEMO_SESSION_FILE=join(ROOT,'local','demo-session.json');
export const ACTIVE_DEMO_GOAL_FILE=join(ROOT,'local','trade-goals','active.json');
const modes=['demo','demo-futures'];
const invalid=()=>Error('DEMO_SESSION_INVALID');
export function validateDemoSession(value,{now=Date.now()}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='id,modes,schemaVersion,startedAt'||value.schemaVersion!==1||
  typeof value.id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)||
  typeof value.startedAt!=='string'||!Number.isFinite(Date.parse(value.startedAt))||
  new Date(value.startedAt).toISOString()!==value.startedAt||Date.parse(value.startedAt)<=0||
  !Number.isFinite(now)||Date.parse(value.startedAt)>now||
  !Array.isArray(value.modes)||value.modes.length!==2||value.modes.some((mode,i)=>mode!==modes[i]))throw invalid();
 return {schemaVersion:1,id:value.id,startedAt:value.startedAt,modes:[...modes]};
}
export async function readDemoSession({file=DEMO_SESSION_FILE,now=Date.now()}={}){
 let value;try{value=await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw invalid();}
 return validateDemoSession(value,{now});
}

// The execution session above remains the runtime authority. The dashboard can
// start a fresh reporting scope without rewriting that authority (or deleting
// its audit trail) by pointing active.json at a new goal. This scope is still
// validated with the same session contract before it is used for PnL.
export async function readActiveDemoScope({file=ACTIVE_DEMO_GOAL_FILE,now=Date.now()}={}){
 let active;
 try{active=await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw invalid();}
 if(!active||typeof active!=='object'||Array.isArray(active)||
  typeof active.goalPath!=='string'||typeof active.goalId!=='string'||typeof active.sessionId!=='string')throw Error('ACTIVE_GOAL_INVALID');
 const clean=active.goalPath.replaceAll('\\','/');
 if(clean.startsWith('/')||clean.split('/').includes('..')||!clean.startsWith('local/trade-goals/'))throw Error('ACTIVE_GOAL_INVALID');
 const goalFile=resolve(ROOT,clean),inside=relative(ROOT,goalFile);
 if(!inside||inside.startsWith('..')||inside.includes(':'))throw Error('ACTIVE_GOAL_INVALID');
 let goal;try{goal=await readJson(goalFile);}catch{throw Error('ACTIVE_GOAL_INVALID');}
 if(!goal||typeof goal!=='object'||Array.isArray(goal)||goal.id!==active.goalId||goal.sessionId!==active.sessionId||
  typeof goal.startedAt!=='string'||!Number.isFinite(Date.parse(goal.startedAt))||
  typeof goal.target?.count!=='number'||!Number.isSafeInteger(goal.target.count)||goal.target.count<1||
  !['combined','each'].includes(goal.target.scope))throw Error('ACTIVE_GOAL_INVALID');
 const session=validateDemoSession({schemaVersion:1,id:goal.sessionId,startedAt:new Date(goal.startedAt).toISOString(),modes},{now});
 return {session,goal,goalPath:clean};
}
export function sessionTrades(trades,session){
 if(!session)return trades;
 if(!Array.isArray(trades))throw Error('HISTORY_UNAVAILABLE');
 const start=Date.parse(session.startedAt);
 // Missing chronology is unknown evidence, never a reason to drop a loss.
 if(trades.some(t=>!Number.isSafeInteger(t?.open_timestamp)||t.open_timestamp<=0))throw Error('SESSION_TRADE_TIME_INVALID');
 if(trades.some(t=>typeof t.is_open!=='boolean'))throw Error('SESSION_TRADE_STATUS_INVALID');
 return trades.filter(t=>t.open_timestamp>=start);
}
export function sessionJournal(journal,session){
 if(!session)return journal;
 if(!Array.isArray(journal)||journal.some(r=>!r||!Number.isFinite(Date.parse(r.at))))throw Error('SESSION_JOURNAL_TIME_INVALID');
 const start=Date.parse(session.startedAt),oldIds=new Set(journal.filter(r=>r.status==='pending'&&Date.parse(r.at)<start).map(r=>r.id));
 // A later settlement cannot pull an intent from the previous run into this run.
 return journal.filter(r=>!oldIds.has(r.id)&&Date.parse(r.at)>=start);
}
export function sessionOpenCount(trades,session){
 if(!session)return 0;
 const scoped=new Set(sessionTrades(trades,session));
 return trades.filter(t=>t.is_open===true&&!scoped.has(t)).length;
}
