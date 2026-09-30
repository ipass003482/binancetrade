import test from 'node:test';
import assert from 'node:assert/strict';
import DecimalBase from 'decimal.js';
import {FLOW_VERSION,assessOrderFlow,validateOrderFlowData} from '../src/order-flow.mjs';
import {KEV_ENTRY_SIGNAL_POLICY,validKevEntrySignalPolicy,assessKevEntrySignal} from '../src/kev-entry-signal.mjs';

const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
const NOW=Date.parse('2026-09-29T08:00:00Z');
function fixture(long=true,mode=long?'demo':'demo-futures'){
 const proof={version:FLOW_VERSION,mode,pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',
  source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',startTime:NOW-61000,endTime:NOW-1000,
  books:[-20000,-10000,0].map((offset,index)=>book(NOW+offset,index,new Decimal(100).plus(new Decimal(index).mul(long?'.01':'-.01')))),
  trades:[[-20000,'3',!long],[-15000,'2',long],[-10000,'3',!long],[-1000,'2',long]].map(([offset,q,m],a)=>({a,T:NOW+offset,p:'100',q,m}))};
 return proof;
}
function book(at,updateId,mid,bidQty='1',askQty='1'){
 return {at,updateId,bids:Array.from({length:5},(_,i)=>[mid.minus(new Decimal(i+1).mul('.001')).toFixed(),bidQty]),
  asks:Array.from({length:5},(_,i)=>[mid.plus(new Decimal(i+1).mul('.001')).toFixed(),askQty])};
}
function assess(proof,long=true,extra={}){return assessKevEntrySignal(proof,{mode:proof.mode,pair:proof.pair,long,now:NOW,...extra});}
function setMids(proof,values){proof.books=proof.books.map((b,i)=>book(b.at,b.updateId,new Decimal(values[i])));}

test('fixed policy is immutable and accepts only the exact complete contract',()=>{
 assert.ok(Object.isFrozen(KEV_ENTRY_SIGNAL_POLICY));assert.ok(validKevEntrySignalPolicy({...KEV_ENTRY_SIGNAL_POLICY}));
 for(const value of [null,undefined,[],{}, {...KEV_ENTRY_SIGNAL_POLICY,version:'other'},
  {...KEV_ENTRY_SIGNAL_POLICY,minimumDirectionalShare:'.55'}, {...KEV_ENTRY_SIGNAL_POLICY,minimumCommonWindowMs:'15000'},
  {...KEV_ENTRY_SIGNAL_POLICY,minimumTradeCount:2},{...KEV_ENTRY_SIGNAL_POLICY,extra:1},
  {...KEV_ENTRY_SIGNAL_POLICY,[Symbol('extra')]:1},Object.create(KEV_ENTRY_SIGNAL_POLICY)])
  assert.equal(validKevEntrySignalPolicy(value),false);
 for(const key of Object.keys(KEV_ENTRY_SIGNAL_POLICY)){const p={...KEV_ENTRY_SIGNAL_POLICY};delete p[key];assert.equal(validKevEntrySignalPolicy(p),false);}
 assert.throws(()=>{KEV_ENTRY_SIGNAL_POLICY.minimumTradeCount=0;},TypeError);
});

for(const [long,mode] of [[true,'demo'],[true,'demo-futures'],[false,'demo-futures']]){
 test(`${mode} ${long?'long':'short'} permits coherent tape/quotes despite opposing static depth`,()=>{
  const p=fixture(long,mode);
  for(const b of p.books){for(const row of b.bids)row[1]=long?'1':'2';for(const row of b.asks)row[1]=long?'2':'1';}
  const original=structuredClone(p),legacy=assessOrderFlow(p,{mode,pair:p.pair,long,now:NOW}),result=assess(p,long);
  assert.equal(legacy.reason,'FLOW_TAPE_BOOK_MISMATCH');assert.equal(result.eligible,true);
  assert.deepEqual(result.reasons,[]);assert.equal(result.overall.directionalShare,'0.6');
  assert.equal(result.halves[0].directionalShare,'0.6');assert.equal(result.halves[1].directionalShare,'0.6');
  assert.equal(result.window.startTime,NOW-20000);assert.equal(result.window.endTime,NOW-1000);
  assert.equal(result.window.durationMs,19000);assert.equal(result.tradeCount,4);
  assert.equal(result.quoteResponse.intervals.length,2);assert.equal(result.depthWithinBounds,true);
  assert.deepEqual(p,original);
 });

 test(`${mode} ${long?'long':'short'} rejects absorbed pressure and adjacent price reversal`,()=>{
  const neutral=fixture(long,mode);setMids(neutral,['100','100','100']);
  const flat=assess(neutral,long);assert.equal(flat.eligible,false);
  assert.ok(flat.reasons.includes('KEV_SIGNAL_FINAL_QUOTES_NOT_CONFIRMED'));
  assert.ok(flat.reasons.includes('KEV_SIGNAL_MID_MOVE_NOT_CONFIRMED'));
  const reversal=fixture(long,mode);setMids(reversal,long?['100','99.99','100.02']:['100','100.01','99.98']);
  const adverse=assess(reversal,long);assert.equal(adverse.eligible,false);
  assert.ok(adverse.reasons.includes('KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE'));assert.equal(adverse.quoteResponse.finalFavorable,true);
 });

 test(`${mode} ${long?'long':'short'} exact 55% and strict half-majority use original notionals`,()=>{
  const p=fixture(long,mode);
  for(const [i,t] of p.trades.entries()){t.p='1';t.q=i%2===0?'.55':'.45';}
  assert.equal(assess(p,long).eligible,true);
  for(const [i,t] of p.trades.entries())t.q=i%2===0?'.549999999999999999999':'.450000000000000000001';
  assert.ok(assess(p,long).reasons.includes('KEV_SIGNAL_TAKER_SHARE_BELOW_MINIMUM'));
  p.trades[0].q='.5';p.trades[1].q='.5';p.trades[2].q='.9';p.trades[3].q='.1';
  const tied=assess(p,long);assert.equal(tied.overall.directionalShare,'0.7');
  assert.ok(tied.reasons.includes('KEV_SIGNAL_HALF_DIRECTION_NOT_CONFIRMED'));
  p.trades[0].q='.500000000000000000001';p.trades[1].q='.499999999999999999999';
  assert.equal(assess(p,long).eligible,true);
 });
}

test('the common tape excludes older pressure and includes each boundary exactly once',()=>{
 const p=fixture();p.trades.unshift({a:-1,T:NOW-30000,p:'100',q:'10000',m:true});
 p.trades.forEach((t,i)=>t.a=i);
 const r=assess(p);assert.equal(r.eligible,true);assert.equal(r.tradeCount,4);
 assert.deepEqual(r.halves.map(h=>h.tradeCount),[2,2]);assert.equal(r.overall.buyNotional,'600');assert.equal(r.overall.sellNotional,'400');
 assert.ok(new Decimal(validateOrderFlowData(p,{mode:p.mode,pair:p.pair,now:NOW}).buyTakerShare).lt('.55'));
});

test('local tape needs at least three trades and a populated half; missing shares stay unknown',()=>{
 const p=fixture();p.trades[0].T=NOW-40000;p.trades[1].T=NOW-30000;
 const r=assess(p);assert.equal(r.eligible,false);assert.equal(r.tradeCount,2);
 assert.ok(r.reasons.includes('KEV_SIGNAL_COMMON_TAPE_INCOMPLETE'));assert.ok(r.reasons.includes('KEV_SIGNAL_HALF_TAPE_INCOMPLETE'));
 assert.equal(r.halves[0].tradeCount,0);assert.equal(r.halves[0].directionalShare,null);
 p.trades[0].T=NOW-60000;p.trades[1].T=NOW-50000;p.trades[2].T=NOW-40000;p.trades[3].T=NOW-30000;
 assert.equal(assess(p).status,'unavailable');assert.equal(assess(p).validationReason,'FLOW_TAPE_STALE');
});

test('common window must last 15 seconds and middle must lie strictly inside it',()=>{
 const p=fixture();p.books[0].at=NOW-16000;p.books[1].at=NOW-8000;
 p.trades[0].T=NOW-16000;p.trades[1].T=NOW-12000;p.trades[2].T=NOW-8000;
 assert.equal(assess(p).eligible,true);
 p.endTime--;p.startTime--;p.trades.at(-1).T--;
 const r=assess(p);assert.equal(r.reason,'KEV_SIGNAL_COMMON_WINDOW_INVALID');assert.equal(r.window.durationMs,14999);
});

test('both final executable sides must improve; a rising mid alone is insufficient',()=>{
 const p=fixture();
 // Bid remains unchanged while the ask widens. Original data are valid.
 p.books.forEach(b=>{b.bids=structuredClone(p.books[0].bids);});
 assert.equal(validateOrderFlowData(p,{mode:p.mode,pair:p.pair,now:NOW}).eligible,true);
 assert.ok(assess(p).reasons.includes('KEV_SIGNAL_FINAL_QUOTES_NOT_CONFIRMED'));
});

test('adjacent quotes may be flat while final quotes move; exact .25bps is accepted',()=>{
 for(const long of [true,false]){
  const p=fixture(long);setMids(p,long?['100','100','100.0025']:['100','100','99.9975']);
  const result=assess(p,long);assert.equal(result.eligible,true);assert.equal(result.quoteResponse.signedMidChangeBps,'0.25');
  setMids(p,long?['100','100','100.002499999999999999']:['100','100','99.997500000000000001']);
  assert.ok(assess(p,long).reasons.includes('KEV_SIGNAL_MID_MOVE_NOT_CONFIRMED'));
 }
});

test('imbalance cap applies to every book and cannot be disabled by caller thresholds',()=>{
 const p=fixture();for(const row of p.books[0].asks)row[1]='10';
 const result=assess(p,true,{maxDepthImbalance:'1',minTakerShare:0,minMidChangeBps:0,policy:{}});
 assert.ok(result.reasons.includes('KEV_SIGNAL_BOOK_IMBALANCE_TOO_LARGE'));assert.equal(result.policy,KEV_ENTRY_SIGNAL_POLICY);
});

test('exact absolute .7 imbalance is allowed and either sign above it is blocked',()=>{
 for(const bidHeavy of [true,false]){
  const p=fixture();
  for(const b of p.books){
   const bidPrices=b.bids.reduce((sum,[price])=>sum.plus(price),new Decimal(0)),
    askPrices=b.asks.reduce((sum,[price])=>sum.plus(price),new Decimal(0));
   // A 17:3 notional ratio has exactly .7 absolute imbalance.
   for(const row of b.bids)row[1]=askPrices.mul(bidHeavy?17:3).toFixed();
   for(const row of b.asks)row[1]=bidPrices.mul(bidHeavy?3:17).toFixed();
  }
  const r=assess(p);assert.equal(r.eligible,true);assert.deepEqual(r.bookImbalances,Array(3).fill(bidHeavy?'0.7':'-0.7'));
  p.books[1][bidHeavy?'bids':'asks'][0][1]=new Decimal(p.books[1][bidHeavy?'bids':'asks'][0][1]).plus('.00000001').toFixed();
  assert.ok(assess(p).reasons.includes('KEV_SIGNAL_BOOK_IMBALANCE_TOO_LARGE'));
 }
});

test('full original proof stays authoritative before any common-window filtering',()=>{
 const mutations=[
  [p=>p.source='https://api.binance.com','FLOW_SOURCE'],
  [p=>p.trades[0].a=-1,'FLOW_TRADE_GAP'],
  [p=>p.trades[1].a+=2,'FLOW_TRADE_GAP'],
  [p=>p.trades[0].m='false','FLOW_TRADE_GAP'],
  [p=>p.books[1].at=NOW-19000,'FLOW_BOOK_GAP'],
  [p=>p.books[2].bids[0][1]='NaN','FLOW_DATA_INVALID'],
  [p=>p.books[2].asks[0][0]='1','FLOW_CROSSED_BOOK'],
  [p=>p.startTime--,'FLOW_WINDOW'],
  [p=>p.trades=Array(1000).fill(p.trades[0]),'FLOW_INCOMPLETE'],
 ];
 for(const [change,expected]of mutations){const p=fixture();change(p);const result=assess(p);assert.equal(result.status,'unavailable');assert.equal(result.reason,'KEV_SIGNAL_PROOF_INVALID');assert.equal(result.validationReason,expected);}
 const p=fixture();assert.equal(assess(p,true,{now:NOW+45001}).validationReason,'FLOW_STALE');
 assert.equal(assess(p,true,{pair:'BTC/USDT'}).validationReason,'FLOW_IDENTITY');
 assert.equal(assess(p,true,{long:undefined}).reason,'KEV_SIGNAL_DIRECTION_INVALID');
 const old=fixture();old.trades.unshift({a:0,T:NOW-30000,p:'100',q:'1',m:false});old.trades.forEach((t,i)=>t.a=i);old.trades[0].a=10;
 assert.equal(assess(old).validationReason,'FLOW_TRADE_GAP');
});

test('a process-wide Decimal configuration change cannot relax the fixed boundaries',()=>{
 const p=fixture();for(const [i,t]of p.trades.entries()){t.p='1';t.q=i%2===0?'.549999999999999999999':'.450000000000000000001';}
 const before=DecimalBase.precision,rounding=DecimalBase.rounding;
 try{DecimalBase.set({precision:2,rounding:DecimalBase.ROUND_UP});assert.ok(assess(p).reasons.includes('KEV_SIGNAL_TAKER_SHARE_BELOW_MINIMUM'));}
 finally{DecimalBase.set({precision:before,rounding});}
});

test('a tiny adverse quote cannot round to a permitted flat interval',()=>{
 const p=fixture();setMids(p,['100','100','100.01']);
 p.books[1].bids[0][0]='99.99899999999999999999999999999999999999999';
 const r=assess(p);assert.equal(r.eligible,false);assert.ok(r.reasons.includes('KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE'));
 assert.equal(r.quoteResponse.intervals[0].nonAdverse,false);
});
