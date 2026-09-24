// Controlled reporting-only reset for the active Kev Demo cohort.
// It preserves exchange history, journals, execution session and source code.
// Run --prepare, verify the pause, then run --commit. It never submits orders.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {readJson,writeJson,exists,journalRead} from '../src/io.mjs';
import {loadPolicy} from '../src/config.mjs';
import {FreqtradeClient} from '../src/freqtrade.mjs';
import {buildSprintReview} from './trade-sprint-review.mjs';

const MODES=['demo','demo-futures'];
// Keep each reporting reset auditable.  The default preserves the original
// path; an explicit directory is useful when starting a second cohort on the
// same day without overwriting the first reset's maintenance/commit evidence.
const root=ROOT, resetDirName=process.env.KEV_RESET_DIR??'kev-reset-2026-09-22', dir=join(root,'local',resetDirName),
 resetScope=process.env.KEV_RESET_SCOPE??'combined', resetCount=Number(process.env.KEV_RESET_COUNT??100),
 allowOpenBaseline=process.env.KEV_ALLOW_OPEN_BASELINE==='true';
assert.ok(['combined','each'].includes(resetScope),'RESET_SCOPE_INVALID');
assert.ok(Number.isSafeInteger(resetCount)&&resetCount>0,'RESET_COUNT_INVALID');
const maintenancePath=join(dir,'maintenance.json');
const modeStop=mode=>join(root,'local',mode,'STOP');
const supervisorStop=join(root,'local','supervisor','STOP');
const jsonHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact=t=>({trade_id:t.trade_id,pair:t.pair,is_open:t.is_open,is_short:t.is_short===true,
 open_timestamp:t.open_timestamp,close_timestamp:t.close_timestamp??null,profit_abs:t.profit_abs??null,
 enter_tag:t.enter_tag??null});
const nowIso=()=>new Date().toISOString();

async function waitForDrain(limitMs=90000){
 const end=Date.now()+limitMs;
 while(Date.now()<end){
  const locks=[];
  for(const path of [
   join(root,'local','demo','watch.lock'),join(root,'local','demo','cycle.lock'),join(root,'local','demo','execution.lock'),
   join(root,'local','demo-futures','watch.lock'),join(root,'local','demo-futures','cycle.lock'),join(root,'local','demo-futures','execution.lock')])
   if(await exists(path))locks.push(path);
  if(!locks.length)return;
  await new Promise(resolveDelay=>setTimeout(resolveDelay,1000));
 }
 throw Error('RESET_WRITER_LOCKS_NOT_DRAINED');
}

async function loadFacts(){
 const histories={},journals={},modeFacts={};
 for(const mode of MODES){
  const local=join(root,'local',mode),policy=await loadPolicy(mode);
  const client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
  const history=await client.history(),journal=await journalRead(join(local,'orders.jsonl'));
   const openTrades=history.filter(t=>t.is_open===true);
   if(!allowOpenBaseline)assert.equal(openTrades.length,0,`OPEN_POSITION:${mode}`);
  const latest=new Map();
  for(const row of journal)latest.set(row.id,row);
  assert.equal([...latest.values()].some(row=>['pending','unknown'].includes(row.status)),false,`UNRESOLVED_ORDER:${mode}`);
  const realized=history.reduce((sum,t)=>{
   try{return sum.plus(new Decimal(t.profit_abs??0));}catch{return sum;}
  },new Decimal(0));
  histories[mode]={source:'freqtrade-demo',historyComplete:true,trades:history,observedAt:nowIso()};
  journals[mode]=journal;
  modeFacts[mode]={historyCount:history.length,openCount:openTrades.length,
   excludedTradeIds:history.map(t=>t.trade_id).sort((a,b)=>a-b),
   priorAllHistoryRealizedUsdt:realized.toFixed(),journalRows:journal.length,
   latestJournalStatuses:[...latest.values()].reduce((out,row)=>{out[row.status]=(out[row.status]??0)+1;return out;},{})};
 }
 return {histories,journals,modeFacts};
}

async function prepare(){
 assert.equal(await exists(maintenancePath),false,'RESET_ALREADY_PREPARED');
 const at=nowIso(),marker=`kev reporting reset ${at}`;
 for(const path of [supervisorStop,...MODES.map(modeStop)]){
  assert.equal(await exists(path),false,`STOP_ALREADY_EXISTS:${path}`);
  await writeFile(path,marker,{flag:'wx'});
 }
 try{
  await waitForDrain();
  const active=await readJson(join(root,'local','trade-goals','active.json'));
  const previousGoal=await readJson(resolve(root,active.goalPath));
  const executionSession=await readJson(join(root,'local','demo-session.json'));
  const facts=await loadFacts();
  const reset={schemaVersion:1,at,marker,scope:'reporting-only; no orders, history or execution-session writes',
   previousActive:active,previousGoal,executionSession,modeFacts:facts.modeFacts,
   oldHistory: Object.fromEntries(MODES.map(mode=>[mode,facts.histories[mode].trades.map(compact)])),
   rawLogsPreserved:true,entriesPaused:true};
  await writeJson(join(dir,'maintenance.json'),reset);
  const openTrades=Object.values(facts.modeFacts).reduce((n,f)=>n+f.openCount,0);
  await writeJson(join(dir,'pause-check.json'),{at:nowIso(),locksDrained:true,openTrades,
   modes:facts.modeFacts,ordersSubmittedByReset:0});
  console.log(JSON.stringify({prepared:true,at,marker,openTrades,modes:facts.modeFacts},null,2));
 }catch(error){
  // Keep the owned markers when preparation fails, so no writer can race a
  // partially checked reset. The caller can inspect the error and remove them
  // only after verifying the running engines.
  throw error;
 }
}

async function commit(){
 const maintenance=await readJson(maintenancePath);
 assert.equal(maintenance.entriesPaused,true);
 assert.equal(await readFile(supervisorStop,'utf8'),maintenance.marker);
 for(const mode of MODES)assert.equal(await readFile(modeStop(mode),'utf8'),maintenance.marker);
 await waitForDrain();
 const kevConfig=await readJson(join(root,'config','kev-entry.json'));
 const kevResponse=await fetch(new URL('/healthz',kevConfig.baseUrl),{signal:AbortSignal.timeout(5000)});
 assert.equal(kevResponse.ok,true,'KEV_HEALTH_UNAVAILABLE');
 const kevRuntime=await kevResponse.json();
 assert.equal(kevRuntime.status,'ready','KEV_RUNTIME_NOT_READY');
 assert.equal(kevRuntime.backend,'codex-cli','KEV_BACKEND_MISMATCH');
 assert.equal(kevRuntime.actual_model,kevConfig.expectedModel,'KEV_MODEL_MISMATCH');
 assert.equal(kevRuntime.reasoning_effort,'max','KEV_EFFORT_NOT_MAX');
 assert.equal(kevRuntime.authenticated,true,'KEV_NOT_AUTHENTICATED');
 assert.equal(kevRuntime.busy,false,'KEV_RUNTIME_BUSY');
 const at=nowIso(),facts=await loadFacts(),observedAt=nowIso(),sessionId=randomUUID();
 for(const mode of MODES)facts.histories[mode].observedAt=observedAt;
 const stamp=at.replace(/[-:TZ.]/g,'').slice(0,14),goalId=`kev-demo-100-reset-${stamp}`;
 const goalPath=`local/trade-goals/${goalId}/goal.json`,deadline=new Date(Date.parse(at)+86400000).toISOString();
 const goal={schemaVersion:2,id:goalId,source:'freqtrade-demo',sessionId,startedAt:at,deadline,
  timezone:'Asia/Taipei',ruleVersion:'kev-order-flow-v1',entryPolicyVersion:'kev-order-flow-v1',modelFingerprint:null,
  target:{scope:resetScope,count:resetCount},
  modes:Object.fromEntries(MODES.map(mode=>[mode,{excludedTradeIds:facts.modeFacts[mode].excludedTradeIds,
   baselineTradeCount:facts.modeFacts[mode].excludedTradeIds.length}])),
  reset:{type:'reporting-scope-reset',requestedAt:at,archive:`local/trade-goals/${goalId}/pre-reset.json`,
   previousGoalId:maintenance.previousActive.goalId,oldRecordsDeleted:false,newEntriesOnly:true,
   countDefinition:'Actual Kev-approved strategy entry fills after startedAt; one mode/trade_id counts once.',
   openBaselineAllowed:allowOpenBaseline,openBaselineExcluded:Object.fromEntries(MODES.map(mode=>[mode,facts.modeFacts[mode].openCount])),
   executionSessionId:maintenance.executionSession.id,executionSessionPreserved:true,
   deadlinePolicy:'New 24-hour observation window; previous goal, history and execution session are unchanged.'},
  kevEntry:{required:true,version:'kev-codex-entry-v1',provider:'codex-cli',model:kevRuntime.actual_model,
   reasoningEffort:kevRuntime.reasoning_effort,
   activatedAt:at,countDefinition:'A real Kev-approved strategy entry fill after startedAt; one mode/trade_id counts once.'}};
 const goalDir=join(root,'local','trade-goals',goalId);
 await writeJson(join(goalDir,'pre-reset.json'),{createdAt:at,previousActive:maintenance.previousActive,
  previousGoal:maintenance.previousGoal,executionSession:maintenance.executionSession,modeFacts:facts.modeFacts,
  history:Object.fromEntries(MODES.map(mode=>[mode,facts.histories[mode].trades.map(compact)])),
  preservation:'Raw exchange/journal/evidence files remain at their original paths; this is a reporting-scope archive.'});
 await writeJson(join(goalDir,'goal.json'),goal);
 await writeJson(join(goalDir,'session.json'),{schemaVersion:1,id:sessionId,startedAt:at,modes:MODES});
 await writeJson(join(root,'local','trade-goals','active.json'),{sessionId,goalId,goalPath});
 const initial=buildSprintReview({goal,histories:facts.histories,journals:facts.journals,observedAt,amendment:null});
 await writeJson(join(goalDir,'initial-review.json'),initial);
 const remaining=resetScope==='each'?Object.fromEntries(MODES.map(mode=>[mode,resetCount-(initial.modes[mode].entries??0)])):resetCount-(initial.totalEntries??0);
 const verification={schemaVersion:1,complete:true,verifiedAt:nowIso(),timeZone:'Asia/Taipei',goalId,goalPath,
  startedAt:at,deadline,target:{scope:resetScope,count:resetCount},initialCount:initial.totalEntries,currentCount:initial.totalEntries,
  remaining,currentByMode:Object.fromEntries(MODES.map(mode=>[mode,initial.modes[mode].entries])),
  realizedUsdt:'0',floatingUsdt:'0',positionsPreserved:true,historyPreserved:true,executionSessionPreserved:true,
  ordersSubmittedByReset:0,previousGoalId:maintenance.previousActive.goalId,previousGoalPreserved:true,servicesRestarted:false};
 await writeJson(join(goalDir,'reset-verification.json'),verification);
 for(const path of [supervisorStop,...MODES.map(modeStop)]){
  assert.equal(await readFile(path,'utf8'),maintenance.marker);
 }
 for(const path of [supervisorStop,...MODES.map(modeStop)])await import('node:fs/promises').then(fs=>fs.unlink(path));
 await writeJson(join(dir,'commit.json'),{committedAt:nowIso(),goal,verification,active:{sessionId,goalId,goalPath},
  historyPreserved:true,executionSessionPreserved:true,ordersSubmittedByReset:0});
  console.log(JSON.stringify({reset:true,goal:{id:goalId,path:goalPath,target:goal.target,startedAt:at,deadline},
  initialCount:initial.totalEntries,historyPreserved:true,executionSessionPreserved:true,servicesRestarted:false},null,2));
}

async function repairInitialReview(){
 const active=await readJson(join(root,'local','trade-goals','active.json'));
 const goal=await readJson(resolve(root,active.goalPath));
 const marker=`kev reporting reset repair ${nowIso()}`;
 for(const path of [supervisorStop,...MODES.map(modeStop)]){
  assert.equal(await exists(path),false,`STOP_ALREADY_EXISTS:${path}`);
  await writeFile(path,marker,{flag:'wx'});
 }
 try{
  await waitForDrain();
  const facts=await loadFacts(),observedAt=nowIso();
  for(const mode of MODES)facts.histories[mode].observedAt=observedAt;
  const initial=buildSprintReview({goal,histories:facts.histories,journals:facts.journals,observedAt,amendment:null});
  assert.equal(initial.evidenceComplete,true,'REPAIRED_INITIAL_EVIDENCE_INCOMPLETE');
  const goalDir=dirname(resolve(root,active.goalPath));
  await writeJson(join(goalDir,'initial-review.json'),initial);
  const previous=await readJson(join(goalDir,'reset-verification.json'));
  const verification={...previous,verifiedAt:nowIso(),initialCount:initial.totalEntries,
   currentCount:initial.totalEntries,remaining:100-(initial.totalEntries??0),
   currentByMode:Object.fromEntries(MODES.map(mode=>[mode,initial.modes[mode].entries])),
   realizedUsdt:'0',floatingUsdt:'0',historyPreserved:true,executionSessionPreserved:true,
   ordersSubmittedByReset:0,servicesRestarted:false};
  await writeJson(join(goalDir,'reset-verification.json'),verification);
  await writeJson(join(dir,'repair.json'),{repairedAt:nowIso(),goalId:goal.id,initial,verification,
   reason:'The first wrapper timestamp was captured a few milliseconds before goal start; current read is re-attested after start.'});
  console.log(JSON.stringify({repaired:true,goalId:goal.id,observedAt,initialCount:initial.totalEntries,
   evidenceComplete:initial.evidenceComplete,currentByMode:verification.currentByMode},null,2));
 }finally{
  for(const path of [supervisorStop,...MODES.map(modeStop)]){
   if(await exists(path)&&await readFile(path,'utf8')===marker)
    await import('node:fs/promises').then(fs=>fs.unlink(path));
  }
 }
}

const phase=process.argv[2];
if(phase==='--prepare')await prepare();
else if(phase==='--commit')await commit();
else if(phase==='--repair')await repairInitialReview();
else throw Error('USAGE: reset-kev-reporting.mjs --prepare|--commit|--repair');
