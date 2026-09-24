import test from 'node:test';
import assert from 'node:assert/strict';
import {assessKevExecutionPrice} from '../src/kev-execution-price.mjs';

function fixture(short=false){
 const mode=short?'demo-futures':'demo',pair=short?'ETH/USDT:USDT':'ETH/USDT',
  entryCost={status:'ok',slippageBpsPerSide:5,requiredPriceSpaceBps:'61'},
  market={pair,bid:short?'100':'99.99',ask:short?'100.01':'100',entryCost,fetchedAt:'2026-09-22T00:00:00.000Z'};
 return {snapshot:{id:'snapshot',mode,entryPolicyVersion:'kev-order-flow-v1',markets:[market]},
  proposal:{pair,action:short?'open-short':'buy'},executionQuote:{...market},cost:{...entryCost},
  policy:{mode,maxPriceMoveBps:100},review:{status:'reviewed',snapshotId:'snapshot',request:{state:{snapshotId:'snapshot',markets:[{...market,quoteObservedAt:market.fetchedAt}]}}},
  stopFraction:.005,targetFraction:.015};
}
for(const short of [false,true]){
 for(const direction of [-1,1])test(`Kev ${short?'short':'long'} decision quote shares exact 5 bps cap in direction ${direction}`,()=>{
  const f=fixture(short),key=short?'bid':'ask';
  f.executionQuote[key]=direction<0?'99.95':'100.05';
  let result=assessKevExecutionPrice(f);assert.equal(result.eligible,true);assert.equal(result.maxMoveBps,'5');
  f.executionQuote[key]=direction<0?'99.949999999999':'100.050000000001';
  result=assessKevExecutionPrice(f);assert.equal(result.eligible,false);assert.equal(result.reason,'KEV_DECISION_QUOTE_MOVED');
 });
}
test('a cheaper long quote or higher short quote cannot silently change the approved decision',()=>{
 const long=fixture(),short=fixture(true);long.executionQuote.ask='99.9';short.executionQuote.bid='100.1';
 assert.equal(assessKevExecutionPrice(long).eligible,false);assert.equal(assessKevExecutionPrice(short).eligible,false);
});
test('policy, planned stop and remaining cost space only reduce the existing slippage cap',()=>{
 let f=fixture();f.policy.maxPriceMoveBps=2;assert.equal(assessKevExecutionPrice(f).maxMoveBps,'2');
 f=fixture();f.stopFraction=.0003;assert.equal(assessKevExecutionPrice(f).maxMoveBps,'3');
 f=fixture();f.cost.requiredPriceSpaceBps='147';assert.equal(assessKevExecutionPrice(f).maxMoveBps,'3');
 f=fixture();f.cost.requiredPriceSpaceBps='151';assert.equal(assessKevExecutionPrice(f).reason,'KEV_DECISION_QUOTE_INVALID');
 f=fixture();f.cost.slippageBpsPerSide=0;f.snapshot.markets[0].entryCost.slippageBpsPerSide=0;
 assert.equal(assessKevExecutionPrice(f).maxMoveBps,'0');f.executionQuote.ask='100.0001';assert.equal(assessKevExecutionPrice(f).eligible,false);
});
test('missing, forged or inconsistent review/snapshot prices fail closed',()=>{
 for(const change of [f=>delete f.review.request.state.markets[0].ask,f=>f.review.request.state.markets[0].ask='101',
  f=>f.snapshot.markets.push(f.snapshot.markets[0]),f=>f.cost.slippageBpsPerSide=6,
  f=>f.executionQuote.ask='NaN',f=>f.review.snapshotId='other',f=>f.cost.status='unavailable',f=>delete f.review.request.state.markets[0].quoteObservedAt]){
  const f=fixture();change(f);assert.equal(assessKevExecutionPrice(f).reason,'KEV_DECISION_QUOTE_INVALID');
 }
});
