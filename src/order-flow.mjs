import DecimalBase from 'decimal.js';
// Match native Decimal localcontext: isolate precision and compare notionals,
// never a display-rounded ratio at the 55% boundary.
const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
export const FLOW_ONLY_POLICY='order-flow-only-v1';
export const SPOT_FLOW_QUALITY_VERSION='flow-confirmed-exit-v2';
export const SPOT_FLOW_EXIT_POLICY=Object.freeze({version:'rolling-opposite-flow-v2',windowMs:60000,minConfirmationMs:20000,minSamples:3,maxObservationGapMs:20000,oppositeTakerShare:'0.55'});
export const SPOT_FLOW_CONTINUATION_VERSION='flow-price-continuation-v1';
export const FUTURES_FLOW_CONTINUATION_VERSION='flow-futures-price-continuation-v1';
export const FLOW_POLICY='trend-pullback-flow-v1';
export const FLOW_VERSION='sampled-demo-flow-v1';
// A negative Demo fill is evidence that the immediately sampled direction
// failed for that pair. Block only that pair for a short, bounded period;
// other pairs remain eligible and this is not a profitability claim.
export const FLOW_LOSS_COOLDOWN_VERSION='flow-loss-cooldown-v1';
export const FLOW_LOSS_COOLDOWN_MS=10*60*1000;
export function recentLossCooldowns(history,{now=Date.now(),cooldownMs=FLOW_LOSS_COOLDOWN_MS}={}){
 const result=new Map();
 if(!Array.isArray(history)||!Number.isSafeInteger(now)||!Number.isFinite(cooldownMs)||cooldownMs<=0)return result;
 for(const trade of history){
  if(!trade||trade.is_open!==false||typeof trade.pair!=='string'||!trade.pair)continue;
  const net=Number(trade.profit_abs),closed=Number(trade.close_timestamp);
  if(!Number.isFinite(net)||net>=0||!Number.isSafeInteger(closed))continue;
  const age=now-closed;
  if(age<0||age>=cooldownMs)continue;
  const prior=result.get(trade.pair);
  if(!prior||closed>prior.closedAt)result.set(trade.pair,{pair:trade.pair,closedAt:closed,ageMs:age,profitAbs:net,tradeId:trade.trade_id??null});
 }
 return result;
}
// Bounded selectivity for the live minute route. These filters remove
// direction that is only a rounding tick or an unusually one-sided book;
// they are an observed Demo hypothesis, not a forecast or profit claim.
export const FLOW_SELECTIVITY=Object.freeze({version:'flow-selectivity-v2',minimumMidChangeBps:'0.25',maximumDepthImbalance:'0.7'});
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
// Futures uses the same stale-signal protection as spot, but checks the
// executable side of the contract quote: ask for a long and bid for a short.
// A favorable tape/depth sample is not enough if the executable quote has
// already crossed back through the first sampled book level.
export function assessFuturesFlowContinuation(proof,quote,{long}={}){
 const base={version:FUTURES_FLOW_CONTINUATION_VERSION};
 try{
  if(proof?.mode!=='demo-futures'||proof.version!==FLOW_VERSION||proof.books?.length!==3||typeof long!=='boolean')throw Error();
  const origin=positive(proof.books[0][long?'asks':'bids'][0][0]),
   ask=positive(quote?.ask),bid=positive(quote?.bid);
  if(bid.gte(ask))throw Error();
  const executable=long?ask:bid,eligible=long?executable.gt(origin):executable.lt(origin);
  return {...base,status:'ok',eligible,long,originPrice:origin.toFixed(),quotePrice:executable.toFixed(),
   reason:eligible?null:'FUTURES_FLOW_PRICE_NOT_CONTINUED'};
 }catch{return {...base,status:'unavailable',eligible:false,reason:'FUTURES_FLOW_CONTINUATION_INVALID'};}
}
// Ten-second depth samples are not a full event-by-event order book or OFI.
// 55% taker notional, persistent depth support and favorable mid-price change
// form one prospective hypothesis; thresholds are not fitted win probabilities.
export function assessOrderFlow(proof,{mode,pair,long,now,minTakerShare='.55',minMidChangeBps='0',maxDepthImbalance='1'}={}){
 try{
  const minimum=new Decimal(minTakerShare);
  const minimumMove=new Decimal(minMidChangeBps),maximumDepth=new Decimal(maxDepthImbalance);
  if(!['string','number'].includes(typeof minTakerShare)||!minimum.isFinite()||minimum.lt('.55')||minimum.gt('.60')
   ||!['string','number'].includes(typeof minMidChangeBps)||!minimumMove.isFinite()||minimumMove.lt(0)||minimumMove.gt(100)
   ||!['string','number'].includes(typeof maxDepthImbalance)||!maximumDepth.isFinite()||maximumDepth.lte(0)||maximumDepth.gt(1))return fail('FLOW_THRESHOLD_INVALID');
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
  const depthWithinBounds=imbalances.every(v=>v.abs().lte(maximumDepth));
  const midChangeBps=mids[2].div(mids[0]).minus(1).mul(10000);
  const movement=long?midChangeBps.gte(minimumMove):midChangeBps.lte(minimumMove.neg());
  const eligible=directional.gte(total.mul(minimum))&&depth&&depthWithinBounds&&movement;
  return {status:'ok',eligible,reason:eligible?null:'FLOW_NOT_ALIGNED',takerShare:share.toFixed(),minimumTakerShare:minimum.toFixed(),bookImbalances:imbalances.map(v=>v.toFixed()),midChangeBps:midChangeBps.toFixed(),minimumMidChangeBps:minimumMove.toFixed(),maximumDepthImbalance:maximumDepth.toFixed(),depthWithinBounds,sampledAt:latest};
 }catch{return fail('FLOW_DATA_INVALID');}
}
