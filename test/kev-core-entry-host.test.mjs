import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {buildKevFlowBridgePlan,KEV_BRIDGE_TEST_NOW} from './kev-flow-bridge-fixture.mjs';
import {KEV_ENTRY_SIGNAL_POLICY} from '../src/kev-entry-signal.mjs';
import {KEV_NET_HARVEST_POLICY} from '../src/kev-exit-policy.mjs';
import {kevFlowReference,kevFlowRule} from '../src/kev-flow.mjs';
import {kevEntryRejection,kevDigest,reviewKevEntries} from '../src/kev-entry.mjs';
import {assessOrderFlow} from '../src/order-flow.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {runCycle} from '../src/workflow.mjs';
import {buildKevPortfolioEligibility} from '../src/kev-portfolio.mjs';
import {writeJson,readJson} from '../src/io.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function freezeClock(t){t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});}
const ref=(f,snapshot=f.snapshot,account=f.account,now=f.now)=>kevFlowReference(snapshot,f.policy,account,{now});
const reseal=review=>{const {proofSha256,...body}=review;return {...body,proofSha256:kevDigest(body)};};

test('coherent whole cycle does not read or overwrite retired legacy confirmation state',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true}),local=await mkdtemp(join(tmpdir(),'kev-coherent-cycle-'));
 t.after(()=>rm(local,{recursive:true,force:true}));
 await writeJson(join(local,'kev-entry.json'),{version:'kev-codex-entry-v1',mode:f.mode,enabled:true,
  decisionMode:'autonomous',activatedAt:new Date(f.now).toISOString()});
 const legacyBytes='{"interruptedLegacyWrite":';
 await writeFile(join(local,'kev-confirmation.json'),legacyBytes,'utf8');
 let calls=0,executions=0;
 const result=await runCycle({local,policy:f.policy,client:{snapshot:async()=>f.account},scheduledDecisionBoundary:f.boundary,
  collectFn:async()=>structuredClone(f.snapshot),costsFn:async()=>f.snapshot.costFacts,
  modelEvidenceFn:async()=>assert.fail('the coherent route cannot invoke model confirmation'),
  kevPortfolioFn:async({snapshot})=>buildKevPortfolioEligibility({snapshot,now:f.now,
   accounts:Object.fromEntries(['demo','demo-futures'].map(mode=>[mode,{observedAt:new Date(f.now).toISOString(),trades:[],
    engine:{demo_trading:true,dry_run:false,exchange:'binance',trading_mode:mode==='demo'?'spot':'futures',margin_mode:'isolated',state:'running'}}]))}),
  kevReviewFn:args=>reviewKevEntries({...args,fetchImpl:async(_url,{body})=>{calls++;return new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:'q0',now:f.now})));}}),
  executeFn:async({proposal})=>{executions++;assert.equal(proposal.action,'buy');return {status:'hold'};}});
 assert.equal(calls,1);assert.equal(executions,1);assert.equal(result.proposal.action,'buy');
 assert.equal(await readFile(join(local,'kev-confirmation.json'),'utf8'),legacyBytes);
 const review=await readJson(join(local,'runs',f.snapshot.id+'.kev-review.json'));
 assert.equal(review.request.state.requestVersion,'kev-flow-request-v5');
 assert.deepEqual(review.request.state.entrySignalPolicy,KEV_ENTRY_SIGNAL_POLICY);
});

for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test(`coherent actual host/reviewer/bridge binds the original two local intervals ${mode}/${short}`,async t=>{
  freezeClock(t);const f=await buildKevFlowBridgePlan({mode,short,coherent:true}),p=f.plan,
   state=f.kevReview.request.state,c=state.candidates.find(c=>c.pair===f.pair&&c.action===f.result.action),proof=f.snapshot.markets[0].orderFlow;
  assert.equal(f.submitCalls,1);assert.equal(f.result.status,'submitted');
  assert.equal(p.nativeEntryGuard.version,'kev-native-entry-v3');assert.deepEqual(p.entrySignalPolicy,KEV_ENTRY_SIGNAL_POLICY);
  assert.deepEqual(p.exitPolicy,KEV_NET_HARVEST_POLICY);assert.equal(p.stopFraction,.005);assert.equal(p.maxHoldingSeconds,900);
  assert.equal(state.requestVersion,'kev-flow-request-v5');assert.deepEqual(state.entrySignalPolicy,p.entrySignalPolicy);
  assert.equal(c.entrySignalPolicyVersion,p.entrySignalPolicy.version);assert.equal(c.entrySignal.eligible,true);
  assert.deepEqual(c.entrySignal.halves.map(h=>h.tradeCount),[2,2]);assert.equal(c.entrySignal.overall.directionalShare,'0.6');
  assert.equal(state.markets[0].orderFlow.books.length,3);
  assert.deepEqual(state.markets[0].orderFlow.books.map(b=>b.at),proof.books.map(b=>b.at));
  assert.deepEqual(p.entryConfirmation.orderFlow,proof);
  assert.equal(f.reference.candidates.filter(c=>c.action!=='hold').length,1);
  assert.ok(!f.reference.metadata.candidateDiagnostics.blockers.some(b=>b.reason==='KEV_FLOW_CONFIRMATION_PENDING'));
  assert.equal(Object.hasOwn(f.selected.proposal,'kevConfirmation'),false);
  assert.equal(assessOrderFlow(proof,{mode,pair:f.pair,long:!short,now:f.now}).reason,'FLOW_TAPE_BOOK_MISMATCH');
  assert.deepEqual(f.records.map(r=>r.status),['pending','submitted']);
  assert.deepEqual(f.records[0].entrySignalPolicy,p.entrySignalPolicy);
  assert.equal(kevEntryRejection({review:f.kevReview,snapshot:f.snapshot,proposal:f.selected.proposal,config:f.config,now:f.now}),null);
 });
}

test('legacy snapshots retain two-minute confirmation, old request evidence and native guard',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan();
 assert.equal(Object.hasOwn(f.snapshot,'entrySignalPolicy'),false);assert.equal(Object.hasOwn(f.plan,'entrySignalPolicy'),false);
 assert.equal(f.plan.nativeEntryGuard.version,'kev-native-entry-v2');assert.equal(f.kevReview.request.state.requestVersion,'kev-flow-request-v4');
 assert.equal(f.kevReview.request.state.markets[0].orderFlow.books.length,2);
 const first=ref(f);assert.equal(first.metadata.candidateDiagnostics.eligible,0);
 assert.ok(first.metadata.candidateDiagnostics.blockers.some(b=>b.reason==='KEV_FLOW_CONFIRMATION_PENDING'));
});

test('coherent shortlist does not reintroduce static signed-book preference',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true}),snapshot=structuredClone(f.snapshot),
  second=structuredClone(snapshot.markets[0]),secondPair='BTC/USDT';
 second.pair=secondPair;second.orderFlow.pair=secondPair;second.entryCost.pair=secondPair;
 for(const book of second.orderFlow.books){for(const row of book.bids)row[1]='2';for(const row of book.asks)row[1]='1';}
 snapshot.markets.push(second);
 const policy={...f.policy,pairs:[f.pair,secondPair]},reference=kevFlowReference(snapshot,policy,f.account,{now:f.now});
 assert.equal(reference.metadata.candidateDiagnostics.eligible,2);
 const review=await reviewKevEntries({reference,snapshot,policy,account:f.account,config:f.config,now:()=>f.now,
  fetchImpl:async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:'q0',now:f.now})))});
 assert.equal(review.status,'reviewed',review.reason);
 const candidates=review.request.state.candidates;
 assert.deepEqual(candidates.map(c=>c.pair),[f.pair,secondPair]);
 assert.ok(candidates.every(c=>c.flowShortlist.version==='kev-coherent-shortlist-v1'));
 assert.ok(candidates.every(c=>!Object.hasOwn(c.flowShortlist,'persistentBookImbalance')));
 assert.ok(candidates[0].entrySignal.bookImbalances.every(v=>new Decimal(v).lt(0)));
 assert.ok(candidates[1].entrySignal.bookImbalances.every(v=>new Decimal(v).gt(0)));
 assert.deepEqual(candidates[0].flowShortlist,candidates[1].flowShortlist);
});

test('host and reviewer use same-window tape even when the original full tape points the other way',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true}),snapshot=structuredClone(f.snapshot),proof=snapshot.markets[0].orderFlow;
 proof.trades.unshift({a:0,T:f.now-30000,p:'100',q:'1000',m:true});
 const reference=ref(f,snapshot),candidate=reference.candidates[0];
 assert.equal(candidate.action,'buy');assert.equal(candidate.entrySignal.overall.directionalShare,'0.6');
 assert.equal(candidate.entrySignal.tradeCount,4);assert.ok(new Decimal(candidate.orderFlowMetrics.buyTakerShare).lt('.55'));
 let calls=0;
 const review=await reviewKevEntries({snapshot,reference,policy:f.policy,account:f.account,config:f.config,now:()=>f.now,
  fetchImpl:async(_url,{body})=>{calls++;const request=JSON.parse(body);
   assert.equal(request.state.candidates[0].entrySignal.overall.directionalShare,'0.6');
   assert.ok(new Decimal(request.state.markets[0].orderFlow.metrics.takerBuyShare).lt('.55'));
   return new Response(JSON.stringify(kevReply(request,{choice:'q0',now:f.now})));}});
 assert.equal(calls,1);assert.equal(review.status,'reviewed');assert.equal(review.approvedPairs[0],f.pair);
});

test('adverse or absorbed quotes and an empty local half block without calling Kev',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true});
 for(const [change,reason] of [
  [p=>{p.books[1].bids=p.books[1].bids.map(([price,qty])=>[new Decimal(price).minus('.02').toFixed(),qty]);},'KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE'],
  [p=>{p.books.forEach(b=>{b.bids=structuredClone(p.books[0].bids);b.asks=structuredClone(p.books[0].asks);});},'KEV_SIGNAL_FINAL_QUOTES_NOT_CONFIRMED'],
  [p=>{p.trades[0].T=f.now-40000;p.trades[1].T=f.now-30000;},'KEV_SIGNAL_HALF_TAPE_INCOMPLETE'],
 ]){
  const snapshot=structuredClone(f.snapshot);change(snapshot.markets[0].orderFlow);const reference=ref(f,snapshot);
  assert.equal(reference.metadata.candidateDiagnostics.eligible,0);assert.ok(reference.candidates[0].reasons.includes(reason));
  const review=await reviewKevEntries({snapshot,reference,policy:f.policy,account:f.account,config:f.config,now:()=>f.now,
   fetchImpl:async()=>assert.fail('ineligible local evidence must not be sent to Kev')});
  assert.equal(review.invoked,false);assert.equal(review.approvedPairs.length,0);
 }
});

test('invalid or absent policy fields cannot opt into relaxed legacy gates',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true});
 const missing={...KEV_ENTRY_SIGNAL_POLICY};delete missing.minimumTradeCount;
 for(const policy of [null,{},missing,{...KEV_ENTRY_SIGNAL_POLICY,version:'unknown'},
  {...KEV_ENTRY_SIGNAL_POLICY,minimumDirectionalShare:'0.5'},{...KEV_ENTRY_SIGNAL_POLICY,extra:1}]){
  const snapshot=structuredClone(f.snapshot);snapshot.entrySignalPolicy=policy;const r=ref(f,snapshot);
  assert.equal(r.metadata.candidateDiagnostics.eligible,0);assert.ok(r.candidates[0].reasons.includes('KEV_ENTRY_SIGNAL_POLICY_MISMATCH'));
 }
 const legacy=structuredClone(f.snapshot);delete legacy.entrySignalPolicy;
 assert.equal(ref(f,legacy).metadata.candidateDiagnostics.eligible,0);
 assert.ok(ref(f,legacy).candidates[0].reasons.includes('FLOW_TAPE_BOOK_MISMATCH'));
});

test('new entry thesis preserves cost, shock, freshness, size and existing-position gates',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true});
 const cases=[
  [s=>{s.markets[0].entryCost=null;},'ENTRY_COSTS_UNAVAILABLE'],
  [s=>{s.markets[0].entryCost.requiredPriceSpaceBps='151';},'KEV_FLOW_PRICE_SPACE_TOO_SMALL'],
  [s=>{s.markets[0].spreadBps=16;},'FLOW_LIQUIDITY_SHOCK'],
  [s=>{for(const [i,b]of s.markets[0].orderFlow.books.entries())for(const levels of [b.bids,b.asks])for(const row of levels)row[0]=new Decimal(row[0]).plus(new Decimal(i).mul('.2')).toFixed();},'FLOW_VOLATILITY_SHOCK'],
  [s=>{s.markets[0].filters.find(f=>f.filterType==='MIN_NOTIONAL').minNotional='1000000';s.markets[0].filters.find(f=>f.filterType==='MIN_NOTIONAL').notional='1000000';},'DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM'],
 ];
 for(const [change,reason]of cases){const snapshot=structuredClone(f.snapshot);change(snapshot);const r=ref(f,snapshot);
  assert.equal(r.metadata.candidateDiagnostics.eligible,0);assert.ok(r.candidates[0].reasons.includes(reason),JSON.stringify(r.candidates[0].reasons));}
 const occupied={...f.account,trades:[{pair:f.pair,stake_amount:10}]};
 assert.ok(ref(f,f.snapshot,occupied).candidates[0].reasons.includes('POSITION_ALREADY_EXISTS'));
 const expired=ref(f,f.snapshot,f.account,f.now+45001);
 assert.equal(expired.metadata.candidateDiagnostics.eligible,0);assert.ok(expired.candidates[0].reasons.includes('FLOW_STALE'));
});

for(const [mode,short] of [['demo',false],['demo-futures',true]]){
 test(`current executable quote must retain the originally sampled response ${mode}/${short}`,async t=>{
  freezeClock(t);const f=await buildKevFlowBridgePlan({mode,short,coherent:true}),market=f.snapshot.markets[0],first=market.orderFlow.books[0];
  const q={...market,bid:first.bids[0][0],ask:first.asks[0][0]},r=kevFlowRule({snapshot:f.snapshot,pair:f.pair,
   action:short?'open-short':'buy',cost:market.entryCost,quote:q,policy:f.policy,now:f.now});
  assert.equal(r.action,'hold');assert.ok(r.reasons.includes('KEV_SIGNAL_EXECUTION_PRICE_NOT_CONFIRMED'));
 });
}

test('review policy tampering is rejected even with a freshly recomputed outer digest',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan({coherent:true});
 const changes=[
  state=>{state.entrySignalPolicy.minimumDirectionalShare='0.5';},
  state=>{delete state.entrySignalPolicy;},
  state=>{state.entrySignalPolicy=null;},
  state=>{state.candidates[0].entrySignalPolicyVersion='other';},
  state=>{delete state.candidates[0].entrySignalPolicyVersion;},
  state=>{state.requestVersion='kev-flow-request-v4';},
 ];
 for(const change of changes){const review=structuredClone(f.kevReview);change(review.request.state);
  assert.equal(kevEntryRejection({review:reseal(review),snapshot:f.snapshot,proposal:f.selected.proposal,config:f.config,now:f.now}),
   'KEV_ENTRY_SIGNAL_POLICY_MISMATCH');}
});

test('legacy approval cannot smuggle a new entry policy with a recomputed seal',async t=>{
 freezeClock(t);const f=await buildKevFlowBridgePlan(),review=structuredClone(f.kevReview);
 review.request.state.entrySignalPolicy={...KEV_ENTRY_SIGNAL_POLICY};review.request.state.candidates[0].entrySignalPolicyVersion=KEV_ENTRY_SIGNAL_POLICY.version;
 assert.equal(kevEntryRejection({review:reseal(review),snapshot:f.snapshot,proposal:f.selected.proposal,config:f.config,now:f.now}),
  'KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
});
