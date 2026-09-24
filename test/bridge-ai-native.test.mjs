import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAiBridgePlan,AI_BRIDGE_TEST_NOW} from './bridge-ai-plan-fixture.mjs';

for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test('real AI bridge retains first-minute model contract for '+mode+(short?' short':' long'),async t=>{
  t.mock.timers.enable({apis:['Date'],now:AI_BRIDGE_TEST_NOW});
  const f=await buildAiBridgePlan({mode,short}),p=f.plan;
  assert.equal(f.snapshotCadence.decisionCadenceVersion,'flow-minute-v1');
  for(const key of ['decisionCadenceVersion','decisionIntervalMs','decisionBoundary','adaptiveParameters']){
   assert.equal(Object.hasOwn(p,key),false,key+' belongs only to the flow contract');
   assert.equal(Object.hasOwn(p.nativeEntryGuard,key),false);
  }
  assert.equal(p.entrySignalEngine,'kronos_ai');
  assert.equal(p.entryPolicyVersion,'forecast-net-edge-v1');
  assert.equal(p.nativeEntryGuard.version,'kronos-native-entry-v10');
  assert.equal(p.nativeEntryGuard.candleBoundary,f.boundary);
  assert.equal(p.nativeEntryGuard.modelDeadline,f.boundary+60000);
  assert.equal(p.entryConfirmation.targetCloseAt,f.boundary+900000-1);
  assert.equal(p.entryConfirmation.priceConfirmation.eligible,false,'momentum does not gate AI authority');
  assert.equal(p.riskPolicy.reserveFraction,mode==='demo'?'0.005':'0');
  assert.equal(p.riskBudgetUsdt,1);
  assert.equal(p.stopFraction,.02);
  assert.equal(p.maxHoldingSeconds,14400);
  assert.equal(p.profitProtection.version,'net-profit-trail-v1');
  assert.equal(p.model.modelFingerprint,p.nativeEntryGuard.modelFingerprint);
  assert.deepEqual(f.records.map(r=>r.status),['pending','submitted']);
 });
}
