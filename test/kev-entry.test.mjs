import {KEV_NET_HARVEST_POLICY} from '../src/kev-exit-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
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
test('Kev configuration may allow a longer inference cap without changing the native execution reserve',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kev-timeout-cap-'));
 try{
  await mkdir(join(root,'config'));
  const {enabled,...source}=config;
  await writeJson(join(root,'config','kev-entry.json'),{...source,timeoutMs:40000});
  const loaded=await loadKevEntryConfig({local:root,mode:'demo',root});
  assert.equal(loaded.timeoutMs,40000);
  assert.equal(loaded.executionReserveMs,10000);
  await writeJson(join(root,'config','kev-entry.json'),{...source,timeoutMs:40001});
  await assert.rejects(loadKevEntryConfig({local:root,mode:'demo',root}));
 }finally{await rm(root,{recursive:true,force:true});}
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

function flowFixture({futures=false,pairCount=1,atMs=20000}={}){
 const f=fixture(),decisionBoundary=boundary+120000,now=decisionBoundary+atMs;
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
  pair,action,stakeUsdt:'50',nativeEligible:true,stopFraction:.005,targetFraction:.01,maxHoldingSeconds:900,exitPolicy:{...KEV_NET_HARVEST_POLICY},
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

test('balanced Kev sees the bounded eligible pool and receives auditable cost and flow fields',async()=>{
 const f=flowFixture({pairCount:10});let request;
 f.config={...f.config,decisionStyle:'balanced'};
 f.fetchImpl=async(_url,{body})=>{
  assert.ok(!/must-not-leave|never-send|privateKey|stakeUsdt|lastClosedCandles|forecastCloses|atr15|modelEvidence/.test(body));
  request=JSON.parse(body);
   return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:request.state.candidates.at(-1).id})));
 };
 const review=await reviewKevEntries(f);
 assert.equal(review.status,'reviewed',review.reason);assert.equal(request.state.marketData,'order-flow');
 assert.ok(Buffer.byteLength(JSON.stringify(request))<32768);
 assert.equal(request.state.decisionStyle,'balanced');
 assert.match(request.questions.entry.instructions,/成本空間不足，可選 hold/);
 assert.match(request.state.role,/證據不足或矛盾時可選 HOLD/);
 assert.match(request.state.context,/只有方向證據一致、資料仍新鮮、且明示的成本後空間足夠時/);
 assert.match(request.state.context,/不得另造數值門檻或重算系統數值/);
 assert.match(request.state.context,/不能當成預期報酬或勝率/);
 assert.match(request.questions.entry.instructions,/不得為了交易筆數勉強進場/);
 assert.doesNotMatch(request.state.context,/choice 欄位|q0、q1、q2/);
 assert.equal(request.state.requestVersion,'kev-flow-request-v4');
  const presented=request.state.candidates.length;
  assert.ok(presented>0&&presented<=10);
  assert.deepEqual(request.state.candidates.map(c=>c.pair),f.policy.pairs.slice(0,presented));
  assert.equal(request.state.markets.length,presented);assert.equal(request.state.markets[0].orderFlow.books.length,2);
 assert.equal(request.state.markets[0].orderFlow.books[0].bids.length,5);
 assert.equal(request.state.markets[0].orderFlow.tradeCount,12);
 assert.equal(request.state.markets[0].orderFlow.recentTradeSample.length,8);
 assert.equal(request.state.markets[0].orderFlow.rawTradeSampleIsComplete,false);
 assert.equal(request.state.markets[0].orderFlow.metrics.takerBuyNotional,'600');
 assert.equal(request.state.markets[0].orderFlow.metrics.takerSellNotional,'600');
 assert.equal(request.state.markets[0].costs.estimatedRoundTripCostBps,'15');
 assert.equal(request.state.candidates[0].costEconomics.version,'kev-executable-cost-v1');
 assert.equal(request.state.rewardEvidence.version,'kev-reward-evidence-v1');
 assert.equal(request.state.rewardEvidence.plannedTargetSource,'fixed_exit_geometry');
 assert.equal(request.state.rewardEvidence.expectedEdge,null);
 assert.deepEqual(request.state.rewardEvidence.holdingHorizon,{version:'kev-cost-horizon-v1',
  maxHoldingSecondsSource:'candidate.maxHoldingSeconds',attainmentProbability:null,forecast:false});
 const horizon=request.state.candidates[0].costEconomics.holdingHorizon;
 assert.equal(request.state.candidates[0].maxHoldingSeconds,900);
 assert.deepEqual(Object.keys(horizon.netUsdtPer100ByFavorableExitMoveBps),['0','10','20','30']);
 assert.match(request.state.context,/固定目標情境，不是預期報酬/);
 assert.match(request.state.context,/900 秒退出仍可能虧損/);
 assert.match(request.state.context,/不因缺少校準預測而一律 HOLD/);
 assert.match(request.state.context,/不得外推短期觀察/);
 assert.ok(Number(request.state.candidates[0].costEconomics.unchangedQuotesNetUsdtPer100)<0);
 assert.deepEqual(request.state.candidates[0].netMargin,{
  version:'kev-net-margin-v1',targetNetMarginBps:'120',quoteDriftReserveBps:'5',
  netMarginAfterQuoteDriftBps:'115',minimumNetMarginBps:'10'});
  assert.deepEqual(review.approvedPairs,[f.policy.pairs[presented-1]]);
 assert.equal(review.decisionDiagnostics.qualifiedCandidateCount,10);
  assert.equal(review.decisionDiagnostics.presentedCandidateCount,presented);
 assert.equal(review.decisionDiagnostics.kevSelectedQualified,true);
 assert.equal(review.decisionDiagnostics.dataFreshness[0].quoteAgeMs,0);
 assert.ok(!Object.hasOwn(request.state.candidates[0],'__qualifiedCandidateCount'));
});

test('balanced shortlist puts lower required cost first and exposes the rank evidence to Kev',async()=>{
 const f=flowFixture({pairCount:10});let request;
 f.config={...f.config,decisionStyle:'balanced',maxCandidates:3};
 for(const candidate of f.reference.candidates){
  candidate.requiredPriceSpaceBps=candidate.pair==='ETH/USDT'?'30':candidate.pair==='BNB/USDT'?'40':'50';
 }
 f.fetchImpl=async(_url,{body})=>{request=JSON.parse(body);return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'q0'})));};
 const review=await reviewKevEntries(f);
 assert.equal(review.status,'reviewed',review.reason);
 assert.deepEqual(request.state.candidates.map(c=>c.pair),['ETH/USDT','BNB/USDT','BTC/USDT']);
 assert.deepEqual(request.state.candidates.map(c=>c.flowShortlist.requiredPriceSpaceBps),['30','40','50']);
 assert.ok(request.state.candidates.every(c=>c.flowShortlist.version==='kev-flow-shortlist-v2'));
 assert.deepEqual(review.approvedPairs,['ETH/USDT']);
});

function padExchangeEvidence(f){
 for(const market of f.snapshot.markets){
  for(const book of market.orderFlow.books)for(const side of ['bids','asks'])for(const level of book[side]){
   level[0]=Number(level[0]).toFixed(8);level[1]='123456.12340000';
  }
  for(const trade of market.orderFlow.trades){trade.p='100.00000000';trade.q='341.31980000';}
 }
 return f;
}

test('ten-pair production costs preserve full offered evidence and prune only the weakest byte-budget suffix',async()=>{
 const f=padExchangeEvidence(flowFixture({pairCount:10}));let request;
 const original=JSON.stringify(f.snapshot),originalReference=JSON.stringify(f.reference);
 f.reference.metadata={candidateDiagnostics:{total:10,eligible:10,blocked:0,candidates:f.reference.candidates.map(c=>({pair:c.pair,action:c.action}))}};
 const fullDiagnostics=structuredClone(f.reference.metadata.candidateDiagnostics);
 f.fetchImpl=async(_url,{body})=>{
  assert.ok(Buffer.byteLength(body)<=32768);request=JSON.parse(body);
  assert.ok(!/requestBudget|omittedCandidateCount|qualifiedBeforeBudget/.test(body),'budget diagnostics stay in sealed local audit');
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:request.state.candidates.at(-1).id})));
 };
 const r=await reviewKevEntries(f);assert.equal(r.status,'reviewed',r.reason);
 const count=request.state.candidates.length;
 assert.ok(count>0&&count<10,'real netMargin fields and padded exchange values must trigger bounded pruning');
 assert.equal(request.state.markets.length,count);
 assert.deepEqual(request.state.candidates.map(c=>c.id),Array.from({length:count},(_,i)=>'q'+i));
 assert.deepEqual(request.state.candidates.map(c=>c.pair),f.policy.pairs.slice(0,count));
 assert.deepEqual(request.state.markets.map(m=>m.pair),f.policy.pairs.slice(0,count));
 assert.ok(request.state.candidates.every(c=>c.netMargin?.version==='kev-net-margin-v1'&&c.costEconomics.holdingHorizon));
 assert.deepEqual(r.approvedPairs,[f.policy.pairs[count-1]]);
 assert.equal(kevEntryRejection({...f,review:r,proposal:{...f.proposal,pair:f.policy.pairs[count-1]},now:f.now()}),null);
 assert.equal(kevEntryRejection({...f,review:r,proposal:{...f.proposal,pair:f.policy.pairs[count]},now:f.now()}),'KEV_ENTRY_VETO');
 assert.equal(r.requestMetrics.qualifiedBeforeBudget,10);
 assert.equal(r.requestMetrics.presentedCandidateCount,count);
 assert.equal(r.requestMetrics.omittedCandidateCount,10-count);
 assert.equal(r.requestMetrics.omissionReason,'KEV_REQUEST_BYTE_BUDGET');
 assert.equal(r.decisionDiagnostics.qualifiedCandidateCount,10);
 assert.equal(r.decisionDiagnostics.presentedCandidateCount,count);
 assert.deepEqual(r.decisionDiagnostics.requestBudget,Object.fromEntries(Object.entries(r.requestMetrics).filter(([key])=>['version','maxPayloadBytes','qualifiedBeforeBudget','presentedCandidateCount','omittedCandidateCount','omissionReason'].includes(key))));
 assert.deepEqual(r.candidateDiagnostics,fullDiagnostics);
 for(const market of request.state.markets){
  assert.equal(market.orderFlow.books.length,2);
  for(const book of market.orderFlow.books){
   assert.equal(book.bids.length,5);assert.equal(book.asks.length,5);
   assert.equal(book.bids[0][0],'100');assert.equal(book.bids[0][1],'123456.1234');
  }
  assert.equal(market.orderFlow.recentTradeSample.length,8);
  assert.equal(market.orderFlow.recentTradeSample[0].q,'341.3198');
 }
 assert.equal(JSON.stringify(f.snapshot),original,'raw evidence must remain byte-identical');
 const {metadata,...unchangedReference}=f.reference;
 assert.equal(JSON.stringify(unchangedReference),originalReference,'candidate pool must remain byte-identical');
});

test('byte pruning bounds time by the original oldest offered proof and never includes unused market evidence',async()=>{
 const f=padExchangeEvidence(flowFixture({pairCount:10,atMs:5000}));let request;
 f.config.timeoutMs=40000;
 for(const b of f.snapshot.markets[0].orderFlow.books)b.at-=5000;
 for(const b of f.snapshot.markets.at(-1).orderFlow.books)b.at-=25000;
 const original=JSON.stringify(f.snapshot);
 f.fetchImpl=async(_url,{body,headers})=>{
  request=JSON.parse(body);assert.equal(headers['X-Kev-Timeout-Ms'],'29000');
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'q0'})));
 };
 const r=await reviewKevEntries(f);assert.equal(r.status,'reviewed',r.reason);
 assert.ok(r.requestMetrics.omittedCandidateCount>0);
 assert.ok(!request.state.markets.some(m=>m.pair===f.policy.pairs.at(-1)));
 assert.equal(r.requestMetrics.flowEvidenceDeadlineAt,new Date(f.now()+40000).toISOString());
 assert.equal(r.requestMetrics.effectiveDeadlineAt,r.requestMetrics.flowEvidenceDeadlineAt);
 assert.equal(r.requestMetrics.executionReserveMs,10000);
 assert.equal(JSON.stringify(f.snapshot),original);
});

test('Futures byte pruning preserves shared markets, opposite-side identities and exact answer choices',async()=>{
 const f=padExchangeEvidence(flowFixture({futures:true,pairCount:10}));let request;
 f.fetchImpl=async(_url,{body})=>{
  request=JSON.parse(body);
  assert.ok(Buffer.byteLength(body)<=32768);
  return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:request.state.candidates.at(-1).id})));
 };
 const r=await reviewKevEntries(f);assert.equal(r.status,'reviewed',r.reason);
 assert.ok(r.requestMetrics.omittedCandidateCount>0);
 assert.deepEqual(request.state.markets.map(m=>m.pair),[...new Set(request.state.candidates.map(c=>c.pair))]);
 const chosen=request.state.candidates.at(-1);
 assert.equal(r.decisions.at(-1).pair,chosen.pair);assert.equal(r.decisions.at(-1).action,chosen.action);
 assert.equal(kevEntryRejection({...f,review:r,proposal:{...f.proposal,pair:chosen.pair,action:chosen.action},now:f.now()}),null);
 f.fetchImpl=async(_url,{body})=>{
  const reply=kevReply(JSON.parse(body),{now:f.now(),choice:'q0'});
  reply.answers.entry.choice='q19';
  return new Response(JSON.stringify(reply));
 };
 const forged=await reviewKevEntries(f);assert.equal(forged.reason,'KEV_ANSWERS_INVALID');assert.deepEqual(forged.approvedPairs,[]);
});

test('one indivisible oversized candidate explicitly HOLDs without invoking Kev or altering evidence',async()=>{
 const f=flowFixture();f.reference.candidates[0].netMargin.version='x'.repeat(40000);
 const original=JSON.stringify(f);
 f.fetchImpl=()=>assert.fail('an oversized single candidate must not invoke Kev');
 const r=await reviewKevEntries(f);
 assert.equal(r.status,'hold');assert.equal(r.reason,'KEV_REQUEST_TOO_LARGE');assert.equal(r.requestAttempted,false);
 assert.deepEqual(r.approvedPairs,[]);assert.ok(r.requestMetrics.payloadBytes>32768);
 assert.equal(r.requestMetrics.qualifiedBeforeBudget,1);assert.equal(r.requestMetrics.presentedCandidateCount,1);
 assert.equal(r.requestMetrics.omittedCandidateCount,0);assert.equal(r.decisionDiagnostics.holdReason,'KEV_REQUEST_TOO_LARGE');
 assert.equal(JSON.stringify(f),original);
});

test('balanced Kev can HOLD without a cost-adjusted case and receives explicit break-even quotes',async()=>{
 const f=flowFixture();f.config.decisionStyle='balanced';let request;
 f.fetchImpl=async(_url,{body})=>{
  request=JSON.parse(body);return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'hold'})));
 };
 const r=await reviewKevEntries(f);
 assert.equal(r.selection.choice,'hold');assert.deepEqual(r.approvedPairs,[]);
 assert.match(request.questions.entry.instructions,/證據不足、衝突、過期或成本空間不足，可選 hold/);
 assert.equal(r.decisionDiagnostics.qualifiedCandidateCount,1);
 assert.equal(r.decisionDiagnostics.kevSelectedQualified,false);
 assert.equal(r.decisionDiagnostics.holdReason,'KEV_SELECTED_HOLD');
 assert.equal(r.decisionDiagnostics.dataFreshness[0].latestBookAgeMs,0);
 assert.match(request.state.context,/已含價差，不重複扣除/);
 assert.ok(Number(request.state.candidates[0].costEconomics.breakEvenExitQuotePrice)>100.01);
 assert.equal(request.state.candidates[0].costEconomics.forecast,false);
});

test('nonselectable diagnostics cannot inflate the request or leak arbitrary fields, and stay in the local audit',async()=>{
 const f=flowFixture();let request;
 const diagnostics={version:'kev-entry-diagnostics-v1',total:10,eligible:1,blocked:9,hardBlocked:9,softBlocked:0,
  blockers:[{reason:'FLOW_TAPE_BOOK_MISMATCH',count:9,class:'hard',privateKey:'never-send'}],
  candidates:Array.from({length:9},(_,i)=>({pair:'excluded-'+i,action:'hold',privateKey:'never-send',raw:'x'.repeat(4096)})),
  privateKey:'never-send'};
 f.reference.metadata={candidateDiagnostics:diagnostics,shadowCandidates:diagnostics.candidates};
 const unchanged=JSON.stringify(f.reference);
 f.fetchImpl=async(_url,{body})=>{
  assert.ok(Buffer.byteLength(body)<10000);
  assert.doesNotMatch(body,/never-send|excluded-/);
  request=JSON.parse(body);return new Response(JSON.stringify(kevReply(request,{now:f.now(),choice:'q0'})));
 };
 const r=await reviewKevEntries(f);
 assert.equal(r.status,'reviewed',r.reason);
 assert.deepEqual(r.candidateDiagnostics,diagnostics);
 assert.deepEqual(request.state.candidateDiagnostics,{version:diagnostics.version,total:10,eligible:1,blocked:9,hardBlocked:9,softBlocked:0,
  blockers:[{reason:'FLOW_TAPE_BOOK_MISMATCH',count:9,class:'hard'}]});
 assert.equal(request.state.shadowSignalCount,9);assert.equal(Object.hasOwn(request.state,'shadowSignals'),false);
 assert.equal(request.state.markets[0].orderFlow.tradeCount,12);
 assert.equal(request.state.markets[0].orderFlow.recentTradeSample.length,8);
 assert.equal(JSON.stringify(f.reference),unchanged);
});

test('a reviewer timeout retains its exact request and bounded budget without an approval or retry',async()=>{
 const f=flowFixture();let calls=0,requestBody,timeout;
 f.now=()=>f.snapshot.decisionBoundary+36500;
 f.fetchImpl=async(_url,{body,headers})=>{
  calls++;requestBody=body;timeout=headers['X-Kev-Timeout-Ms'];return new Response('',{status:504});
 };
 const r=await reviewKevEntries(f);
 assert.equal(calls,1);assert.equal(r.status,'hold');assert.equal(r.reason,'KEV_TIMEOUT');
 assert.equal(r.invoked,null);assert.equal(r.requestAttempted,true);assert.deepEqual(r.approvedPairs,[]);
 assert.equal(JSON.stringify(r.request),requestBody);
 assert.equal(r.requestMetrics.payloadBytes,Buffer.byteLength(requestBody));
 assert.equal(r.requestMetrics.timeoutMs,12500);assert.equal(timeout,'12500');
 assert.equal(r.requestMetrics.configuredTimeoutMs,15000);assert.equal(r.requestMetrics.executionReserveMs,10000);
 assert.equal(r.requestMetrics.deadlineAt,new Date(f.snapshot.decisionBoundary+60000).toISOString());
 assert.equal(r.decisionDiagnostics.holdReason,'KEV_TIMEOUT');
 assert.equal(r.decisionDiagnostics.kevSelectedQualified,false);
});

test('a longer Kev cap is clipped to the earlier proof or minute deadline with the full execution reserve intact',async()=>{
 for(const [atMs,expectedTimeout] of [[5000,34000],[35000,14000]]){
  const f=flowFixture({atMs});let calls=0;
  f.config={...f.config,timeoutMs:40000};
  f.fetchImpl=async(_url,{headers})=>{
   calls++;assert.equal(headers['X-Kev-Timeout-Ms'],String(expectedTimeout));
   return new Response('',{status:504});
  };
  const review=await reviewKevEntries(f);
  assert.equal(calls,1);
  assert.equal(review.status,'hold');
  assert.equal(review.reason,'KEV_TIMEOUT');
  assert.equal(review.requestMetrics.timeoutMs,expectedTimeout);
  assert.equal(review.requestMetrics.executionReserveMs,10000);
  assert.equal(review.requestMetrics.deadlineAt,new Date(f.snapshot.decisionBoundary+60000).toISOString());
  assert.equal(review.requestMetrics.flowEvidenceDeadlineAt,new Date(f.now()+45000).toISOString());
  assert.equal(review.requestMetrics.effectiveDeadlineAt,new Date(Math.min(f.now()+45000,f.snapshot.decisionBoundary+60000)).toISOString());
  assert.deepEqual(review.approvedPairs,[]);
 }
 const late=flowFixture({atMs:49000});late.config={...late.config,timeoutMs:40000};
 late.fetchImpl=()=>assert.fail('The reviewer cannot consume the native execution reserve');
 const review=await reviewKevEntries(late);
 assert.equal(review.status,'hold');
 assert.equal(review.reason,'KEV_INSUFFICIENT_ENTRY_TIME');
 assert.equal(review.requestAttempted,false);
});

test('the XRP regression cannot spend a minute-only budget on twelve-second-old flow or refresh approved evidence',async()=>{
 const f=flowFixture({atMs:9284}),started=f.now();f.config={...f.config,timeoutMs:40000};
 const proof=f.snapshot.markets[0].orderFlow;
 proof.startTime-=12147;proof.endTime-=12147;
 proof.books.forEach(book=>book.at-=12147);proof.trades.forEach(trade=>trade.T-=12147);
 let clock=started,calls=0;f.now=()=>clock;
 const original=JSON.stringify(f.snapshot);
 f.fetchImpl=async(_url,{body,headers})=>{
  calls++;assert.equal(headers['X-Kev-Timeout-Ms'],'21853');clock=started+34992;
  return new Response(JSON.stringify(kevReply(JSON.parse(body),{now:clock,choice:'q0'})));
 };
 const review=await reviewKevEntries(f);
 assert.equal(calls,1);assert.equal(review.reason,'KEV_RESPONSE_STALE');assert.deepEqual(review.approvedPairs,[]);
 assert.equal(review.requestMetrics.flowEvidenceDeadlineAt,new Date(started-12147+45000).toISOString());
 assert.equal(JSON.stringify(f.snapshot),original);
});

test('proof timing uses the oldest presented candidate, excludes unoffered pairs and rejects insufficient or future evidence',async()=>{
 const f=flowFixture({pairCount:3,atMs:6000}),started=f.now();f.config={...f.config,maxCandidates:2,timeoutMs:40000};
 // Equal ranks retain BTC/ETH. A blocked/nonpresented SOL proof must not
 // constrain the review, while ETH's older proof does constrain both choices.
 f.reference.candidates[2].action='hold';
 f.snapshot.markets[1].orderFlow.books.forEach(book=>book.at-=5000);
 f.snapshot.markets[2].orderFlow.books.forEach(book=>book.at-=40000);
 f.fetchImpl=async(_url,{headers,body})=>{
  assert.equal(headers['X-Kev-Timeout-Ms'],'29000');
  return new Response(JSON.stringify(kevReply(JSON.parse(body),{now:started,choice:'q0'})));
 };
 const r=await reviewKevEntries(f);assert.equal(r.status,'reviewed',r.reason);
 assert.equal(r.requestMetrics.flowEvidenceDeadlineAt,new Date(started+40000).toISOString());
 for(const age of [33000,45000,-1]){
  const next=flowFixture({atMs:6000});next.config={...next.config,timeoutMs:40000};
  next.snapshot.markets[0].orderFlow.books.forEach(book=>book.at-=age);
  next.fetchImpl=()=>assert.fail('Unusable flow lifetime must not consume the model');
  const rejected=await reviewKevEntries(next);assert.equal(rejected.requestAttempted,false);
  assert.equal(rejected.reason,age<0?'KEV_ORDER_FLOW_EVIDENCE_MISSING':'KEV_INSUFFICIENT_ENTRY_TIME');
 }
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
