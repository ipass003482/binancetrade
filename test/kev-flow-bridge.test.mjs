import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKevFlowBridgePlan,KEV_BRIDGE_TEST_NOW} from './kev-flow-bridge-fixture.mjs';
import {runCycle} from '../src/workflow.mjs';
import {loadPolicy} from '../src/config.mjs';
import {reviewKevEntries} from '../src/kev-entry.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {writeJson,readJson} from '../src/io.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KEV_CONFIRMATION_VERSION,KEV_CONFIRMATION_INTERVAL_MS} from '../src/kev-confirmation.mjs';
for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test('Kev flow real bridge selects and binds no-candle '+mode+(short?' short':' long'),async t=>{
  t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
  const f=await buildKevFlowBridgePlan({mode,short}),p=f.plan;
  assert.notEqual(f.boundary%300000,0);
  assert.equal(p.ruleVersion,'kev-order-flow-v1');assert.equal(p.nativeEntryGuard.version,'kev-native-entry-v1');
  assert.equal(p.nativeEntryGuard.kevConfirmation,undefined);
  assert.deepEqual(Object.keys(p.entryConfirmation).sort(),['orderFlow','quotePrice','version']);
  assert.equal(p.entrySignalEngine,'kev_order_flow');assert.equal(p.timeframe,'order-flow');
  assert.equal(p.stopFraction,.005);assert.equal(p.targetFraction,.015);assert.equal(p.maxHoldingSeconds,900);
  for(const object of [p,p.nativeEntryGuard,p.entryConfirmation,f.snapshot])
   for(const key of ['candleBoundary','candles','atr15','atrTimeframe','model','forecastCloses','adaptiveParameters'])
    assert.equal(Object.hasOwn(object,key),false,key);
  assert.equal(p.entryEvidence.kevReview.decision.action,mode==='demo'?'buy':short?'open-short':'open-long');
  assert.equal(p.riskPolicy.reserveFraction,mode==='demo'?'0.005':'0');
  assert.deepEqual(f.records.map(r=>r.status),['pending','submitted']);
 });
}

test('whole Kev cycle at minute02 never calls Kronos and persists the exact selected futures side',async t=>{
 t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
 const f=await buildKevFlowBridgePlan({mode:'demo-futures',short:true}),policy=await loadPolicy(f.mode),
  local=await mkdtemp(join(tmpdir(),'kev-flow-cycle-'));
 t.after(()=>rm(local,{recursive:true,force:true}));
 const account={engine:{strategy_version:'demo-rule-exits-v12'},trades:[],balance:{stake:'USDT',currencies:[{currency:'USDT',free:1000}]},
  daily:{stake_currency:'USDT',data:[{date:new Date(f.now).toISOString().slice(0,10),abs_profit:0}]}};
 await writeJson(join(local,'kev-entry.json'),{version:'kev-codex-entry-v1',mode:f.mode,enabled:true,decisionMode:'autonomous',activatedAt:new Date(f.now).toISOString()});
 let calls=0;
 const pair=f.snapshot.markets[0].pair,boundary=f.snapshot.decisionBoundary-KEV_CONFIRMATION_INTERVAL_MS;
 await writeJson(join(local,'kev-confirmation.json'),{version:KEV_CONFIRMATION_VERSION,mode:f.mode,intervalMs:KEV_CONFIRMATION_INTERVAL_MS,updatedAt:new Date(f.now).toISOString(),signals:{[pair+'|open-short']:{version:KEV_CONFIRMATION_VERSION,mode:f.mode,pair,action:'open-short',snapshotId:'00000000-0000-4000-8000-000000000705',boundary,previousBoundary:boundary-KEV_CONFIRMATION_INTERVAL_MS,intervalMs:KEV_CONFIRMATION_INTERVAL_MS,count:1,confirmed:false,firstBoundary:boundary,updatedAt:new Date(f.now).toISOString()}}});
 const result=await runCycle({local,policy,client:{snapshot:async()=>account},scheduledDecisionBoundary:f.boundary,
  collectFn:async()=>structuredClone(f.snapshot),costsFn:async()=>f.snapshot.costFacts,
  modelEvidenceFn:async()=>{throw Error('KRONOS_MUST_NOT_RUN');},
  kevReviewFn:args=>reviewKevEntries({...args,fetchImpl:async(_url,{body})=>{calls++;return new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:'q0',now:f.now})));}}),
  executeFn:async({proposal})=>{assert.equal(proposal.action,'open-short');return {status:'hold'};}});
 assert.equal(calls,1);assert.equal(result.proposal.action,'open-short');
 const snapshot=await readJson(join(local,'runs',f.snapshot.id+'.snapshot.json'));
 assert.equal(snapshot.entrySignalEngine,'kev_order_flow');assert.equal(snapshot.aiAssist,undefined);
 const evidence=await readJson(join(local,'runs',f.snapshot.id+'.model-decision.json'));
 assert.equal(evidence.usedForEntryDecision,false);
});

for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 for(const quoteMoveBps of [-6,6])test(`real Kev bridge rejects changed approved quote without submission ${mode}/${short}/${quoteMoveBps}`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
  const f=await buildKevFlowBridgePlan({mode,short,quoteMoveBps});
  assert.equal(f.result.reason,'KEV_DECISION_QUOTE_MOVED');assert.equal(f.submitCalls,0);
  assert.equal(f.priceCheck.maxMoveBps,'5');assert.deepEqual(f.records.map(r=>r.status),['rejected']);
 });
}
