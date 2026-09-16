import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {FLOW_VERSION} from '../src/order-flow.mjs';
import {makeSpotFlowObservation,createSpotFlowObserverState,advanceSpotFlowObserver,SPOT_FLOW_HORIZONS_MS} from '../src/spot-flow-observer.mjs';
import {SPOT_FLOW_COHORT_VERSION} from '../src/spot-flow-observer.mjs';
import {SPOT_FLOW_CONTINUATION_VERSION,SPOT_FLOW_QUALITY_VERSION} from '../src/order-flow.mjs';
const B=Date.parse('2026-09-15T06:00:00Z');
function proof(at=B,{pair='ETH/USDT',bid=100,ask=100.02,buy=true}={}){
 return {version:FLOW_VERSION,mode:'demo',pair,source:'https://demo-api.binance.com',startTime:at-61500,endTime:at-1500,
  books:[-20000,-10000,0].map((offset,i)=>({at:at+offset,updateId:i+1,
   bids:Array.from({length:5},(_,k)=>[String(bid-(2-i)*.001-k*.001),'3']),
   asks:Array.from({length:5},(_,k)=>[String(ask-(2-i)*.001+k*.001),'1'])})),
  trades:[0,1,2].map(i=>({a:i+1,T:at-55000+i*25000,p:'100',q:'1',m:!buy}))};
}
const obs=(at=B,options={},extras={})=>makeSpotFlowObservation(proof(at,options),{now:at,...extras});
const state=options=>createSpotFlowObserverState({startedAt:B,...options});
const advance=(s,now,observations=[])=>advanceSpotFlowObserver(s,{now,observations});
const marks=r=>r.records.filter(r=>r.kind==='hypotheticalQuoteMarkout');

test('compact diagnostics describe valid flow without changing eligibility or pretending weighted mid is tradable edge',()=>{
 const p=proof(),before=structuredClone(p),o=makeSpotFlowObservation(p,{now:B});
 assert.deepEqual(p,before);assert.equal(o.status,'ok');assert.equal(o.eligible,true);
 assert.equal(o.features.top1Imbalance,'0.5');assert.equal(o.features.weightedMid,'100.015');
 assert.ok(new Decimal(o.features.weightedMid).gte(o.bid)&&new Decimal(o.features.weightedMid).lte(o.ask));
 assert.ok(new Decimal(o.features.maxAggTradeNotionalShare).minus(new Decimal(1).div(3)).abs().lt('1e-18'));
 assert.equal(o.features.aggregateTradeCount,3);assert.deepEqual(o.checks,{tape:true,depth:true,mid:true});
 assert.equal(o.additionalCostBps,null);assert.equal(o.costSource,null);assert.equal(o.proofSha256.length,64);
 const notAligned=obs(B,{buy:false});assert.equal(notAligned.status,'ok');assert.equal(notAligned.eligible,false);assert.equal(notAligned.checks.tape,false);
});

test('foreign, incomplete, future, crossed, stale and contradictory assessment evidence fails closed',()=>{
 for(const modify of [p=>p.mode='demo-futures',p=>p.source='https://api.binance.com',p=>p.trades=[],p=>p.books.at(-1).at=B+1,
  p=>p.books.at(-1).asks[0][0]='1',p=>p.trades[0].m='false']){
  const p=proof();modify(p);assert.equal(makeSpotFlowObservation(p,{now:B}).status,'unavailable');
 }
 assert.equal(makeSpotFlowObservation(proof(),{now:B+45001}).status,'unavailable');
 assert.equal(makeSpotFlowObservation(proof(),{now:B,assessment:{status:'ok',eligible:false}}).reason,'OBSERVER_ASSESSMENT_MISMATCH');
 assert.equal(makeSpotFlowObservation(null,{now:B}).status,'unavailable');
});

test('anchors and forward values are pure, deterministically identified, include ineligible candidates, and never book profit',()=>{
 const s=state(),before=structuredClone(s),r=advance(s,B,[obs(B,{buy:false})]);
 assert.deepEqual(s,before);assert.equal(r.records.length,1);assert.equal(r.records[0].kind,'spot-flow-anchor');
 assert.equal(r.records[0].eligible,false);assert.deepEqual(r.records[0].horizonsMs,[60000,300000,900000]);
 assert.equal(r.state.pending.length,3);assert.deepEqual(advance(s,B,[obs(B,{buy:false})]),r);
 const next=advance(r.state,B+60000,[obs(B+60000,{bid:101,ask:101.02})]),m=marks(next)[0];
 assert.equal(m.status,'observed');assert.equal(m.horizonMs,60000);assert.equal(m.elapsedMs,60000);assert.equal(m.lateByMs,0);
 assert.equal(m.rawQuoteMarkoutBps,new Decimal(101).div('100.02').minus(1).mul(10000).toFixed());
 assert.equal(m.afterAdditionalCostBps,null);assert.equal(m.nonOverlap,true);assert.equal(m.anchorEligible,false);
 assert.equal('pnl' in m,false);assert.match(m.interpretation,/not PnL/);
});

test('explicit non-spread additional costs subtract once; missing or invalid cost provenance stays unknown',()=>{
 for(const extras of [{additionalCostBps:'20'},{additionalCostBps:'bad',costSource:'fixture'},{additionalCostBps:-1,costSource:'fixture'}])assert.equal(obs(B,{},extras).additionalCostBps,null);
 const r=advance(state(),B,[obs(B,{}, {additionalCostBps:'20',costSource:'fixture:fees-and-two-sided-slippage'})]);
 const m=marks(advance(r.state,B+60000,[obs(B+60000,{bid:101,ask:101.02})]))[0];
 assert.equal(m.afterAdditionalCostBps,new Decimal(m.rawQuoteMarkoutBps).minus(20).toFixed());
 assert.equal(m.costSource,'fixture:fees-and-two-sided-slippage');
});

test('first valid future quote wins; duplicate or later data cannot rewrite completed horizons',()=>{
 let r=advance(state(),B,[obs()]);
 r=advance(r.state,B+70000,[obs(B+59000),obs(B+65000,{bid:101,ask:101.02}),obs(B+70000,{bid:102,ask:102.02})]);
 const first=marks(r);assert.equal(first.length,1);assert.equal(first[0].sampledAt,B+65000);assert.equal(first[0].bid,'101');
 const duplicate=advance(r.state,B+70000,[obs(B+70000,{bid:103,ask:103.02})]);
 assert.equal(duplicate.records.length,0);assert.equal(duplicate.diagnostics.duplicateObservations,1);
 const later=advance(r.state,B+75000,[obs(B+75000,{bid:110,ask:110.02})]);
 assert.equal(marks(later).length,0);
});

test('20 second tolerance is inclusive; late receipt, missing and restart-before-anchor evidence never backfills',()=>{
 const r=advance(state(),B,[obs()]);
 const inclusive=advance(r.state,B+80000,[obs(B+80000)]);assert.equal(marks(inclusive)[0].status,'observed');
 const late=advance(r.state,B+80001,[obs(B+80001)]);assert.equal(marks(late)[0].status,'missing');assert.equal(marks(late)[0].rawQuoteMarkoutBps,null);
 const lateReceipt=obs(B+70000,{}, {now:B+80001});
 assert.equal(marks(advance(r.state,B+80001,[lateReceipt]))[0].status,'missing');
 const missing=advance(r.state,B+80001);assert.equal(marks(missing)[0].status,'missing');
 const backfill=advance(missing.state,B+90000,[obs(B+65000)]);assert.equal(marks(backfill).length,0);assert.equal(backfill.diagnostics.preStartObservations,1);
 const restarted=advance(createSpotFlowObserverState({startedAt:B+90000}),B+90000,[obs(B+65000)]);
 assert.equal(restarted.records.length,0);assert.equal(restarted.state.pending.length,0);
});

test('horizons, policies and pairs are isolated; nonoverlap cohorts are selected independently for each horizon',()=>{
 let r=advance(state(),B,[obs(B,{pair:'ETH/USDT'}),obs(B,{pair:'SOL/USDT'}),obs(B,{}, {policy:'research-v2'})]);
 assert.equal(r.records.length,3);assert.equal(r.state.pending.length,9);
 r=advance(r.state,B+60000,[obs(B+60000)]);
 const m=marks(r);assert.equal(m.length,1);assert.equal(m[0].pair,'ETH/USDT');assert.equal(m[0].policy,'order-flow-only-v1');
 const second=r.state.pending.filter(p=>p.anchorAt===B+60000);
 assert.deepEqual(second.map(p=>[p.horizonMs,p.nonOverlap]),[[60000,true],[300000,false],[900000,false]]);
 r=advance(r.state,B+300000,[obs(B+300000)]);
 const at5=r.state.pending.filter(p=>p.anchorAt===B+300000);
 assert.deepEqual(at5.map(p=>[p.horizonMs,p.nonOverlap]),[[60000,true],[300000,true],[900000,false]]);
 r=advance(r.state,B+900000,[obs(B+900000)]);
 assert.ok(r.state.pending.filter(p=>p.anchorAt===B+900000).every(p=>p.nonOverlap));
 assert.equal(SPOT_FLOW_HORIZONS_MS.length,3);
});

test('pending and stream cardinality remain bounded, with explicit skipped observations',()=>{
 let r=advance(state({maxPending:3}),B,[obs(),obs(B,{pair:'SOL/USDT'})]);
 assert.equal(r.state.pending.length,3);assert.equal(r.diagnostics.capacitySkipped,1);
 r=advance(r.state,B+10000,[obs(B+10000,{pair:'SOL/USDT'})]);assert.equal(r.state.pending.length,3);assert.equal(r.diagnostics.capacitySkipped,1);
 const many=Array.from({length:65},(_,i)=>obs(B,{pair:`COIN${i}/USDT`}));
 const capped=advance(state(),B,many);assert.equal(Object.keys(capped.state.streams).length,64);assert.equal(capped.diagnostics.capacitySkipped,1);
 assert.throws(()=>state({maxPending:5000}),/OBSERVER_OPTIONS/);
});

test('future observations, malformed quotes/state and backwards clocks emit no invented markouts',()=>{
 const s=state();
 assert.equal(advance(s,B,[obs(B+1)]).diagnostics.invalidObservations,1);
 const bad=obs();bad.mid='10';assert.equal(advance(s,B,[bad]).diagnostics.invalidObservations,1);
 const wrong=advance({...s,version:'wrong'},B,[obs()]);assert.equal(wrong.records.length,0);assert.match(wrong.diagnostics.error,/INVALID/);
 const backwards=advance(s,B-1,[obs()]);assert.equal(backwards.records.length,0);assert.match(backwards.diagnostics.error,/INVALID/);
 const valid=advance(s,B,[obs()]).state;
 for(const modify of [s=>s.pending[0].horizonMs=1,s=>s.pending[0].ask='0',s=>s.pending[0].anchorAt=B+1,
  s=>s.pending.push({...s.pending[0]}),s=>s.streams['order-flow-only-v1|ETH/USDT'].lastNonOverlap[1]=B]){
  const corrupted=structuredClone(valid);modify(corrupted);const result=advance(corrupted,B+1000000);
  assert.equal(result.records.length,0);assert.match(result.diagnostics.error,/INVALID/);
 }
 const missing=advance(advance(s,B,[obs()]).state,B+1000000);assert.equal(marks(missing).length,3);assert.equal(missing.state.pending.length,0);
 assert.ok(marks(missing).every(m=>m.status==='missing'&&m.rawQuoteMarkoutBps===null));
});

test('prospective cohort independently records original base flow and sampled-ask continuation without claiming tradability',()=>{
 for(const baseEligible of [true,false])for(const continued of [true,false]){
  const p=proof(B,{buy:baseEligible});
  // Rising bid with unchanged ask still passes original favorable-mid condition.
  if(!continued)for(const book of p.books)book.asks=p.books.at(-1).asks.map(level=>[...level]);
  const before=structuredClone(p),o=makeSpotFlowObservation(p,{now:B}),c=o.signalCohort;
  assert.equal(o.status,'ok');assert.equal(o.eligible,baseEligible);assert.deepEqual(p,before);
  assert.equal(c.version,SPOT_FLOW_COHORT_VERSION);assert.equal(c.executionQualityVersion,SPOT_FLOW_QUALITY_VERSION);
  assert.equal(c.baseFlowVersion,FLOW_VERSION);assert.equal(c.priceContinuationVersion,SPOT_FLOW_CONTINUATION_VERSION);
  assert.equal(c.baseFlowEligible,baseEligible);assert.equal(c.priceContinuationEligible,continued);
  assert.equal(c.baseAndContinuationEligible,baseEligible&&continued);
  assert.equal(c.priceContinuationEligible,new Decimal(c.quoteAsk).gt(c.originAsk));
  assert.equal(c.quoteAt,B);assert.equal(c.originQuoteAt,B-20000);assert.equal(c.quoteBasis,'last_sampled_book');
  assert.equal(c.costsEvaluated,false);assert.equal(c.capacityEvaluated,false);assert.equal(c.orderEligibility,null);
 }
});

test('pending and completed markout preserve anchor classification despite later continuation and policy context',()=>{
 const p=proof();for(const book of p.books)book.asks=p.books.at(-1).asks.map(level=>[...level]);
 const o=makeSpotFlowObservation(p,{now:B}),r=advance(state(),B,[o]);
 assert.equal(r.records[0].signalCohort.priceContinuationEligible,false);
 assert.ok(r.state.pending.every(p=>p.signalCohort.priceContinuationEligible===false));
 const m=marks(advance(r.state,B+60000,[obs(B+60000,{bid:101,ask:101.02})]))[0];
 assert.equal(m.anchorSignalCohort.priceContinuationEligible,false);
 assert.deepEqual(m.anchorSignalCohort,r.records[0].signalCohort);
 o.signalCohort.originAsk='999';assert.notEqual(r.records[0].signalCohort.originAsk,'999');
 assert.ok(r.state.pending.every(p=>p.signalCohort.originAsk!=='999'));
});

test('legacy persisted pending has no inferred continuation; new anchors gain prospective evidence after resume',()=>{
 const r=advance(state(),B,[obs()]);for(const p of r.state.pending)delete p.signalCohort;
 const before=structuredClone(r.state),next=advance(r.state,B+60000,[obs(B+60000)]);
 assert.deepEqual(r.state,before);assert.equal(next.diagnostics.error,undefined);
 assert.equal(marks(next)[0].anchorSignalCohort,undefined);
 assert.ok(next.state.pending.filter(p=>p.anchorAt===B+60000).every(p=>p.signalCohort?.version===SPOT_FLOW_COHORT_VERSION));
});

test('contradictory or malformed prospective cohort is rejected without substituting base qualification',()=>{
 for(const mutate of [c=>c.priceContinuationEligible=false,c=>c.quoteAt=B+1,c=>c.originAsk='0',c=>c.quoteAsk='200',
  c=>c.baseFlowEligible=false,c=>c.costsEvaluated=true,c=>c.orderEligibility=true,c=>c.version='unknown']){
  const o=obs();mutate(o.signalCohort);const r=advance(state(),B,[o]);
  assert.equal(r.records.length,0);assert.equal(r.diagnostics.invalidObservations,1);
 }
 const o=obs();o.signalCohort=null;assert.equal(advance(state(),B,[o]).diagnostics.invalidObservations,1);
 const r=advance(state(),B,[obs()]);r.state.pending[0].signalCohort.priceContinuationEligible=false;
 assert.equal(advance(r.state,B+60000,[obs(B+60000)]).diagnostics.error,'OBSERVER_STATE_OR_TIME_INVALID');
});
