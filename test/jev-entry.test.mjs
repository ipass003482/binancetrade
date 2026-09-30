import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildKevFlowBridgePlan,KEV_BRIDGE_TEST_NOW} from './kev-flow-bridge-fixture.mjs';
import {reviewKevEntries,kevEntryReceipt,kevEntryRejection} from '../src/kev-entry.mjs';
import {kevFlowReference} from '../src/kev-flow.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {JEV_MODEL,JEV_BASE_URL} from '../src/reviewer-identity.mjs';

function freeze(t){t.mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});}
function input(f,extra={}){
 return {reference:f.reference,snapshot:f.snapshot,account:f.account,policy:f.policy,config:f.config,now:()=>f.now,
  credentialFn:async()=> 'synthetic-private-key',...extra};
}
function official(request){
 const r=kevReply(request,{choice:'q0'});
 return {model:JEV_MODEL,answers:r.answers,usage:{input_tokens:100,output_tokens:0}};
}
for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test('Jev original approval reaches guarded bridge with distinct provenance '+mode+'/'+short,async t=>{
  freeze(t);const f=await buildKevFlowBridgePlan({mode,short,coherent:true,provider:'jev'});
  const review=f.kevReview,receipt=f.plan.entryEvidence.kevReview;
  assert.equal(f.submitCalls,1);assert.equal(review.version,'jev-typesafe-entry-v1');
  assert.equal(receipt.provider,'typesafe-api');assert.equal(receipt.model,JEV_MODEL);
  assert.equal(receipt.providerRevision,f.snapshot.kevEntry.providerRevision);
  assert.equal(review.request.state.decisionProvider.revision,receipt.providerRevision);
  assert.equal(review.response.backend.api_calls,1);assert.equal(review.response.backend.cli_calls,undefined);
  assert.deepEqual(review.response.answers,review.response.upstream.answers);
  assert.equal(review.response.usage.output_tokens,0);
  assert.equal(review.response.backend.request_id_source,'host');
  assert.equal(review.response.backend.timestamp_source,'host');
  assert.equal(f.plan.stopFraction,.005);assert.equal(f.plan.maxHoldingSeconds,900);
  assert.equal(f.plan.nativeEntryGuard.version,'kev-native-entry-v3');
  assert.equal(kevEntryRejection({...input(f),review,proposal:f.selected.proposal,now:f.now}),null);
  assert.equal(kevEntryRejection({...input(f),review,proposal:f.selected.proposal,now:f.now,
   config:{...f.config,providerRevision:randomUUID()}}),'KEV_APPROVAL_MISSING_OR_MISMATCH');
 });
}
test('Jev sends only the bounded public candidate payload to official API and stores no key',async t=>{
 freeze(t);const f=await buildKevFlowBridgePlan({coherent:true,provider:'jev'});let count=0,sentRequest;
 const review=await reviewKevEntries(input(f,{fetchImpl:async(url,options)=>{
  count++;assert.equal(url,JEV_BASE_URL+'/v1/systemone');assert.equal(options.redirect,'error');
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer synthetic-private-key');
  const request=JSON.parse(options.body);
  sentRequest=request;
  assert.equal(request.model,JEV_MODEL);
  assert.equal(request.state.decisionProvider.provider,'typesafe-api');
  assert.match(request.state.context,/Static depth-volume sign/);
  assert.ok(!/synthetic-private-key|api-auth|accountSecret/.test(options.body));
  return new Response(JSON.stringify(official(request)));
 }}));
 assert.equal(count,1);assert.equal(review.status,'reviewed',review.reason);
 assert.match(sentRequest.state.role,/host-ranked policy/);
 assert.equal(sentRequest.state.reviewerDecisionPolicyVersion,'jev-host-ranked-choice-v2');
 assert.match(sentRequest.questions.entry.instructions,/Select the first candidate without a concrete supplied-evidence blocker/);
 assert.match(sentRequest.state.context,/Only q0 is the default first choice/);
 assert.match(sentRequest.state.context,/rawTradeSampleIsComplete=false means the sample is intentionally partial/);
 assert.match(sentRequest.state.context,/expectedEdge=null.*intentional limitations, not missing required inputs/);
 assert.match(sentRequest.state.context,/do not invent an age limit or an unsupplied current time/);
 assert.match(sentRequest.state.context,/do not block an offered q/);
 assert.match(sentRequest.state.context,/negative unchanged-quote scenario.*not by itself a failed host gate/);
 assert.match(sentRequest.state.context,/harvestBelowGrossTarget=false.*not a forecast or an automatic rejection/);
 assert.match(sentRequest.questions.entry.criteria.q0,/first host-ranked candidate/);
 assert.match(sentRequest.questions.entry.criteria.hold,/every offered q has an explicit supplied-evidence blocker/);
 assert.doesNotMatch(sentRequest.questions.entry.criteria.hold,/sufficiently supported fee-inclusive opportunity/);
 assert.ok(!JSON.stringify(review).includes('synthetic-private-key'));
 assert.equal(kevEntryReceipt(review,f.pair).provider,'typesafe-api');
});
test('Jev provider mismatch, invalid key, overload and wrong model never fall back or approve',async t=>{
 freeze(t);const f=await buildKevFlowBridgePlan({coherent:true,provider:'jev'});
 for(const status of [401,429,529]){
  let calls=0;const review=await reviewKevEntries(input(f,{fetchImpl:async url=>{
   calls++;assert.equal(url,JEV_BASE_URL+'/v1/systemone');return new Response('synthetic-private-key',{status});
  }}));
  assert.equal(calls,1);assert.equal(review.status,'hold');assert.deepEqual(review.approvedPairs,[]);
  assert.ok(!JSON.stringify(review).includes('synthetic-private-key'));
 }
 const wrong=await reviewKevEntries(input(f,{fetchImpl:async(_url,{body})=>{
  const response=official(JSON.parse(body));response.model='jev-other';return new Response(JSON.stringify(response));
 }}));
 assert.equal(wrong.status,'hold');assert.deepEqual(wrong.approvedPairs,[]);
 const snapshot=structuredClone(f.snapshot);snapshot.kevEntry.provider='codex-cli';
 const mismatch=await reviewKevEntries(input(f,{snapshot,fetchImpl:()=>assert.fail('must not invoke')}));
 assert.equal(mismatch.reason,'DECISION_PROVIDER_SNAPSHOT_MISMATCH');
});
test('key decryption consumes original entry budget and cannot retimestamp stale evidence',async t=>{
 freeze(t);const f=await buildKevFlowBridgePlan({coherent:true,provider:'jev'});let at=f.now;
 const review=await reviewKevEntries(input(f,{now:()=>at,credentialFn:async()=>{at+=60000;return 'synthetic-private-key';},
  fetchImpl:()=>assert.fail('expired evidence must not invoke')}));
 assert.equal(review.status,'hold');assert.equal(review.requestAttempted,false);
 assert.deepEqual(review.approvedPairs,[]);assert.equal(review.reason,'JEV_TIMEOUT');
});

test('Jev gives q0 unique priority and preserves ordered alternatives with partial tape evidence',async t=>{
 freeze(t);const f=await buildKevFlowBridgePlan({coherent:true,provider:'jev'});
 const snapshot=structuredClone(f.snapshot),pairs=f.policy.pairs.slice(0,3);
 assert.equal(pairs.length,3);
 snapshot.markets=pairs.map(pair=>{
  const market=structuredClone(f.snapshot.markets[0]);market.pair=pair;market.entryCost.pair=pair;market.orderFlow.pair=pair;
  market.orderFlow.trades=market.orderFlow.trades.flatMap((trade,index)=>
   Array.from({length:3},(_,offset)=>({...trade,a:index*3+offset+1})));
  return market;
 });
 snapshot.evidence=pairs.map(pair=>({id:'spot:'+pair,status:'ok',data:{pair}}));
 const reference=kevFlowReference(snapshot,f.policy,f.account,{now:f.now});
 let sentRequest;
 const review=await reviewKevEntries(input(f,{snapshot,reference,fetchImpl:async(_url,{body})=>{
  sentRequest=JSON.parse(body);return new Response(JSON.stringify(official(sentRequest)));
 }}));
 assert.equal(review.status,'reviewed',review.reason);
 const {state,questions}=sentRequest,criteria=questions.entry.criteria;
 assert.deepEqual(Object.keys(criteria),['q0','q1','q2','hold']);
 assert.deepEqual(state.candidates.map(candidate=>candidate.id),['q0','q1','q2']);
 assert.equal(Object.values(criteria).filter(text=>text.includes('first host-ranked candidate')).length,1);
 for(const candidate of state.candidates){
  assert.ok(criteria[candidate.id].includes(candidate.pair+' / '+candidate.action));
  if(candidate.id!=='q0'){
   assert.match(criteria[candidate.id],/every preceding candidate is blocked and this candidate is not/);
   assert.doesNotMatch(criteria[candidate.id],/first host-ranked|select by default|top host-ranked/i);
  }
  assert.equal(candidate.stopFraction,.005);assert.equal(candidate.maxHoldingSeconds,900);
  assert.equal(candidate.entrySignal.eligible,true);
 }
 for(const market of state.markets){
  assert.equal(market.orderFlow.rawTradeSampleIsComplete,false);
  assert.equal(market.orderFlow.recentTradeSample.length,8);
 }
 assert.equal(state.rewardEvidence.expectedEdge,null);
 assert.equal(state.rewardEvidence.holdingHorizon.attainmentProbability,null);
 assert.equal(state.rewardEvidence.holdingHorizon.forecast,false);
 assert.equal(state.snapshotId,snapshot.id);
 assert.ok(Buffer.byteLength(JSON.stringify(sentRequest))<=32768);
});
