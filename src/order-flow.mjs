import DecimalBase from 'decimal.js';
// Match native Decimal localcontext: isolate precision and compare notionals,
// never a display-rounded ratio at the 55% boundary.
const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
export const FLOW_ONLY_POLICY='order-flow-only-v1';
export const SPOT_FLOW_QUALITY_VERSION='flow-confirmed-exit-v2';
export const SPOT_FLOW_EXIT_POLICY=Object.freeze({version:'rolling-opposite-flow-v2',windowMs:60000,minConfirmationMs:20000,minSamples:3,maxObservationGapMs:20000,oppositeTakerShare:'0.55'});
export const SPOT_FLOW_CONTINUATION_VERSION='flow-price-continuation-v1';
export const FLOW_POLICY='trend-pullback-flow-v1';
export const FLOW_VERSION='sampled-demo-flow-v1';
export const FLOW_MAX_AGE_MS=45000;
const fail=reason=>({status:'unavailable',eligible:false,reason});
const positive=v=>{if(!['string','number'].includes(typeof v))throw Error();const x=new Decimal(v);if(!x.isFinite()||x.lte(0)||Math.abs(x.e)>50)throw Error();return x;};
// Prospective spot-entry hypothesis: the currently offered buying price must
// still be above the start of the sampled signal. This is not a return forecast.
export function assessSpotFlowContinuation(proof,quote){
 const base={version:SPOT_FLOW_CONTINUATION_VERSION};
 try{
  if(proof?.mode!=='demo'||proof.version!==FLOW_VERSION||proof.books?.length!==3)throw Error();
  const origin=positive(proof.books[0].asks[0][0]),ask=positive(quote?.ask),bid=positive(quote?.bid);
  if(bid.gte(ask))throw Error();
  const eligible=ask.gt(origin);
  return {...base,status:'ok',eligible,originAsk:origin.toFixed(),quoteAsk:ask.toFixed(),
   reason:eligible?null:'SPOT_FLOW_PRICE_NOT_CONTINUED'};
 }catch{return {...base,status:'unavailable',eligible:false,reason:'SPOT_FLOW_CONTINUATION_INVALID'};}
}
// Ten-second depth samples are not a full event-by-event order book or OFI.
// 55% taker notional, persistent depth support and favorable mid-price change
// form one prospective hypothesis; thresholds are not fitted win probabilities.
export function assessOrderFlow(proof,{mode,pair,long,now,minTakerShare='.55'}){
 try{
  const minimum=new Decimal(minTakerShare);
  if(!['string','number'].includes(typeof minTakerShare)||!minimum.isFinite()||minimum.lt('.55')||minimum.gt('.60'))return fail('FLOW_THRESHOLD_INVALID');
  if(!proof||proof.version!==FLOW_VERSION||proof.mode!==mode||proof.pair!==pair||typeof long!=='boolean'||!Number.isSafeInteger(now))return fail('FLOW_IDENTITY');
  const source=mode==='demo'?'https://demo-api.binance.com':mode==='demo-futures'?'https://demo-fapi.binance.com':null;
  if(!source||proof.source!==source)return fail('FLOW_SOURCE');
  const {books,trades,startTime,endTime}=proof;
  if(!Array.isArray(books)||books.length!==3||!Array.isArray(trades)||trades.length<3||trades.length>=1000)return fail('FLOW_INCOMPLETE');
  if(!Number.isSafeInteger(startTime)||!Number.isSafeInteger(endTime)||endTime-startTime!==60000)return fail('FLOW_WINDOW');
  const mids=[],imbalances=[];
  for(let i=0;i<3;i++){
   const b=books[i];
   if(!Number.isSafeInteger(b.at)||!Number.isSafeInteger(b.updateId)||b.updateId<0||b.at>now||now-b.at>90000)return fail('FLOW_BOOK_TIME');
   if(i&&(b.at-books[i-1].at<5000||b.at-books[i-1].at>20000||b.updateId<books[i-1].updateId))return fail('FLOW_BOOK_GAP');
   const sides=[b.bids,b.asks].map((levels,j)=>{
    if(!Array.isArray(levels)||levels.length!==5)throw Error();
    return levels.map((l,k)=>{if(!Array.isArray(l)||l.length!==2)throw Error();const p=positive(l[0]),q=positive(l[1]);if(k&&(j===0?p.gte(levels[k-1][0]):p.lte(levels[k-1][0])))throw Error();return [p,q];});
   });
   if(sides[0][0][0].gte(sides[1][0][0]))return fail('FLOW_CROSSED_BOOK');
   const totals=sides.map(s=>s.reduce((a,[p,q])=>a.plus(p.mul(q)),new Decimal(0)));
   imbalances.push(totals[0].minus(totals[1]).div(totals[0].plus(totals[1])));
   mids.push(sides[0][0][0].plus(sides[1][0][0]).div(2));
  }
  const latest=books.at(-1).at;
  if(now-latest>FLOW_MAX_AGE_MS||endTime>latest||latest-endTime>5000||books[2].at-books[0].at<15000)return fail('FLOW_STALE');
  let buy=new Decimal(0),sell=new Decimal(0),prior=null;
  for(const t of trades){
   if(!Number.isSafeInteger(t.a)||t.a<0||!Number.isSafeInteger(t.T)||typeof t.m!=='boolean'||t.T<startTime||t.T>endTime||(prior&&(t.a!==prior.a+1||t.T<prior.T)))return fail('FLOW_TRADE_GAP');
   const n=positive(t.p).mul(positive(t.q));if(t.m)sell=sell.plus(n);else buy=buy.plus(n);prior=t;
  }
  if(endTime-trades.at(-1).T>15000)return fail('FLOW_TAPE_STALE');
  const directional=long?buy:sell,total=buy.plus(sell),share=directional.div(total);
  const depth=imbalances.every(v=>long?v.gt(0):v.lt(0));
  const movement=long?mids[2].gt(mids[0]):mids[2].lt(mids[0]);
  const eligible=directional.gte(total.mul(minimum))&&depth&&movement;
  return {status:'ok',eligible,reason:eligible?null:'FLOW_NOT_ALIGNED',takerShare:share.toFixed(),minimumTakerShare:minimum.toFixed(),bookImbalances:imbalances.map(v=>v.toFixed()),midChangeBps:mids[2].div(mids[0]).minus(1).mul(10000).toFixed(),sampledAt:latest};
 }catch{return fail('FLOW_DATA_INVALID');}
}
