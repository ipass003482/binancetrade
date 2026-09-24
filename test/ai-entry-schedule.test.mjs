import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiEntryWindow} from '../src/entry-timing.mjs';
import {runCycle} from '../src/workflow.mjs';
import {RULE_ENGINE_VERSION} from '../src/decision.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson} from '../src/io.mjs';
import {fixture,clockFixture,trendCandles,syntheticModelEvidence} from './fixtures.mjs';
const B=Date.parse('2026-09-20T15:00:00Z');
function timing(mode,minute=0,elapsed=20000){
 const now=B+minute*60000+elapsed;
 return {mode,timeframe:'5m',createdAt:new Date(now).toISOString(),completedAt:new Date(now).toISOString(),
  candleBoundary:B,decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:B+minute*60000,
  clock:clockFixture(now,mode)};
}
test('AI only evaluates new forecasts in the exclusive first minute; observation cadence is unchanged',()=>{
 for(const mode of ['demo','demo-futures'])for(let minute=0;minute<5;minute++){
  const s=timing(mode,minute),r=aiEntryWindow(s);
  assert.equal(r.due,minute===0);
  assert.equal(r.entryDeadline,B+60000);
  assert.equal(r.nextEntryBoundary,minute===0?B:B+300000);
  assert.equal(r.reason,minute===0?null:'MODEL_NEXT_CANDLE_WAIT');
 }
 assert.equal(aiEntryWindow(timing('demo',0,59999)).due,true);
 assert.equal(aiEntryWindow(timing('demo',0,60000)).due,false);
 const uncertain=timing('demo',0,59980);
 uncertain.clock.requestStartedAt-=100;uncertain.clock.serverTime-=50;
 assert.equal(aiEntryWindow(uncertain).due,false,'clock uncertainty cannot extend the model deadline');
});
test('AI scheduling rejects malformed cadence and stale or wrong-clock snapshots',()=>{
 const s=timing('demo');
 assert.throws(()=>aiEntryWindow({...s,decisionIntervalMs:300000}),/DECISION_TIMING_INVALID/);
 assert.throws(()=>aiEntryWindow({...s,clock:clockFixture(B+20000,'demo-futures')}),/CLOCK_INVALID/);
 assert.throws(()=>aiEntryWindow(s,B+90000),/CLOCK_STALE/);
 assert.throws(()=>aiEntryWindow({...s,candleBoundary:B-300000}),/DECISION_TIMING_INVALID/);
});
for(const mode of ['demo','demo-futures'])for(const minute of [0,1,2,3,4]){
 test(mode+' minute '+minute+' observes normally and waits for model only when due',async t=>{
  const at=B+minute*60000+20000;t.mock.timers.enable({apis:['Date'],now:at});
  const f=await fixture(),policy=await loadPolicy(mode),local=await mkdtemp(join(tmpdir(),'ai-schedule-'));
  const s={...f.snapshot,...timing(mode,minute)};
  s.markets[0]={...s.markets[0],pair:policy.pairs[0],mode,clock:s.clock,candles:trendCandles(at,'long','5m')};
  let collected=0,reads=0,modelCalls=0,executed=0;
  try{
   const result=await runCycle({local,policy,kevConfigFn:async()=>({enabled:false,marketData:'kronos'}),
    client:{snapshot:async()=>{reads++;return {...f.account,engine:{strategy_version:RULE_ENGINE_VERSION}};}},
    collectFn:async()=>{collected++;return s;},
    costsFn:async()=>({mode,kind:'costs',readOnly:true,source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',observedAt:new Date(at).toISOString(),rates:[]}),
    modelEvidenceFn:async({snapshot})=>{modelCalls++;return syntheticModelEvidence(snapshot);},
    executeFn:async({proposal})=>{executed++;assert.equal(proposal.action,'hold');return {status:'hold'};}});
   assert.equal(collected,1);assert.equal(reads,1);assert.equal(executed,1);
   assert.equal(modelCalls,minute===0?1:0);
   const evidence=await readJson(join(local,'runs',s.id+'.model-decision.json'));
   const analysis=await readJson(join(local,'runs',s.id+'.analysis.json'));
   assert.equal(analysis.modelInvoked,minute===0);assert.equal(analysis.parameters.targetAtr,2);
   if(minute!==0){
    assert.equal(evidence.status,'not_due');assert.equal(evidence.entryAllowed,false);
    assert.equal(evidence.reason,'MODEL_NEXT_CANDLE_WAIT');
    assert.equal(evidence.nextEntryAt,new Date(B+300000).toISOString());
    assert.match(result.proposal.reason,/等待下一根完整五分鐘/);
   }
   assert.equal((await readJson(join(local,'health.json'))).lastError,null);
  }finally{await rm(local,{recursive:true,force:true});}
 });
}
