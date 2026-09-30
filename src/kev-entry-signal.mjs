import DecimalBase from 'decimal.js';
import {validateOrderFlowData} from './order-flow.mjs';

// Prospective fixed rule, not fitted to trade outcomes or a profit forecast.
// The native implementation uses the same precision and rounding context.
const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
export const KEV_ENTRY_SIGNAL_POLICY=Object.freeze({
 version:'kev-coherent-flow-v1',originalWindowMs:60000,minimumCommonWindowMs:15000,
 minimumTradeCount:3,minimumTradesPerHalf:1,minimumDirectionalShare:'0.55',
 minimumHalfDirectionalShareExclusive:'0.5',minimumSignedMidChangeBps:'0.25',maximumAbsoluteDepthImbalance:'0.7',
});

export function validKevEntrySignalPolicy(value){
 try{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
   &&Reflect.ownKeys(value).length===Object.keys(KEV_ENTRY_SIGNAL_POLICY).length
   &&Object.entries(KEV_ENTRY_SIGNAL_POLICY).every(([key,expected])=>
    Object.hasOwn(value,key)&&typeof value[key]===typeof expected&&value[key]===expected);
 }catch{return false;}
}

const text=value=>value.toFixed();
function tapeSummary(trades,long){
 let buy=new Decimal(0),sell=new Decimal(0);
 for(const trade of trades){
  const notional=new Decimal(trade.p).mul(trade.q);
  if(trade.m)sell=sell.plus(notional);else buy=buy.plus(notional);
 }
 const total=buy.plus(sell),directional=long?buy:sell;
 return {buy,sell,total,directional,view:{tradeCount:trades.length,buyNotional:text(buy),sellNotional:text(sell),
  totalNotional:text(total),directionalNotional:text(directional),
  buyShare:total.gt(0)?text(buy.div(total)):null,directionalShare:total.gt(0)?text(directional.div(total)):null}};
}

export function assessKevEntrySignal(proof,{mode,pair,long,now}={}){
 const base={version:KEV_ENTRY_SIGNAL_POLICY.version,policy:KEV_ENTRY_SIGNAL_POLICY,mode,pair,long,
  requestedDirection:long===true?'buy':long===false?'sell':null};
 const unavailable=(reason,extra={})=>({...base,status:'unavailable',eligible:false,reason,reasons:[reason],
  validationReason:null,window:null,overall:null,halves:null,quoteResponse:null,bookImbalances:null,sampledAt:null,...extra});
 // Validate every original trade, including those outside the common window.
 // Filtering first would hide a gap, foreign source, stale tape or saturation.
 const validation=validateOrderFlowData(proof,{mode,pair,now});
 if(validation.status!=='ok'||validation.eligible!==true)
  return unavailable('KEV_SIGNAL_PROOF_INVALID',{validationReason:validation.reason});
 if(typeof long!=='boolean')return unavailable('KEV_SIGNAL_DIRECTION_INVALID');
 try{
  const policy=KEV_ENTRY_SIGNAL_POLICY,books=proof.books,
   start=books[0].at,middle=books[1].at,end=proof.endTime;
  const window={originalStartTime:proof.startTime,originalEndTime:proof.endTime,startTime:start,middleTime:middle,
   endTime:end,durationMs:end-start,firstHalfBounds:'[start,middle)',secondHalfBounds:'[middle,end]'};
  if(!(start<middle&&middle<end)||end-start<policy.minimumCommonWindowMs)
   return unavailable('KEV_SIGNAL_COMMON_WINDOW_INVALID',{window,sampledAt:validation.sampledAt});
  const common=proof.trades.filter(trade=>trade.T>=start&&trade.T<=end),
   first=common.filter(trade=>trade.T<middle),second=common.filter(trade=>trade.T>=middle),
   overall=tapeSummary(common,long),halves=[tapeSummary(first,long),tapeSummary(second,long)],reasons=[];
  if(common.length<policy.minimumTradeCount)reasons.push('KEV_SIGNAL_COMMON_TAPE_INCOMPLETE');
  if(halves.some(half=>half.view.tradeCount<policy.minimumTradesPerHalf))reasons.push('KEV_SIGNAL_HALF_TAPE_INCOMPLETE');
  // Compare original notionals directly, not a display-rounded share.
  if(overall.total.gt(0)&&overall.directional.lt(overall.total.mul(policy.minimumDirectionalShare)))
   reasons.push('KEV_SIGNAL_TAKER_SHARE_BELOW_MINIMUM');
  if(halves.some(half=>half.total.gt(0)&&half.directional.lte(half.total.mul(policy.minimumHalfDirectionalShareExclusive))))
   reasons.push('KEV_SIGNAL_HALF_DIRECTION_NOT_CONFIRMED');
  const bids=books.map(book=>new Decimal(book.bids[0][0])),asks=books.map(book=>new Decimal(book.asks[0][0])),
   sign=new Decimal(long?1:-1),move=(before,after)=>after.div(before).minus(1).mul(10000),
   intervals=[0,1].map(index=>{
    const bidMove=move(bids[index],bids[index+1]),askMove=move(asks[index],asks[index+1]),
     signedBid=bidMove.mul(sign),signedAsk=askMove.mul(sign);
    return {fromTime:books[index].at,toTime:books[index+1].at,bidMoveBps:text(bidMove),askMoveBps:text(askMove),
     signedBidMoveBps:text(signedBid),signedAskMoveBps:text(signedAsk),
     nonAdverse:long?bids[index+1].gte(bids[index])&&asks[index+1].gte(asks[index]):bids[index+1].lte(bids[index])&&asks[index+1].lte(asks[index])};
   }),bidMove=move(bids[0],bids[2]),askMove=move(asks[0],asks[2]),
   signedBid=bidMove.mul(sign),signedAsk=askMove.mul(sign),midMove=new Decimal(validation.midChangeBps),signedMid=midMove.mul(sign),
   finalFavorable=long?bids[2].gt(bids[0])&&asks[2].gt(asks[0]):bids[2].lt(bids[0])&&asks[2].lt(asks[0]),bookImbalances=validation.bookImbalances,
   depthWithinBounds=bookImbalances.every(value=>new Decimal(value).abs().lte(policy.maximumAbsoluteDepthImbalance));
  if(intervals.some(interval=>!interval.nonAdverse))reasons.push('KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE');
  if(!finalFavorable)reasons.push('KEV_SIGNAL_FINAL_QUOTES_NOT_CONFIRMED');
  if(signedMid.lt(policy.minimumSignedMidChangeBps))reasons.push('KEV_SIGNAL_MID_MOVE_NOT_CONFIRMED');
  if(!depthWithinBounds)reasons.push('KEV_SIGNAL_BOOK_IMBALANCE_TOO_LARGE');
  return {...base,status:'ok',eligible:reasons.length===0,reason:reasons[0]??null,reasons,validationReason:null,window,
   overall:overall.view,halves:halves.map((half,index)=>({...half.view,startTime:index===0?start:middle,
    endTime:index===0?middle:end,endInclusive:index===1})),
   quoteResponse:{intervals,bidMoveBps:text(bidMove),askMoveBps:text(askMove),signedBidMoveBps:text(signedBid),
    signedAskMoveBps:text(signedAsk),finalFavorable,midChangeBps:text(midMove),signedMidChangeBps:text(signedMid)},
   bookImbalances,depthWithinBounds,midChangeBps:text(midMove),sampledAt:validation.sampledAt,tradeCount:common.length};
 }catch{return unavailable('KEV_SIGNAL_DATA_INVALID');}
}
