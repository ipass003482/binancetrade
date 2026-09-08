import { z } from 'zod';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import { ROOT } from './paths.mjs';
import { readJson } from './io.mjs';
const chain=z.enum(['1','56','8453','CT_501']);
const address=z.string().regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
const token=z.object({chainId:chain,contractAddress:address,relationship:z.enum(['token','wrapped-proxy']),
 source:z.string().url(),note:z.string().min(5).max(500)}).strict();
const wallet=z.object({chainId:chain,address,label:z.string().min(1).max(80)}).strict();
export const ResearchSchema=z.object({version:z.literal(1),pairs:z.record(z.string().regex(/^[A-Z0-9]+\/USDT$/),
 z.object({chainTokens:z.array(token).max(2),wallets:z.array(wallet).max(2)}).strict()),note:z.string().optional()}).strict();
export async function loadResearchProfile(){return ResearchSchema.parse(await readJson(join(ROOT,'config/research.json')));}
export function technicalSummary(candles){
 if(!Array.isArray(candles)||candles.length<20)throw new Error('INSUFFICIENT_TECHNICAL_DATA');
 const values=candles.map((c,i)=>{
  const o=new Decimal(c.open),h=new Decimal(c.high),l=new Decimal(c.low),close=new Decimal(c.close),v=new Decimal(c.volume);
  if(![o,h,l,close,v].every(x=>x.isFinite())||[o,h,l,close].some(x=>x.lte(0))||v.lt(0)
    ||h.lt(Decimal.max(o,close,l))||l.gt(Decimal.min(o,close,h))
    ||!Number.isFinite(c.openTime)||!Number.isFinite(c.closeTime)||c.closeTime<=c.openTime
    ||(i&&c.openTime-candles[i-1].openTime!==900000))throw new Error('INVALID_CANDLE_SERIES');
  return {o,h,l,close,v};
 });
 const mean=arr=>arr.reduce((s,n)=>s.plus(n),new Decimal(0)).div(arr.length);
 const last=values.at(-1).close,closes=values.map(v=>v.close);
 const ranges=values.slice(1).map((v,i)=>Decimal.max(v.h.minus(v.l),v.h.minus(values[i].close).abs(),v.l.minus(values[i].close).abs())).slice(-14);
 return {timeframe:'15m',closedCandles:values.length,asOf:candles.at(-1).closeTime,
  lastClose:last.toFixed(),sma8:mean(closes.slice(-8)).toFixed(),sma20:mean(closes.slice(-20)).toFixed(),
  return1hPct:last.div(closes.at(-5)).minus(1).mul(100).toFixed(4),
  return4hPct:last.div(closes.at(-17)).minus(1).mul(100).toFixed(4),
  atr14:mean(ranges).toFixed(),atr14Pct:mean(ranges).div(last).mul(100).toFixed(4),
  volumeVsPrior19:mean(values.slice(-20,-1).map(v=>v.v)).eq(0)?null:values.at(-1).v.div(mean(values.slice(-20,-1).map(v=>v.v))).toFixed(4),
  interpretation:'Descriptive indicators only; no proven trading edge.'};
}
export function compactEvidence(value,depth=0){
 if(depth>7)return '[depth limit]';
 if(Array.isArray(value))return value.slice(0,8).map(v=>compactEvidence(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,35).map(([k,v])=>[k,compactEvidence(v,depth+1)]));
 if(typeof value==='string')return value.slice(0,500);
 return value;
}
