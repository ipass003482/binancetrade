import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {demoRiskPolicy,stopExecutionReserve} from '../src/demo-risk.mjs';
import {demoRiskStake,DEMO_RULE_VERSION} from '../src/demo-rules.mjs';

test('observed SUI stop-limit interval is covered by new sizing without changing original costs',()=>{
 const stop=.005573138846841885,cost={status:'ok',estimatedRoundTripCostBps:31.37684152554041};
 const stake=demoRiskStake({version:DEMO_RULE_VERSION,stopFraction:stop},cost,{mode:'demo',maxStakeUsdt:300});
 assert.ok(Number(stake)<74);
 const stress=new Decimal(stake).mul(new Decimal(stop).plus('.005').plus(new Decimal(cost.estimatedRoundTripCostBps).div(10000)));
 assert.ok(stress.lte(1));assert.ok(stress.gt('.99999999'));
 // Entry/trigger/limit from the immutable SUI fill audit; this is arithmetic,
 // not a new simulated trade or a claim of changed historical PnL.
 const tick=new Decimal('.0001'),entry=new Decimal('.7263');
 const trigger=entry.mul(new Decimal(1).minus(stop)).div(tick).ceil().mul(tick);
 const limit=trigger.mul('.995').div(tick).ceil().mul(tick);
 assert.equal(trigger.toFixed(),'.7223'.replace(/^\./,'0.'));
 assert.equal(limit.toFixed(),'0.7187');
 const nativeLoss=new Decimal(1).minus(limit.div(entry));
 assert.ok(nativeLoss.lte(new Decimal(stop).plus('.005')));
 assert.equal(cost.estimatedRoundTripCostBps,31.37684152554041);
});

test('reserve covers every valid spot stop before favorable tick rounding, not futures market gaps',()=>{
 for(const stop of ['.00001','.001','.005','.02']){
  const worst=new Decimal(1).minus(new Decimal(1).minus(stop).mul('.995'));
  assert.ok(worst.lte(new Decimal(stop).plus(demoRiskPolicy('demo').reserveFraction)));
 }
 const rules={version:DEMO_RULE_VERSION,stopFraction:.01},cost={status:'ok',estimatedRoundTripCostBps:30};
 assert.equal(demoRiskStake(rules,cost,{mode:'demo-futures',maxStakeUsdt:150}),'76.92307692');
 assert.equal(demoRiskStake(rules,cost,{mode:'demo',maxStakeUsdt:300},10),'10.00000000');
 assert.throws(()=>demoRiskStake(rules,cost,{maxStakeUsdt:100}),/MODE_REQUIRED/);
});

test('persisted legacy plans remain readable; new or forged risk contracts fail closed',()=>{
 assert.equal(stopExecutionReserve({}, {mode:'demo'}).toFixed(),'0');
 assert.throws(()=>stopExecutionReserve({}, {mode:'demo',required:true}),/POLICY_INVALID/);
 const good=demoRiskPolicy('demo');
 assert.equal(stopExecutionReserve({riskPolicy:good},{mode:'demo',required:true}).toFixed(),'0.005');
 for(const riskPolicy of [{...good,reserveFraction:'0'},{...good,mode:'demo-futures'},{...good,stopLimitRatio:'0.999'},
  {...good,reserveFraction:.005},{...good,extra:1},null])
  assert.throws(()=>stopExecutionReserve({riskPolicy},{mode:'demo',required:true}),/POLICY_INVALID/);
});
