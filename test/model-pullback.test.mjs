import test from 'node:test';
import assert from 'node:assert/strict';
import {modelPullback,netRewardRisk} from '../src/model-pullback.mjs';
import {historicalPullbackDecision as modelRuleDecision} from '../src/demo-rules.mjs';
const B=Date.parse('2026-09-15T00:00:00Z');
function candles(short=false){
 return Array.from({length:96},(_,i)=>{
  const p=i===95?100:i===94?99.7:i===93?99.8:i===92?99.9:95+i*.05;
  const c=short?200-p:p,range=i>=92?.05:1.5;
  return {openTime:B-(96-i)*300000,closeTime:B-(95-i)*300000-1,open:String(c),high:String(c+range),low:String(c-range),close:String(c),volume:'1'};
 });
}
test('price proof supports symmetric trend/pullback/reclaim and preserves all source bars',()=>{
 for(const short of [false,true]){const c=candles(short),before=structuredClone(c),p=modelPullback(c,B,!short);
  assert.equal(p.eligible,true);assert.deepEqual(p.checks,{trend:true,pullback:true,reclaim:true});assert.deepEqual(c,before);
  assert.equal(p.bars.length,25);assert.equal(p.closeTimes.at(-1),B-1);
  assert.equal(modelPullback(c,B,short).eligible,false);
 }
});
test('chasing without a pullback, unconfirmed wick and flat trend do not create entries',()=>{
 const c=candles();for(const [i,v]of [[92,99.7],[93,99.8],[94,99.9]])Object.assign(c[i],{open:String(v),high:String(v+.05),low:String(v-.05),close:String(v)});
 assert.equal(modelPullback(c,B,true).checks.pullback,false);
 const wick=candles();wick.at(-2).high='100';assert.equal(modelPullback(wick,B,true).checks.reclaim,false);
 const flat=candles();for(const r of flat)Object.assign(r,{open:'100',high:'100',low:'100',close:'100'});assert.equal(modelPullback(flat,B,true).eligible,false);
});
test('missing, future, duplicate, malformed and impossible price bars fail closed',()=>{
 for(const mutate of [c=>c.pop(),c=>c.at(-1).closeTime++,c=>c.at(-2).openTime+=300000,c=>c.at(-1).close='NaN',c=>c.at(-1).high='90',c=>c.at(-1).close=true]){
  const c=candles();mutate(c);assert.throws(()=>modelPullback(c,B,true));
 }
});
test('net reward/risk includes both fee sides and spot stop-limit reserve without threshold rounding',()=>{
 const a={targetFraction:'.021',stopFraction:'.01',costFraction:'.003',reserveFraction:'.005'};
 assert.equal(netRewardRisk(a).eligible,true);assert.equal(netRewardRisk({...a,targetFraction:'.020999999999'}).eligible,false);
 assert.equal(netRewardRisk({...a,reserveFraction:'0'}).eligible,true);
 assert.throws(()=>netRewardRisk({...a,costFraction:-1}));
});
test('active spot/long/short strategy requires the model and records the distinct hypothesis without amplifying forecasts',()=>{
 for(const [mode,short,action] of [['demo',false,'buy'],['demo-futures',false,'open-long'],['demo-futures',true,'open-short']]){
  const pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',c=candles(short),market={pair,candles:c,ask:'100.001',bid:'99.999',verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures'};
  const snapshot={mode,timeframe:'5m',candleBoundary:B,createdAt:new Date(B+1000).toISOString(),markets:[market],evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}},{id:'technical:'+pair,status:'ok',pair}]};
  const path=short?['99.99','99.98','99.97']:['100.01','100.02','100.03'];
  const modelEvidence={status:'ok',entryAllowed:true,modelFingerprint:'a'.repeat(64),predictionSha256:'b'.repeat(64),prediction:{issuedAt:new Date(B+3000).toISOString(),forecasts:[{pair,originClose:'100',forecastCloses:path,targetCloseAt:B+899999}]}};
  const args={snapshot,pair,modelEvidence,cost:{status:'ok',estimatedRoundTripCostBps:'30',requiredPriceSpaceBps:'60'},now:B+5000};
  const r=modelRuleDecision(args);assert.equal(r.action,action);assert.equal(r.entryPolicyVersion,'trend-pullback-model-v1');assert.deepEqual(r.entryConfirmation.forecastCloses,path);
  assert.equal(r.directionChecks[0].netRewardRisk.eligible,true);assert.ok(Number(r.forecastMoveBps)<60);
  assert.equal(modelRuleDecision({...args,modelEvidence:null}).action,'hold');
  assert.equal(modelRuleDecision({...args,modelEvidence:{...modelEvidence,entryAllowed:false}}).action,'hold');
 }
});
