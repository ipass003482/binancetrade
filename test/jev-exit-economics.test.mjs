import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateExitEconomics,KEV_SIZED_EXIT_EVIDENCE_VERSION} from '../src/kev-sized-exit-economics.mjs';
import {KEV_NET_HARVEST_POLICY} from '../src/kev-exit-policy.mjs';
import {DEMO_PROFIT_PROTECTION} from '../src/demo-rules.mjs';
import {buildKevFlowBridgePlan,KEV_BRIDGE_TEST_NOW} from './kev-flow-bridge-fixture.mjs';
import {kevEntryRejection,reviewKevEntries} from '../src/kev-entry.mjs';
import {kevFlowReference} from '../src/kev-flow.mjs';
import {kevReply} from './kev-fixtures.mjs';

function fixture(mode='demo',action=mode==='demo'?'buy':'open-long',notional='75'){
 return {mode,action,proposedEntryNotionalUsdt:notional,stopFraction:.005,targetFraction:.015,maxHoldingSeconds:900,
  exitPolicy:{...KEV_NET_HARVEST_POLICY},market:{bid:'100',ask:'100.1',spreadBps:'10',
   entryCost:{status:'ok',buyRate:'.001',sellRate:'.002',roundTripFeeBps:'30',spreadBps:'10',
    slippageBpsPerSide:5,fundingReserveBps:mode==='demo'?'0':'2',
    estimatedRoundTripCostBps:mode==='demo'?'50':'52',requiredPriceSpaceBps:mode==='demo'?'80':'82'}}};
}
const close=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(Number(actual)-expected)<=tolerance,`${actual} != ${expected}`);

for(const [mode,action] of [['demo','buy'],['demo-futures','open-long'],['demo-futures','open-short']]){
 test(mode+' '+action+' sized scenarios reconcile native fee cash flows with one exit reserve',()=>{
  const f=fixture(mode,action),before=JSON.stringify(f),r=candidateExitEconomics(f),short=action==='open-short',
   entry=(short?100:100.1)*(short?.9995:1.0005),amount=75/entry,entryFee=short?.002:.001,exitFee=short?.001:.002,
   funding=mode==='demo'?0:.015,openValue=75*(short?1-entryFee:1+entryFee),
   nativeNet=(quote,reserve=true)=>{
    const closeValue=amount*quote*(reserve?(short?1.0005:.9995):1)*(short?1+exitFee:1-exitFee);
    return (short?openValue-closeValue:closeValue-openValue)-funding;
   };
  assert.equal(r.version,KEV_SIZED_EXIT_EVIDENCE_VERSION);assert.equal(r.proposedEntryNotionalCeilingUsdt,'75');
  assert.equal(r.maxHoldingSeconds,900);
  close(r.netUsdtAfterExitReserve.unchangedQuote,nativeNet(short?100.1:100));
  close(r.netUsdtAfterExitReserve.stopTrigger,nativeNet(entry*(short?1.005:.995)));
  close(r.netUsdtAfterExitReserve.grossTarget,nativeNet(entry*(short?.985:1.015)));
  close(r.netUsdtBeforeExitReserve.unchangedQuote,nativeNet(short?100.1:100,false));
  close(r.netUsdtBeforeExitReserve.stopTrigger,nativeNet(entry*(short?1.005:.995),false));
  close(r.netUsdtBeforeExitReserve.grossTarget,nativeNet(entry*(short?.985:1.015),false));
  assert.equal(r.netThresholdUsdt.trailActivation,'0.50000000');assert.equal(r.netThresholdUsdt.trailGiveback,'0.25000000');
  assert.equal(r.netThresholdUsdt.middleHarvest,'1.00000000');assert.equal(r.netThresholdUsdt.lateHarvest,'0.07500000');
  close(r.netThresholdBps.trailActivation,10000*.5/75);close(r.netThresholdBps.trailGiveback,10000*.25/75);
  close(r.netThresholdBps.middleHarvest,10000/75);assert.equal(r.netThresholdBps.lateHarvest,'10.00000000');
  assert.equal(JSON.stringify(f),before,'Original inputs and policy remain immutable');
 });
}

test('a smaller proposed notional shrinks cash outcomes but makes absolute native thresholds harder',()=>{
 const low=candidateExitEconomics(fixture('demo','buy','50')),high=candidateExitEconomics(fixture('demo','buy','150'));
 for(const key of ['unchangedQuote','stopTrigger','grossTarget'])close(high.netUsdtAfterExitReserve[key],Number(low.netUsdtAfterExitReserve[key])*3,2e-8);
 for(const key of ['trailActivation','trailGiveback','middleHarvest']){
  assert.equal(low.netThresholdUsdt[key],high.netThresholdUsdt[key]);
  close(low.netThresholdBps[key],Number(high.netThresholdBps[key])*3,2e-8);
 }
 assert.equal(low.netThresholdBps.lateHarvest,high.netThresholdBps.lateHarvest);
 close(high.netThresholdUsdt.lateHarvest,Number(low.netThresholdUsdt.lateHarvest)*3);
 assert.equal(low.harvestBelowGrossTarget.middle,false);assert.equal(high.harvestBelowGrossTarget.middle,true);
});

test('the original gross target wins equal-threshold geometry without adding a buffer as an expense',()=>{
 const f=fixture('demo','buy','1000');f.targetFraction=.005;
 Object.assign(f.market,{ask:'100',spreadBps:'0'});
 // A synthetic exact equality: 1000 * (1.005 * .9995 - 1 - .0034975) = 1.
 Object.assign(f.market.entryCost,{buyRate:'.0034975',sellRate:'0',roundTripFeeBps:'34.975',spreadBps:'0',
  fundingReserveBps:'0',estimatedRoundTripCostBps:'44.975',requiredPriceSpaceBps:'74.975'});
 const equality=candidateExitEconomics(f);
 assert.equal(equality.netUsdtAfterExitReserve.grossTarget,'1.00000000');
 assert.equal(equality.harvestBelowGrossTarget.middle,false);
 f.market.entryCost.requiredPriceSpaceBps='300';
 assert.deepEqual(candidateExitEconomics(f),equality,'Net buffer is not a cash fee');
 f.proposedEntryNotionalUsdt='1001';assert.equal(candidateExitEconomics(f).harvestBelowGrossTarget.middle,true);
});

test('funding remains a reserved entry assumption and invalid notional never becomes a zero-profit scenario',()=>{
 const f=fixture('demo-futures','open-short','140'),baseline=candidateExitEconomics(f);
 Object.assign(f.market.entryCost,{fundingReserveBps:'12',estimatedRoundTripCostBps:'62',requiredPriceSpaceBps:'92'});
 const higher=candidateExitEconomics(f);
 for(const key of ['unchangedQuote','stopTrigger','grossTarget'])close(Number(baseline.netUsdtAfterExitReserve[key])-Number(higher.netUsdtAfterExitReserve[key]),.14);
 for(const bad of [0,-1,'',null,NaN,Infinity,'1e100'])assert.throws(()=>candidateExitEconomics({...f,proposedEntryNotionalUsdt:bad}),/KEV_SIZED_EXIT_ECONOMICS_INVALID/);
 assert.throws(()=>candidateExitEconomics({...f,maxHoldingSeconds:1800}),/KEV_SIZED_EXIT_ECONOMICS_INVALID/);
});

for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test('Jev request carries sized evidence and the unchanged native policy '+mode+'/'+short,async t=>{
  t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
  const f=await buildKevFlowBridgePlan({mode,short,coherent:true,provider:'jev'}),state=f.kevReview.request.state,
   candidate=state.candidates.find(c=>c.id===f.kevReview.selection.choice),original=f.reference.candidates.find(c=>c.pair===candidate.pair&&c.action===candidate.action);
  assert.equal(state.requestVersion,'kev-flow-request-v5');assert.equal(state.exitEconomicsEvidence.version,KEV_SIZED_EXIT_EVIDENCE_VERSION);
  assert.deepEqual(state.profitProtection,DEMO_PROFIT_PROTECTION);assert.deepEqual(state.profitProtection,f.plan.profitProtection);
  assert.deepEqual(state.exitPolicy,KEV_NET_HARVEST_POLICY);assert.deepEqual(state.exitPolicy,f.plan.exitPolicy);
  assert.equal(candidate.exitEconomics.proposedEntryNotionalCeilingUsdt,original.stakeUsdt.replace(/0+$/,'').replace(/\.$/,''));
  assert.equal(candidate.exitEconomics.maxHoldingSeconds,900);assert.equal(f.plan.maxHoldingSeconds,900);
  assert.equal(f.plan.stopFraction,.005);assert.equal(f.plan.targetFraction,.015);
  assert.equal(state.rewardEvidence.expectedEdge,null);assert.equal(state.rewardEvidence.holdingHorizon.attainmentProbability,null);
  assert.match(state.exitEconomicsEvidence.notionalBasis,/not a fill/);assert.match(state.exitEconomicsEvidence.accounting,/not known booked funding/);
  assert.match(f.kevReview.request.questions.entry.criteria.hold,/every offered q has an explicit supplied-evidence blocker/);
  assert.ok(Buffer.byteLength(JSON.stringify(f.kevReview.request))<=32768);
  const tampered=structuredClone(f.kevReview);tampered.request.state.candidates[0].exitEconomics.netUsdtAfterExitReserve.grossTarget='999';
  assert.ok(kevEntryRejection({snapshot:f.snapshot,policy:f.policy,config:f.config,review:tampered,proposal:f.selected.proposal,now:f.now}),'New evidence remains bound by the original approval proof');
 });

 test('configured three-candidate Jev pool retains complete economics and evidence '+mode+'/'+short,async t=>{
  t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
  const f=await buildKevFlowBridgePlan({mode,short,coherent:true,provider:'jev'}),snapshot=structuredClone(f.snapshot),
   pairs=['ETH','BTC','SOL'].map(base=>base+'/USDT'+(mode==='demo-futures'?':USDT':''));
  snapshot.markets=pairs.map(pair=>{
   const m=structuredClone(f.snapshot.markets[0]);m.pair=m.entryCost.pair=m.orderFlow.pair=pair;
   m.orderFlow.trades=m.orderFlow.trades.flatMap(trade=>Array.from({length:4},()=>({...trade,p:'100.00000000',q:String(Number(trade.q)*12345.6789)})))
    .map((trade,index)=>({...trade,a:index+1}));
   return m;
  });
  const policy={...f.policy,pairs},reference=kevFlowReference(snapshot,policy,f.account,{now:f.now}),
   before=JSON.stringify({snapshot,reference});let request,payloadBytes;
  const review=await reviewKevEntries({snapshot,reference,account:f.account,policy,config:{...f.config,maxCandidates:3},now:()=>f.now,
   credentialFn:async()=> 'synthetic-key-offline-only',fetchImpl:async(_url,{body})=>{
    payloadBytes=Buffer.byteLength(body);request=JSON.parse(body);
    const reply=kevReply(request,{now:f.now,choice:request.state.candidates.at(-1).id});
    return new Response(JSON.stringify({model:f.config.model,answers:reply.answers,usage:{input_tokens:100,output_tokens:0}}));
   }});
  assert.equal(review.status,'reviewed',review.reason);assert.equal(request.state.candidates.length,3);
  assert.equal(request.state.markets.length,3);assert.ok(payloadBytes<=32768);
  assert.deepEqual(request.state.candidates.map(c=>c.pair),pairs);
  for(const candidate of request.state.candidates){
   assert.equal(candidate.exitEconomics.version,KEV_SIZED_EXIT_EVIDENCE_VERSION);
   assert.ok(candidate.exitEconomics.netUsdtBeforeExitReserve&&candidate.exitEconomics.netUsdtAfterExitReserve);
   assert.ok(candidate.costEconomics.holdingHorizon);assert.equal(candidate.entrySignal.halves.length,2);
  }
  for(const market of request.state.markets){
   assert.equal(market.orderFlow.books.length,3);
   assert.ok(market.orderFlow.books.every(book=>book.bids.length===5&&book.asks.length===5));
   assert.equal(market.orderFlow.recentTradeSample.length,8);assert.ok(market.costs);
  }
  assert.equal(review.requestMetrics.omittedCandidateCount,0);
  assert.equal(JSON.stringify({snapshot,reference}),before);
 });
}
