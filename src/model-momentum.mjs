import Decimal from 'decimal.js';

export const MODEL_ENTRY_POLICY='forecast-net-edge-v1';
export const MOMENTUM_CONFIRMATION_VERSION='closed-price-momentum-v1';
// A prospective confirmation hypothesis, not a fitted win probability. Compare
// the model's 15m horizon with observed 15m and latest 5m close-to-close moves.
export function modelMomentum(candles,boundary,long){
 const rows=candles?.slice(-4);
 if(!Number.isSafeInteger(boundary)||boundary%300000||rows?.length!==4||typeof long!=='boolean')throw Error('MODEL_MOMENTUM_DATA_INVALID');
 const closes=rows.map((row,i)=>{
  if(row.openTime!==boundary-(4-i)*300000||row.closeTime!==row.openTime+299999)throw Error('MODEL_MOMENTUM_DATA_INVALID');
  if(!['number','string'].includes(typeof row.close))throw Error('MODEL_MOMENTUM_DATA_INVALID');
  const close=new Decimal(row.close);
  if(!close.isFinite()||close.lte(0))throw Error('MODEL_MOMENTUM_DATA_INVALID');
  return close;
 });
 const last=closes[3],aligned=prior=>long?last.gt(prior):last.lt(prior);
 return {version:MOMENTUM_CONFIRMATION_VERSION,confirmationAt:boundary,closeTimes:rows.map(r=>r.closeTime),
  closes:closes.map(c=>c.toFixed()),eligible:aligned(closes[2])&&aligned(closes[0])};
}
