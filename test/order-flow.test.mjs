import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOrderFlow,assessSpotFlowContinuation,assessFuturesFlowContinuation,FLOW_SELECTIVITY,FLOW_VERSION} from '../src/order-flow.mjs';
import {sampleOrderFlow} from '../src/order-flow-collector.mjs';
import {modelRuleDecision,orderFlowRuleDecision} from '../src/demo-rules.mjs';
const B=Date.parse('2026-09-15T00:00:00Z'),now=B+20000;
test('spot continuation uses strict executable ask comparison and rejects unusable quotes',()=>{
 const p=proof();
 for(const [ask,eligible]of [['100.002',true],['100.001',false],['100',false]])
  assert.equal(assessSpotFlowContinuation(p,{ask,bid:'99.99'}).eligible,eligible);
 for(const quote of [{ask:'NaN',bid:'99'},{ask:'100.002',bid:'100.002'},{ask:0,bid:0}])
  assert.equal(assessSpotFlowContinuation(p,quote).eligible,false);
 assert.equal(assessSpotFlowContinuation(proof(true),{ask:'100.002',bid:'99.99'}).eligible,false);
});
test('futures continuation checks the executable side for both directions',()=>{
 const long=proof(false,'demo-futures'),short=proof(true,'demo-futures');
 const longOrigin=long.books[0].asks[0][0],shortOrigin=short.books[0].bids[0][0];
 assert.equal(assessFuturesFlowContinuation(long,{ask:String(Number(longOrigin)+.001),bid:longOrigin},{long:true}).eligible,true);
 assert.equal(assessFuturesFlowContinuation(long,{ask:longOrigin,bid:String(Number(longOrigin)-.001)},{long:true}).eligible,false);
 assert.equal(assessFuturesFlowContinuation(short,{ask:shortOrigin,bid:String(Number(shortOrigin)-.001)},{long:false}).eligible,true);
 assert.equal(assessFuturesFlowContinuation(short,{ask:String(Number(shortOrigin)+.001),bid:shortOrigin},{long:false}).eligible,false);
 assert.equal(assessFuturesFlowContinuation(short,{ask:'100',bid:'99.9'},{long:true}).eligible,false);
});
test('spot recheck cancels a reversed quote without disabling the next cycle',()=>{
 const a=args(),market=a.snapshot.markets[0],origin=market.orderFlow.books[0].asks[0][0];
 const initial=orderFlowRuleDecision(a);assert.equal(initial.action,'buy');
 assert.equal(initial.executionQualityVersion,'flow-confirmed-exit-v2');
 assert.equal(initial.entryConfirmation.executionContinuation.originAsk,origin);
 const canceled=orderFlowRuleDecision({...a,quote:{ask:origin,bid:String(Number(origin)-.001)}});
 assert.equal(canceled.action,'hold');assert.ok(canceled.reasons.includes('SPOT_FLOW_PRICE_NOT_CONTINUED'));
 assert.equal(orderFlowRuleDecision(a).action,'buy');
 const futureInput=args(true),futureBook=futureInput.snapshot.markets[0].orderFlow.books[0];
 const future=orderFlowRuleDecision({...futureInput,quote:{bid:String(Number(futureBook.bids[0][0])-.001),ask:String(Number(futureBook.asks[0][0])+.001)}});
 assert.equal(future.action,'open-short');
 assert.equal(future.executionQualityVersion,null);assert.equal(future.entryConfirmation.executionContinuation.version,'flow-futures-price-continuation-v1');
});
function proof(short=false,mode=short?'demo-futures':'demo'){
 const books=[-20000,-10000,0].map((delta,i)=>{const mid=100+(short?-1:1)*i*.003;
  return {at:now+delta,updateId:i+1,bids:Array.from({length:5},(_,k)=>[String(mid-.001-k*.001),short?'1':'1.8']),asks:Array.from({length:5},(_,k)=>[String(mid+.001+k*.001),short?'1.8':'1'])};});
 return {version:FLOW_VERSION,mode,pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',books,startTime:now-61500,endTime:now-1500,
  trades:[0,1,2].map(i=>({a:i+1,T:now-55000+i*25000,p:'100',q:'1',m:short}))};
}
test('sampled tape/depth confirms both sides and rejects stale, foreign, crossed, truncated or discontinuous evidence',()=>{
 for(const short of [false,true]){const p=proof(short),args={mode:p.mode,pair:p.pair,long:!short,now};assert.equal(assessOrderFlow(p,args).eligible,true);
  assert.equal(assessOrderFlow(p,{...args,long:short}).eligible,false);
  for(const change of [p=>p.source='https://api.binance.com',p=>p.trades[1].a+=2,p=>p.trades[1].m='false',p=>p.books[2].asks[0][0]='1',p=>p.books[1].at+=19000,p=>p.trades=Array(1000).fill(p.trades[0]),p=>p.books[2].bids[0][1]='NaN']){
   const c=structuredClone(p);change(c);assert.equal(assessOrderFlow(c,args).eligible,false);
  }
  assert.equal(assessOrderFlow(p,{...args,now:now+45001}).eligible,false);
 }
});
function args(short=false,reclaim=false){
 const flow=proof(short),mode=flow.mode,pair=flow.pair;
 if(!short)for(const b of flow.books)for(const levels of [b.bids,b.asks])for(const row of levels)row[0]=String(Number(row[0])-1);
 const candles=Array.from({length:96},(_,i)=>{const c=short?105-i*.05:95+i*.05;return {openTime:B-(96-i)*300000,closeTime:B-(95-i)*300000-1,open:String(c),close:String(c),high:String(c+1),low:String(c-1),volume:'1'};});
 if(reclaim){const c=Number(candles.at(-1).close);for(const [idx,off]of [[94,-.2],[93,-.1]]){const p=c+(short?-off:off);Object.assign(candles[idx],{open:String(p),close:String(p),high:String(p+.01),low:String(p-.01)});}}
 const origin=candles.at(-1).close;
 const market={pair,candles,orderFlow:flow,bid:String(Number(origin)-.001),ask:String(Number(origin)+.001),verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures'};
 const snapshot={mode,timeframe:'5m',candleBoundary:B,createdAt:new Date(now).toISOString(),markets:[market],evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}},{id:'technical:'+pair,status:'ok',pair}]};
 const modelEvidence={status:'ok',entryAllowed:true,modelFingerprint:'a'.repeat(64),predictionSha256:'b'.repeat(64),prediction:{issuedAt:new Date(B+3000).toISOString(),forecasts:[{pair,originClose:origin,forecastCloses:[1,2,3].map(i=>String(Number(origin)+(short?-1:1)*i*.01)),targetCloseAt:B+899999}]}};
 return {snapshot,pair,modelEvidence,cost:{status:'ok',estimatedRoundTripCostBps:'20',requiredPriceSpaceBps:'50'},now};
}

test('negative aggregate IDs are rejected at the host while valid zero IDs are accepted',()=>{
 const p=proof(),a={mode:p.mode,pair:p.pair,long:true,now};
 p.trades.forEach((t,i)=>t.a=i-3);
 assert.equal(assessOrderFlow(p,a).reason,'FLOW_TRADE_GAP');
 p.trades.forEach((t,i)=>t.a=i);
 assert.equal(assessOrderFlow(p,a).eligible,true);
});

test('subthreshold high precision tape is not rounded up into a 55% entry',()=>{
 const p=proof(),a={mode:p.mode,pair:p.pair,long:true,now};
 ['0.549999999999999999999','0.2','0.250000000000000000001'].forEach((q,i)=>Object.assign(p.trades[i],{p:'1',q,m:i!==0}));
 assert.equal(assessOrderFlow(p,a).eligible,false);
 p.trades[0].q='.55';p.trades[2].q='.25';assert.equal(assessOrderFlow(p,a).eligible,true);
});

test('optional adaptive flow share only tightens the native-compatible original floor',()=>{
 const p=proof(),a={mode:p.mode,pair:p.pair,long:true,now};
 ['.56','.2','.24'].forEach((q,i)=>Object.assign(p.trades[i],{p:'1',q,m:i!==0}));
 assert.equal(assessOrderFlow(p,a).eligible,true);
 assert.equal(assessOrderFlow(p,{...a,minTakerShare:'.57'}).eligible,false);
 assert.equal(assessOrderFlow(p,{...a,minTakerShare:'.56'}).eligible,true);
 for(const threshold of ['.54','.61','NaN',null])assert.equal(assessOrderFlow(p,{...a,minTakerShare:threshold}).eligible,false);
});

test('live selectivity rejects weak mid movement and extreme depth while retaining bounded flow',()=>{
 const p=proof(),a={mode:p.mode,pair:p.pair,long:true,now,minMidChangeBps:FLOW_SELECTIVITY.minimumMidChangeBps,maxDepthImbalance:FLOW_SELECTIVITY.maximumDepthImbalance};
 assert.equal(assessOrderFlow(p,a).eligible,true);
 const weak=structuredClone(p);for(const [i,b] of weak.books.entries()){const mid=100+i*.001;b.bids[0][0]=String(mid-.001);b.asks[0][0]=String(mid+.001);}
 assert.equal(assessOrderFlow(weak,a).eligible,false);
 const extreme=structuredClone(p);for(const b of extreme.books){for(const row of b.bids)row[1]='6';for(const row of b.asks)row[1]='1';}
 assert.equal(assessOrderFlow(extreme,a).eligible,false);
});

test('one-minute flow decisions retain closed5m ATR, adapt entry inputs and reject expired minute evidence',()=>{
 for(const short of [false,true]){
  const a=args(short),minute=B+120000,delta=120000;
  a.now+=delta;a.snapshot.createdAt=new Date(a.now).toISOString();
  Object.assign(a.snapshot,{decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:minute});
  const proof=a.snapshot.markets[0].orderFlow;proof.startTime+=delta;proof.endTime+=delta;
  for(const b of proof.books)b.at+=delta;for(const t of proof.trades)t.T+=delta;
  const book=a.snapshot.markets[0].orderFlow.books[0];
  const quote=short?{bid:String(Number(book.bids[0][0])-.001),ask:String(Number(book.asks[0][0])+.001)}:undefined;
  const r=orderFlowRuleDecision({...a,quote});
  assert.equal(r.action,short?'open-short':'buy');assert.equal(r.timeframe,'5m');assert.equal(r.atrTimeframe,'15m');
  assert.equal(r.signalAt,minute);assert.equal(r.entryConfirmation.confirmationAt,B);
  assert.equal(r.adaptiveParameters.inputs.atr15,String(r.atr15));
  assert.equal(r.adaptiveParameters.inputs.quotePrice,r.entryConfirmation.quotePrice);
  assert.ok(Number(r.requiredPriceSpaceBps)>=Number(a.cost.estimatedRoundTripCostBps)+Number(r.adaptiveParameters.costBufferBps));
  assert.equal(r.flowDiagnostics.minimumTakerShare,String(Number(r.adaptiveParameters.minTakerShare)));
  assert.deepEqual(orderFlowRuleDecision({...a,quote,now:minute+60000}).reasons,['FLOW_DECISION_EXPIRED']);
  const broken=structuredClone(a);broken.snapshot.decisionIntervalMs=300000;
  assert.deepEqual(orderFlowRuleDecision(broken).reasons,['FLOW_DECISION_TIMING_INVALID']);
 }
});
test('new flow route can enter without closed reclaim; unavailable flow retains original route and never bypasses model/cost',()=>{
 for(const short of [false,true]){
  const a=args(short),r=modelRuleDecision(a);assert.notEqual(r.action,'hold');assert.equal(r.entryRoute,'order-flow');assert.equal(r.entryPolicyVersion,'trend-pullback-flow-v1');
  assert.equal(r.entryConfirmation.priceConfirmation.eligible,false);
  const no=structuredClone(a);no.snapshot.markets[0].orderFlow=null;assert.equal(modelRuleDecision(no).action,'hold');
  assert.equal(modelRuleDecision({...a,modelEvidence:null}).action,'hold');
  assert.equal(modelRuleDecision({...a,cost:{...a.cost,requiredPriceSpaceBps:'9999'}}).action,'hold');
  const old=args(short,true);old.snapshot.markets[0].orderFlow=null;const kept=modelRuleDecision(old);assert.notEqual(kept.action,'hold');assert.equal(kept.entryRoute,'pullback');
 }
});
test('collector is Demo-only GET and does not turn upstream failure into healthy flow',async()=>{
 await assert.rejects(sampleOrderFlow({mode:'dry-run',pairs:[]}),/FLOW_DEMO_ONLY/);
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>JSON.stringify(url.endsWith('/time')?{serverTime:now}:url.includes('/depth')?{lastUpdateId:1,bids:proof().books[0].bids,asks:proof().books[0].asks}:proof().trades)};};
 const r=await sampleOrderFlow({mode:'demo',pairs:['ETH/USDT']},{},{fetchImpl,now:()=>now});
 assert.equal(r.diagnostics['ETH/USDT'].status,'unavailable');assert.equal(r.markets['ETH/USDT'].books.length,1);
 assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'&&c.url.startsWith('https://demo-api.binance.com/api/v3/')));
 const bad=await sampleOrderFlow({mode:'demo',pairs:['ETH/USDT']},{},{now:()=>now,fetchImpl:async(url)=>url.endsWith('/time')?{ok:true,text:async()=>JSON.stringify({serverTime:now})}:{ok:false,status:429}});
 assert.equal(bad.diagnostics['ETH/USDT'].reason,'FLOW_RATE_LIMIT');assert.deepEqual(bad.markets,{});
});

test('flow-only ignores absent/contrary model and opposing candle trends, but still enforces costs and data',()=>{
 for(const short of [false,true]){
  const a=args(short);const reference=structuredClone(a.snapshot.markets[0]);
  // Reverse closed prices around 100 while preserving valid OHLC and ATR.
  for(const c of a.snapshot.markets[0].candles){const high=c.high,low=c.low;c.open=String(200-Number(c.open));c.close=String(200-Number(c.close));c.high=String(200-Number(low));c.low=String(200-Number(high));}
  for(const modelEvidence of [null,{status:'unavailable'},a.modelEvidence]){
   const book=a.snapshot.markets[0].orderFlow.books[0];
   const quote=short?{bid:String(Number(book.bids[0][0])-.001),ask:String(Number(book.asks[0][0])+.001)}:undefined;
   const r=orderFlowRuleDecision({...a,quote,modelEvidence});assert.equal(r.action,short?'open-short':'buy');assert.equal(r.entryConfirmation.forecastClose,undefined);assert.equal(r.entryPolicyVersion,'order-flow-only-v1');
  }
  const book=a.snapshot.markets[0].orderFlow.books[0];
  const quote=short?{bid:String(Number(book.bids[0][0])-.001),ask:String(Number(book.asks[0][0])+.001)}:undefined;
  assert.equal(orderFlowRuleDecision({...a,quote,cost:{...a.cost,requiredPriceSpaceBps:'9999'}}).action,'hold');
  a.snapshot.markets[0].orderFlow=null;assert.equal(orderFlowRuleDecision(a).action,'hold');
 }
});
