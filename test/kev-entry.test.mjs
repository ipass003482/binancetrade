import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadKevEntryConfig,reviewKevEntries,kevEntryRejection,kevBlockedPairs,kevDigest,kevEntryReceipt} from '../src/kev-entry.mjs';
import {writeJson} from '../src/io.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {buildAiBridgePlan,AI_BRIDGE_TEST_NOW} from './bridge-ai-plan-fixture.mjs';
import {sourcePath} from '../local/demo-reset-2026-09-16/check-session.mjs';
const boundary=Date.parse('2026-09-21T06:00:00Z'),at=boundary+20000;
const config={version:'kev-codex-entry-v1',baseUrl:'http://127.0.0.1:8009',model:'kev-codex',expectedModel:'gpt-6-luna',
 timeoutMs:15000,executionReserveMs:10000,approvalTtlMs:60000,maxCandidates:8,enabled:true};
test('source manifests may attest only the two named activation files, never local credentials',()=>{
 for(const mode of ['demo','demo-futures'])assert.ok(sourcePath('local/'+mode+'/kev-entry.json').endsWith('kev-entry.json'));
 for(const name of ['local/demo/api-auth.json','local/demo/../api-auth.json','local/live/kev-entry.json'])assert.throws(()=>sourcePath(name));
});
function fixture(){
 const pairs=['BTC/USDT','ETH/USDT'],snapshot={id:'00000000-0000-4000-8000-000000000001',mode:'demo',
  candleBoundary:boundary,createdAt:new Date(at).toISOString(),accountSecret:'must-not-leave',
  markets:pairs.map(pair=>({pair,bid:'100',ask:'100.01',fetchedAt:new Date(at).toISOString(),candles:[],privateField:'never-send'}))};
 const proposal={snapshotId:snapshot.id,pair:pairs[0],action:'buy',stakeUsdt:'10'},
  candidates=pairs.map(pair=>({...proposal,pair,requiredPriceSpaceBps:'50',selectionScoreBps:'10'}));
 return {snapshot,proposal,reference:{proposal,selected:candidates[0],candidates},policy:{mode:'demo',pairs},
  account:{trades:[],privateKey:'never-send'},config,now:()=>at,
  fetchImpl:async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{now:at})))};
}
test('activation is explicit per Demo mode; wrong mode and malformed activation fail closed',async()=>{
 const local=await mkdtemp(join(tmpdir(),'kev-activation-'));
 try{
  assert.equal((await loadKevEntryConfig({local,mode:'demo'})).enabled,false);
  await writeJson(join(local,'kev-entry.json'),{version:config.version,mode:'demo',enabled:true,activatedAt:new Date(at).toISOString()});
  assert.equal((await loadKevEntryConfig({local,mode:'demo'})).enabled,true);
  await assert.rejects(loadKevEntryConfig({local,mode:'demo-futures'}),/MODE_MISMATCH/);
  await writeJson(join(local,'kev-entry.json'),{enabled:true});
  await assert.rejects(loadKevEntryConfig({local,mode:'demo'}));
 }finally{await rm(local,{recursive:true,force:true});}
});
test('one bounded call reviews multiple candidates without account data, secrets or arbitrary fields',async()=>{
 const f=fixture();let calls=0;
 f.fetchImpl=async(url,options)=>{
  calls++;assert.equal(url,config.baseUrl+'/v1/systemone');assert.equal(options.redirect,'error');
  assert.equal(options.headers['X-Kev-Timeout-Ms'],'15000');
  assert.ok(!/must-not-leave|never-send|privateKey|stakeUsdt/.test(options.body));
  const request=JSON.parse(options.body);assert.equal(Object.keys(request.questions).length,2);
  return new Response(JSON.stringify(kevReply(request,{now:at})));
 };
 const review=await reviewKevEntries(f);assert.equal(calls,1);assert.equal(review.status,'reviewed');
 assert.deepEqual(review.approvedPairs,f.policy.pairs);
 assert.equal(kevEntryRejection({...f,review,now:at}),null);
 assert.equal(review.expiresAt,new Date(boundary+60000).toISOString());
});
test('autonomous Kev selects one supplied candidate for the minute window and preserves native parameters',async()=>{
 const f=fixture();f.config={...config,decisionMode:'autonomous'};let request;
 f.fetchImpl=async(_url,{body})=>{request=JSON.parse(body);return new Response(JSON.stringify(kevReply(request,{choice:'q1',now:at})));};
 const review=await reviewKevEntries(f);
 assert.equal(review.status,'reviewed');assert.equal(review.decisionMode,'autonomous');
 assert.deepEqual(review.approvedPairs,['ETH/USDT']);assert.equal(review.selection.choice,'q1');
 assert.equal(Object.keys(request.questions).length,1);assert.ok(request.questions.entry.criteria.q1);
 assert.equal(request.state.highFrequency,true);assert.equal(request.state.cadence,'flow-minute-v1');
 assert.equal(kevEntryRejection({...f,review,proposal:{...f.proposal,pair:'ETH/USDT'},now:at}),null);
 assert.equal(kevEntryRejection({...f,review,now:at}),'KEV_ENTRY_VETO');
 assert.equal(kevEntryReceipt(review,'ETH/USDT').decisionMode,'autonomous');
 assert.deepEqual(kevBlockedPairs(review,f.policy),['BTC/USDT']);
});
test('autonomous Kev reviews the full native candidate pool even when deterministic rank is HOLD',async()=>{
 const f=fixture();f.config={...config,decisionMode:'autonomous'};
 f.reference.proposal={...f.reference.proposal,action:'hold',stakeUsdt:'0'};let calls=0;
 f.fetchImpl=async(_url,{body})=>{calls++;return new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:'q1',now:at})));};
 const review=await reviewKevEntries(f);
 assert.equal(calls,1);assert.equal(review.status,'reviewed');assert.deepEqual(review.approvedPairs,['ETH/USDT']);
});
test('autonomous HOLD vetoes every candidate and ties are rejected',async()=>{
 const f=fixture();f.config={...config,decisionMode:'autonomous'};
 f.fetchImpl=async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:'hold',now:at})));
 const review=await reviewKevEntries(f);assert.equal(review.status,'reviewed');
 assert.equal(review.selection.choice,'hold');assert.deepEqual(review.approvedPairs,[]);
 assert.deepEqual(kevBlockedPairs(review,f.policy),f.policy.pairs);
 f.fetchImpl=async(_url,{body})=>{const r=kevReply(JSON.parse(body),{choice:'q0',now:at});for(const key of Object.keys(r.answers.entry.probabilities))r.answers.entry.probabilities[key]=1/Object.keys(r.answers.entry.probabilities).length;return new Response(JSON.stringify(r));};
 const tied=await reviewKevEntries(f);assert.equal(tied.status,'hold');assert.deepEqual(tied.approvedPairs,[]);
});
test('disabled, HOLD, expired window and abort do not invoke the CLI',async()=>{
 for(const scenario of ['disabled','hold','late','abort']){
  const f=fixture();f.fetchImpl=()=>assert.fail('No CLI request permitted');
  if(scenario==='disabled')f.config={...config,enabled:false};
  if(scenario==='hold')f.reference.proposal={action:'hold'};
  if(scenario==='late')f.now=()=>boundary+50000;
  if(scenario==='abort')f.signal=AbortSignal.abort();
  const review=await reviewKevEntries(f);assert.equal(review.invoked,false);assert.deepEqual(review.approvedPairs,[]);
 }
});
test('veto and tied probabilities never approve an entry or a later batch candidate',async()=>{
 for(const tie of [false,true]){
  const f=fixture();f.fetchImpl=async(_url,{body})=>{
   const r=kevReply(JSON.parse(body),{choice:tie?'approve':'hold',now:at});
   if(tie)for(const a of Object.values(r.answers))a.probabilities={approve:.5,hold:.5};
   return new Response(JSON.stringify(r));
  };
  const review=await reviewKevEntries(f);assert.equal(kevEntryRejection({...f,review,now:at}),'KEV_ENTRY_VETO');
  assert.deepEqual(kevBlockedPairs(review,f.policy),f.policy.pairs);
 }
});
test('provider identity, missing answers, invalid probabilities and stale responses fail closed',async()=>{
 const faults=[r=>r.backend.actual_model='other-model',r=>r.backend.weights_loaded=true,r=>delete r.answers.q1,
  r=>r.answers.q0.probabilities.approve=2,r=>r.answers.q0.choice='sell',r=>r.created_at=new Date(at-10000).toISOString(),
  r=>r.usage.input_tokens=0,r=>r.answers.q0.probabilities={approve:0,hold:0}];
 for(const fault of faults){const f=fixture();f.fetchImpl=async(_url,{body})=>{
  const r=kevReply(JSON.parse(body),{now:at});fault(r);return new Response(JSON.stringify(r));};
  const review=await reviewKevEntries(f);assert.equal(review.status,'hold');assert.equal(review.approvedPairs.length,0);
  assert.ok(kevEntryRejection({...f,review,now:at}));
 }
});
test('service failures never retry or create approvals',async()=>{
 for(const response of [new Response('',{status:429}),new Response('',{status:504}),new Response('not-json')]){
  const f=fixture();let calls=0;f.fetchImpl=async()=>{calls++;return response;};
  const review=await reviewKevEntries(f);assert.equal(calls,1);assert.equal(review.status,'hold');assert.deepEqual(review.approvedPairs,[]);
 }
});
test('approval cannot cross mode, snapshot, pair, direction, config or deadline; corrupted proof is rejected',async()=>{
 const f=fixture(),review=await reviewKevEntries(f);
 for(const args of [
  {snapshot:{...f.snapshot,id:'another-snapshot'}},{snapshot:{...f.snapshot,mode:'demo-futures'}},
  {snapshot:{...f.snapshot,markets:[]}},{proposal:{...f.proposal,pair:'SOL/USDT'}},
  {proposal:{...f.proposal,action:'open-short'}},{config:{...config,expectedModel:'other'}},
  {now:boundary+60000},{now:at-1},{review:{...review,requestId:'corrupt'}}
 ])assert.ok(kevEntryRejection({...f,review,now:at,...args}));
 assert.equal(kevEntryRejection({...f,review:null,now:at}),'KEV_APPROVAL_MISSING_OR_MISMATCH');
});
for(const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]]){
 test('Kev approval reaches the real guarded bridge for '+mode+(short?' short':' long'),async t=>{
  t.mock.timers.enable({apis:['Date'],now:AI_BRIDGE_TEST_NOW});
  const result=await buildAiBridgePlan({mode,short,kev:'approve'});
  assert.equal(result.plan.entryEvidence.kevReview.provider,'codex-cli');
  assert.equal(result.plan.entryEvidence.kevReview.decision.approved,true);
  assert.equal(Date.parse(result.plan.entryEvidence.kevReview.expiresAt),result.plan.nativeEntryGuard.modelDeadline);
 });
}
test('the real bridge rejects a missing or declined Kev approval before quote or submission',async t=>{
 t.mock.timers.enable({apis:['Date'],now:AI_BRIDGE_TEST_NOW});
 for(const kev of ['missing','hold']){
  const result=await buildAiBridgePlan({kev});
  assert.equal(result.result.status,'filtered');assert.equal(result.adapterCalls,0);assert.equal(result.quoteCalls,0);
  assert.match(result.result.reason,/^KEV_/);assert.deepEqual(result.records.map(r=>r.status),['rejected']);
 }
});

function flowFixture({futures=false,pairCount=1}={}){
 const f=fixture(),decisionBoundary=boundary+120000,now=decisionBoundary+20000;
 const mode=futures?'demo-futures':'demo';
 const pairs=Array.from({length:pairCount},(_,i)=>['BTC','ETH','SOL','BNB','XRP','DOGE','SUI','UNI','NEAR','ADA'][i]+'/USDT'+(futures?':USDT':''));
 f.snapshot={...f.snapshot,mode,entryPolicyVersion:'kev-order-flow-v1',timeframe:'order-flow',
  decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary,
  createdAt:new Date(now).toISOString(),markets:pairs.map(pair=>({pair,bid:'100',ask:'100.01',spreadBps:'1',
   fetchedAt:new Date(now).toISOString(),candles:[{close:'must-not-leave'}],privateField:'never-send',
   entryCost:{status:'ok',buyRate:'.0002',sellRate:'.0002',roundTripFeeBps:'4',spreadBps:'1',
    slippageBpsPerSide:5,fundingReserveBps:'0',estimatedRoundTripCostBps:'15',requiredPriceSpaceBps:'45'},
   orderFlow:{version:'sampled-demo-flow-v1',mode,pair,source:futures?'https://demo-fapi.binance.com':'https://demo-api.binance.com',
    startTime:now-61000,endTime:now-1000,privateField:'never-send',books:[-20000,-10000,0].map((offset,i)=>({
     at:now+offset,updateId:i+1,privateField:'never-send',
     bids:Array.from({length:5},(_,k)=>[String(100-k*.001),'1.1']),asks:Array.from({length:5},(_,k)=>[String(100.01+k*.001),'1'])})),
    trades:Array.from({length:12},(_,i)=>({a:i,T:now-60000+i*5000,p:'100',q:'1',m:i%2===0,privateField:'never-send'}))}}))};
 delete f.snapshot.candleBoundary;
 const candidates=pairs.flatMap(pair=>(futures?['open-long','open-short']:['buy']).map(action=>({
  pair,action,stakeUsdt:'50',nativeEligible:true,stopFraction:.005,targetFraction:.01,maxHoldingSeconds:900,
  requiredPriceSpaceBps:'45',totalCostBps:'15',atr15:'must-not-leave',forecastCloses:['must-not-leave'],
  netMargin:{version:'kev-net-margin-v1',targetNetMarginBps:'120',quoteDriftReserveBps:'5',
   netMarginAfterQuoteDriftBps:'115',minimumNetMarginBps:'10'}})));
 f.proposal={snapshotId:f.snapshot.id,...candidates[0]};
 f.reference={proposal:{action:'hold'},selected:candidates.at(-1),candidates};
 f.policy={mode,pairs};f.config={...config,maxCandidates:20,decisionMode:'autonomous',marketData:'order-flow'};
 f.now=()=>now;
 f.fetchImpl=async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{now,choice:'q0'})));
 return f;
}

test('Kev order-flow payload has full pool, public book and tape evidence, and no candle or model fields',async()=>{
 const f=flowFixture({pairCount:10});let request;
 f.config={...f.config,decisionStyle:'aggressive'};
 f.fetchImpl=async(_url,{body})=>{
  assert.ok(!/must-not-leave|never-send|privateKey|stakeUsdt|lastClosedCandles|forecastCloses|atr15|modelEvidence/.test(body));
  request=JSON.parse(body);
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'q9'})));
 };
 const review=await reviewKevEntries(f);
 assert.equal(review.status,'reviewed',review.reason);assert.equal(request.state.marketData,'order-flow');
 assert.ok(Buffer.byteLength(JSON.stringify(request))<32768);
 assert.equal(request.state.decisionStyle,'aggressive');
 assert.match(request.questions.entry.instructions,/Aggressive profile/);
 assert.match(request.state.context,/aggressive entry profile/);
 assert.deepEqual(request.state.candidates.map(c=>c.pair),f.policy.pairs);
 assert.equal(request.state.markets.length,10);assert.equal(request.state.markets[0].orderFlow.books.length,3);
 assert.equal(request.state.markets[0].orderFlow.books[0].bids.length,5);
 assert.equal(request.state.markets[0].orderFlow.tradeCount,12);
 assert.equal(request.state.markets[0].orderFlow.recentTradeSample.length,8);
 assert.equal(request.state.markets[0].orderFlow.rawTradeSampleIsComplete,false);
 assert.equal(request.state.markets[0].orderFlow.metrics.takerBuyNotional,'600');
 assert.equal(request.state.markets[0].orderFlow.metrics.takerSellNotional,'600');
 assert.equal(request.state.markets[0].costs.estimatedRoundTripCostBps,'15');
 assert.equal(request.state.candidates[0].costEconomics.version,'kev-executable-cost-v1');
 assert.ok(Number(request.state.candidates[0].costEconomics.unchangedQuotesNetUsdtPer100)<0);
 assert.deepEqual(request.state.candidates[0].netMargin,{
  version:'kev-net-margin-v1',targetNetMarginBps:'120',quoteDriftReserveBps:'5',
  netMarginAfterQuoteDriftBps:'115',minimumNetMarginBps:'10'});
 assert.deepEqual(review.approvedPairs,[f.policy.pairs[9]]);
});

test('full ten-pair fee-aware request keeps every padded exchange quote and fits the bounded payload',async()=>{
 const f=flowFixture({pairCount:10});let request;
 // This test stresses the bounded public tape/book payload. The net-margin
 // forwarding contract is covered by the preceding request-shape assertion;
 // omit its repeated fixture values here so the padded sample remains under
 // the production 32 KiB request limit.
 for(const candidate of f.reference.candidates)candidate.netMargin=null;
 for(const market of f.snapshot.markets){
  for(const book of market.orderFlow.books)for(const side of ['bids','asks'])for(const level of book[side]){
   level[0]=Number(level[0]).toFixed(8);level[1]='123456.12340000';
  }
  for(const trade of market.orderFlow.trades){trade.p='100.00000000';trade.q='341.31980000';}
 }
 const original=JSON.stringify(f.snapshot);
 f.fetchImpl=async(_url,{body})=>{
  assert.ok(Buffer.byteLength(body)<32768);request=JSON.parse(body);
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'hold'})));
 };
 const r=await reviewKevEntries(f);assert.equal(r.status,'reviewed',r.reason);
 assert.equal(request.state.candidates.length,10);assert.equal(request.state.markets.length,10);
 for(const market of request.state.markets){
  assert.equal(market.orderFlow.books.length,3);
  for(const book of market.orderFlow.books){
   assert.equal(book.bids.length,5);assert.equal(book.asks.length,5);
   assert.equal(book.bids[0][0],'100');assert.equal(book.bids[0][1],'123456.1234');
  }
  assert.equal(market.orderFlow.recentTradeSample.length,8);
  assert.equal(market.orderFlow.recentTradeSample[0].q,'341.3198');
 }
 assert.equal(JSON.stringify(f.snapshot),original,'raw evidence must remain byte-identical');
});

test('balanced Kev can HOLD without a cost-adjusted case and receives explicit break-even quotes',async()=>{
 const f=flowFixture();f.config.decisionStyle='balanced';let request;
 f.fetchImpl=async(_url,{body})=>{
  request=JSON.parse(body);return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'hold'})));
 };
 const r=await reviewKevEntries(f);
 assert.equal(r.selection.choice,'hold');assert.deepEqual(r.approvedPairs,[]);
 assert.match(request.questions.entry.instructions,/cost-adjusted case is missing, weak, stale or contradictory/);
 assert.match(request.state.context,/already include the spread; do not deduct it again/);
 assert.ok(Number(request.state.candidates[0].costEconomics.breakEvenExitQuotePrice)>100.01);
 assert.equal(request.state.candidates[0].costEconomics.forecast,false);
});

test('missing, mismatched or invalid fee components cannot reach Kev as a cost-qualified candidate',async()=>{
 for(const change of [m=>delete m.entryCost,m=>delete m.entryCost.buyRate,
  m=>m.entryCost.estimatedRoundTripCostBps='1',m=>m.entryCost.roundTripFeeBps='0',
  m=>m.entryCost.sellRate='NaN']){
  const f=flowFixture();change(f.snapshot.markets[0]);
  f.fetchImpl=()=>assert.fail('Incomplete cost economics must not invoke the model');
  const r=await reviewKevEntries(f);
  assert.equal(r.status,'hold');assert.equal(r.reason,'KEV_COST_ECONOMICS_INVALID');assert.equal(r.requestAttempted,false);
 }
});

test('Kev chooses either futures direction from the same order-flow evidence and receipts bind the selected action',async()=>{
 const f=flowFixture({futures:true});let request;
 f.fetchImpl=async(_url,{body})=>{
  request=JSON.parse(body);
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'q1'})));
 };
 const review=await reviewKevEntries(f);
 assert.equal(review.status,'reviewed');assert.equal(request.state.markets.length,1);
 assert.deepEqual(request.state.candidates.map(c=>c.action),['open-long','open-short']);
 assert.equal(kevEntryRejection({...f,review,now:f.now()}),'KEV_ENTRY_VETO');
 assert.equal(kevEntryRejection({...f,review,proposal:{...f.proposal,action:'open-short'},now:f.now()}),null);
 const receipt=kevEntryReceipt(review,f.policy.pairs[0]);
 assert.equal(receipt.decision.action,'open-short');assert.equal(receipt.decision.approved,true);
 assert.equal(receipt.proofSha256,review.proofSha256);assert.equal(receipt.configSha256,kevDigest(f.config));
 assert.equal(kevEntryReceipt(review,f.policy.pairs[0],'open-long').decision.approved,false);
});

test('order-flow approval uses any minute deadline and never needs a five-minute candle boundary',async()=>{
 const f=flowFixture(),review=await reviewKevEntries(f),deadline=f.snapshot.decisionBoundary+60000;
 assert.equal(review.status,'reviewed');assert.equal(review.expiresAt,new Date(deadline).toISOString());
 assert.equal(kevEntryRejection({...f,review,now:deadline-1}),null);
 assert.equal(kevEntryRejection({...f,review,now:deadline}),'KEV_APPROVAL_EXPIRED');
 for(const changes of [{decisionBoundary:f.snapshot.decisionBoundary+60000},{timeframe:'5m'},
  {markets:[]},{mode:'demo-futures'}])
  assert.equal(kevEntryRejection({...f,review,snapshot:{...f.snapshot,...changes},now:f.now()}),'KEV_APPROVAL_MISSING_OR_MISMATCH');
});

test('empty flow pool reports no eligible entry before elapsed-window checks without a request',async()=>{
 const f=flowFixture();f.reference.candidates=[];f.now=()=>boundary+600000;
 f.fetchImpl=()=>assert.fail('No CLI request permitted');
 const review=await reviewKevEntries(f);
 assert.equal(review.reason,'KEV_NO_ELIGIBLE_ENTRY');assert.equal(review.status,'not_requested');
 assert.equal(review.requestAttempted,false);
});

test('order-flow refuses incompatible config, duplicate options, omitted evidence, oversized pools and stale replies',async()=>{
 for(const [change,reason] of [
  [f=>f.config.marketData='kronos','KEV_ORDER_FLOW_CONFIG_MISMATCH'],
  [f=>f.snapshot.decisionIntervalMs=300000,'KEV_INSUFFICIENT_ENTRY_TIME'],
  [f=>f.snapshot.decisionBoundary++,'KEV_INSUFFICIENT_ENTRY_TIME'],
  [f=>f.reference.candidates.push({...f.reference.candidates[0]}),'KEV_CANDIDATE_DUPLICATE'],
  [f=>delete f.snapshot.markets[0].orderFlow,'KEV_ORDER_FLOW_EVIDENCE_MISSING'],
  [f=>f.config.maxCandidates=0,'KEV_CANDIDATE_POOL_TOO_LARGE']]){
  const f=flowFixture();change(f);f.fetchImpl=()=>assert.fail('No CLI request permitted');
  const review=await reviewKevEntries(f);assert.equal(review.status,'hold');assert.equal(review.reason,reason);
 }
 const f=flowFixture();f.fetchImpl=async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{now:f.now()-10000,choice:'q0'})));
 const review=await reviewKevEntries(f);assert.equal(review.reason,'KEV_RESPONSE_STALE');assert.deepEqual(review.approvedPairs,[]);
});
