import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOrderFlow,marketOrderFlow} from '../src/research.mjs';
import {decisionTiming,verifyEntryTiming} from '../src/entry-timing.mjs';
import {verifyScheduledDecision} from '../src/candle-schedule.mjs';
import {clockFixture} from './fixtures.mjs';
const B=Date.parse('2026-09-21T07:11:00Z'),M=60000;
function fixture(mode='demo'){
 const at=B+20000,clock=clockFixture(at,mode),pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT';
 return {id:'kev-minute',entryPolicyVersion:'kev-order-flow-v1',mode,timeframe:'order-flow',
  createdAt:new Date(at).toISOString(),clock,decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:M,
  decisionBoundary:B,markets:[{pair,mode,timeframe:'order-flow'}]};
}
function fetchFixture(mode,calls,{instrument={},quote={},funding={}}={}){
 const futures=mode==='demo-futures';
 return async value=>{
  const url=new URL(String(value));calls.push(url.href);
  let data;
  if(url.pathname.endsWith('/time'))data={serverTime:Date.now()};
  else if(url.pathname.endsWith('/exchangeInfo'))data={symbols:[{symbol:'BTCUSDT',status:'TRADING',
   baseAsset:'BTC',quoteAsset:'USDT',isSpotTradingAllowed:true,contractType:'PERPETUAL',marginAsset:'USDT',filters:[],...instrument}]};
  else if(url.pathname.endsWith('/ticker/bookTicker'))data={symbol:'BTCUSDT',bidPrice:'100',askPrice:'100.01',...quote};
  else if(futures&&url.pathname.endsWith('/premiumIndex'))data={symbol:'BTCUSDT',markPrice:'100',lastFundingRate:'0.0001',nextFundingTime:B+M,...funding};
  else assert.fail('Unexpected data endpoint: '+url.pathname);
  return new Response(JSON.stringify(data));
 };
}
test('Kev flow collection requests zero klines and yields no candle or technical evidence in either Demo mode',async t=>{
 t.mock.timers.enable({apis:['Date'],now:B+20000});
 for(const mode of ['demo','demo-futures']){
  const pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',calls=[],reads=[],raw={mode,pair,books:[],trades:[]};
  const snapshot=await collectOrderFlow({mode,pairs:[pair]},{fetchImpl:fetchFixture(mode,calls),
   readOrderFlowSampleFn:async(...args)=>{reads.push(args);return {mode,version:'sampled-demo-flow-v1',markets:{[pair]:raw}};},includeWeb3:true,
   queryWeb3:()=>assert.fail('Order-flow entry must not request web3 research')});
  assert.equal(snapshot.entryPolicyVersion,'kev-order-flow-v1');assert.equal(snapshot.timeframe,'order-flow');
  assert.equal(snapshot.decisionBoundary,B);assert.equal('candleBoundary' in snapshot,false);
  assert.deepEqual(snapshot.markets[0].orderFlow,raw);assert.equal('candles' in snapshot.markets[0],false);
  assert.equal('candleBoundary' in snapshot.markets[0],false);assert.equal(snapshot.evidence.length,1);
  assert.equal(snapshot.evidence.some(e=>e.id.startsWith('technical:')),false);
  assert.deepEqual(reads,[[mode]]);assert.equal(calls.some(url=>url.includes('klines')),false);
  assert.equal(calls.length,mode==='demo'?3:4);
  assert.ok(calls.every(url=>new URL(url).hostname===(mode==='demo'?'demo-api.binance.com':'demo-fapi.binance.com')));
  verifyScheduledDecision(snapshot,B,B+20000);
  const timing=verifyEntryTiming({snapshot,pair,mode,clock:snapshot.clock,now:B+20000});
  assert.equal(timing.boundary,B);assert.equal(timing.decisionDeadline,B+M);
  assert.equal('lastCandleCloseAt' in timing,false);
 }
});

test('one latest sampler generation is captured after slow quote collection and cannot change after snapshot creation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:B+5000});
 const pairs=['BTC/USDT','ETH/USDT'];let reads=0,releaseInfo,quoteRequests=0;
 const pendingInfo=new Promise(resolve=>{releaseInfo=resolve;});
 const sample=at=>({mode:'demo',version:'sampled-demo-flow-v1',observedAt:at,completedAt:at,pid:99,
  markets:Object.fromEntries(pairs.map(pair=>[pair,{mode:'demo',pair,books:[{at}],trades:[]}]))});
 let visible=sample(B-3000);
 const collecting=collectOrderFlow({mode:'demo',pairs},{readOrderFlowSampleFn:async()=>{reads++;return visible;},
  fetchImpl:async raw=>{
   const url=new URL(raw),symbol=url.searchParams.get('symbol');
   if(url.pathname.endsWith('/time'))return new Response(JSON.stringify({serverTime:Date.now()}));
   if(url.pathname.endsWith('/exchangeInfo')){await pendingInfo;return new Response(JSON.stringify({symbols:pairs.map(pair=>({
    symbol:pair.replace('/',''),baseAsset:pair.split('/')[0],quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,filters:[]}))}));}
   if(url.pathname.endsWith('/ticker/bookTicker')){quoteRequests++;return new Response(JSON.stringify({symbol,bidPrice:'100',askPrice:'100.01'}));}
   assert.fail('Unexpected endpoint');
  }});
 for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(quoteRequests,2);assert.equal(reads,0,'Do not freeze a flow generation when quote requests start');
 t.mock.timers.setTime(B+7000);visible=sample(B+6500);releaseInfo();
 const snapshot=await collecting;
 assert.equal(reads,1);assert.equal(snapshot.markets.length,2);
 for(const market of snapshot.markets)assert.equal(market.orderFlow.books[0].at,B+6500);
 assert.equal(snapshot.orderFlowAcquisition.completedAt,B+6500);
 assert.equal(snapshot.orderFlowAcquisition.acquiredAt,new Date(B+7000).toISOString());
 const original=JSON.stringify(snapshot);
 visible.markets[pairs[0]].books[0].at=B+17000;visible=sample(B+17000);
 assert.equal(JSON.stringify(snapshot),original,'Later sampler changes cannot replace reviewed proof bytes');
});

test('a failed or wrong-mode latest publication remains missing with no cached proof fallback',async t=>{
 t.mock.timers.enable({apis:['Date'],now:B+20000});
 const pair='BTC/USDT';
 for(const published of [null,{mode:'demo-futures',version:'sampled-demo-flow-v1',markets:{[pair]:{pair}}},
  {mode:'demo',version:'sampled-demo-flow-v1',error:'FLOW_SAMPLE_UNAVAILABLE',markets:{[pair]:{pair}}}]){
  let reads=0;const snapshot=await collectOrderFlow({mode:'demo',pairs:[pair]},
   {fetchImpl:fetchFixture('demo',[]),readOrderFlowSampleFn:async()=>{reads++;return published;}});
  assert.equal(reads,1);assert.equal(snapshot.markets[0].orderFlow,null);
  assert.equal(snapshot.orderFlowAcquisition.observedAt,null);
 }
});
test('no-candle market collection preserves instrument, symbol, quote and funding identity checks',async()=>{
 for(const [mode,change,error] of [
  ['demo',{instrument:{isSpotTradingAllowed:false}},/NOT_A_VERIFIED_SPOT_PAIR/],
  ['demo',{instrument:{baseAsset:'FAKE'}},/NOT_A_VERIFIED_SPOT_PAIR/],
  ['demo',{quote:{symbol:'ETHUSDT'}},/QUOTE_SYMBOL_MISMATCH/],
  ['demo',{quote:{askPrice:'99'}},/Invalid quote/],
  ['demo-futures',{instrument:{contractType:'CURRENT_QUARTER'}},/NOT_A_VERIFIED_USDT_PERPETUAL/],
  ['demo-futures',{funding:{lastFundingRate:''}},/INVALID_FUNDING_MARK/],
  ['demo-futures',{funding:{symbol:'ETHUSDT'}},/INVALID_FUNDING_MARK/]
 ]){
  const pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT';
  await assert.rejects(marketOrderFlow(pair,{mode,clock:clockFixture(B+20000,mode),
   fetchImpl:fetchFixture(mode,[],change),readOrderFlowFn:async()=>null}),error);
 }
 await assert.rejects(collectOrderFlow({mode:'dry-run',pairs:[]}),/FLOW_DEMO_ONLY/);
 await assert.rejects(marketOrderFlow('BTC/USDT',{mode:'live'}),/FLOW_DEMO_ONLY/);
});
test('Kev decisions work every minute including all minutes outside a five-minute boundary',()=>{
 for(const mode of ['demo','demo-futures'])for(let minute=0;minute<5;minute++){
  const s=fixture(mode),at=B+minute*M+20000;
  Object.assign(s,{decisionBoundary:B+minute*M,clock:clockFixture(at,mode),createdAt:new Date(at).toISOString()});
  const checked=verifyEntryTiming({snapshot:s,pair:s.markets[0].pair,mode,clock:s.clock,now:at});
  assert.equal(checked.boundary,B+minute*M);assert.equal(checked.decisionDeadline,B+(minute+1)*M);
  assert.equal(checked.candleDeadline,B+(minute+1)*M-1);
  verifyScheduledDecision(s,s.decisionBoundary,at);
 }
});
test('Kev minute proofs cannot inherit legacy candle timing or omit their exact policy contract',()=>{
 const s=fixture();
 for(const change of [{entryPolicyVersion:'order-flow-only-v1'},{timeframe:'5m'},
  {candleBoundary:B},{decisionBoundary:B+1},{decisionIntervalMs:300000},{decisionCadenceVersion:'future-v2'},
  {mode:'dry-run'},{decisionBoundary:undefined}])assert.throws(()=>decisionTiming({...s,...change}),/DECISION_TIMING_INVALID/);
 const noTiming={...s};for(const key of ['decisionBoundary','decisionIntervalMs','decisionCadenceVersion'])delete noTiming[key];
 assert.throws(()=>decisionTiming(noTiming),/DECISION_TIMING_INVALID/);
 const noPolicy={...s};delete noPolicy.entryPolicyVersion;
 assert.throws(()=>decisionTiming(noPolicy),/DECISION_TIMING_INVALID/);
});
test('Kev minute expiry, original snapshot clock and clock uncertainty remain execution gates',()=>{
 const s=fixture(),args={snapshot:s,pair:s.markets[0].pair,mode:s.mode,clock:s.clock,now:B+20000};
 assert.throws(()=>verifyEntryTiming({...args,now:B+M,clock:clockFixture(B+M,s.mode)}),/SIGNAL_DECISION_SUPERSEDED/);
 assert.throws(()=>verifyScheduledDecision(s,B,B+M),/SCHEDULED_DECISION_NOT_READY/);
 assert.throws(()=>verifyEntryTiming({...args,snapshot:{...s,decisionBoundary:B+M},
  now:B+M+20000,clock:clockFixture(B+M+20000,s.mode)}),/SIGNAL_DECISION_SUPERSEDED/);
 assert.throws(()=>verifyScheduledDecision({...s,decisionBoundary:B+M},B+M,B+M+10000),/SCHEDULED_DECISION_NOT_READY/);
 const now=B+M-20,uncertain={...clockFixture(now,s.mode),requestStartedAt:now-100,serverTime:now-50};
 assert.throws(()=>verifyEntryTiming({...args,now,clock:uncertain}),/CLOCK_DECISION_BOUNDARY_UNCERTAIN/);
 const stale={...clockFixture(B-60001,s.mode)};
 assert.throws(()=>verifyEntryTiming({...args,clock:stale}),/CLOCK_STALE/);
});
test('Kev timing rejects missing, duplicate, wrong-mode and candle-bearing market identity',()=>{
 const s=fixture(),args={snapshot:s,pair:s.markets[0].pair,mode:s.mode,clock:s.clock,now:B+20000};
 for(const markets of [[],[s.markets[0],s.markets[0]],[{...s.markets[0],mode:'demo-futures'}],
  [{...s.markets[0],candles:[]}],[{...s.markets[0],candleBoundary:B}],[{...s.markets[0],timeframe:'5m'}]]){
  assert.throws(()=>verifyEntryTiming({...args,snapshot:{...s,markets}}),/TIMING_MARKET_MISMATCH/);
  assert.throws(()=>verifyScheduledDecision({...s,markets},B,B+20000),/SCHEDULED_DECISION_NOT_READY/);
 }
});
