import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
export const ADAPTIVE_FLOW_VERSION='live-flow-adaptive-v2';
export const LEGACY_ADAPTIVE_FLOW_VERSION='live-flow-adaptive-v1';
export const ADAPTIVE_FLOW_BOUNDS=Object.freeze({minimumRiskScale:.25,maximumRiskScale:1,minimumTakerShare:.55,maximumTakerShare:.60,minimumCostBufferBps:30,maximumCostBufferBps:40});
const fixed=value=>value.toFixed(12,Decimal.ROUND_DOWN);
const positive=value=>{
 if(!['number','string'].includes(typeof value))throw Error('ADAPTIVE_INPUT_INVALID');
 const n=new Decimal(value);if(!n.isFinite()||n.lte(0)||Math.abs(n.e)>50)throw Error('ADAPTIVE_INPUT_INVALID');return n;
};
export function closedVolatilityInput(candles,candleBoundary){
 if(!Array.isArray(candles))throw Error('ADAPTIVE_VOLATILITY_INVALID');
 return {version:'closed5m-volatility-v1',candleBoundary,
  candles:candles.slice(-15).map(({openTime,closeTime,high,low,close})=>({openTime,closeTime,high:String(high),low:String(low),close:String(close)}))};
}
function volatilityResponse(input){
 const need=ok=>{if(!ok)throw Error('ADAPTIVE_VOLATILITY_INVALID');};
 const keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===wanted.split(',').sort().join(',');
 need(keys(input,'version,candleBoundary,candles')&&input.version==='closed5m-volatility-v1');
 const boundary=input.candleBoundary,rows=input.candles;
 need(Number.isSafeInteger(boundary)&&boundary>0&&boundary%300000===0&&Array.isArray(rows)&&rows.length===15);
 const values=rows.map((row,i)=>{
  need(keys(row,'openTime,closeTime,high,low,close')&&Number.isSafeInteger(row.openTime)&&row.openTime>=0&&Number.isSafeInteger(row.closeTime)
   &&row.openTime===boundary-(15-i)*300000&&row.closeTime===row.openTime+299999);
  need(['high','low','close'].every(key=>typeof row[key]==='string'));
  const high=positive(row.high),low=positive(row.low),close=positive(row.close);
  need(high.gte(low)&&close.gte(low)&&close.lte(high));return {high,low,close};
 });
 const tr=values.slice(1).map((row,i)=>Decimal.max(row.high.minus(row.low),row.high.minus(values[i].close).abs(),row.low.minus(values[i].close).abs()));
 const mean=items=>items.reduce((sum,n)=>sum.plus(n),new Decimal(0)).div(items.length);
 const fast=mean(tr.slice(-7)),slow=mean(tr),ratio=slow.isZero()?new Decimal(1):fast.div(slow);
 const multiplier=fast.isZero()?new Decimal(1):Decimal.min(1,slow.div(fast));
 need(slow.gte(0)&&fast.gte(0)&&multiplier.gte('.5')&&multiplier.lte(1));
 return {multiplier,input:{version:input.version,candleBoundary:boundary,candles:rows.map(row=>({...row}))},
  evidence:{fastPeriod:7,slowPeriod:14,fastAtr:fixed(fast),slowAtr:fixed(slow),ratio:fixed(ratio),riskMultiplier:fixed(multiplier),lastClosedAt:boundary-1}};
}
// Prospective, bounded execution response, not a learned profit forecast. The
// dimensionless pressures compare spread/cost with the unchanged ATR distance
// and hypothetical $1-risk notional with observed opposing top-five depth.
// All three primarily reduce new-order size; no outcome or quota is an input.
// Fixed bounds are engineering choices to validate with future Demo fills.
export function deriveAdaptiveParameters({mode,long,proof,atr15,quotePrice,estimatedRoundTripCostBps,volatility}={}){
 if(!['demo','demo-futures'].includes(mode)||typeof long!=='boolean'||proof?.mode!==mode||proof.books?.length!==3||!Number.isSafeInteger(proof.books.at(-1).at))throw Error('ADAPTIVE_INPUT_INVALID');
 const atr=positive(atr15),price=positive(quotePrice),cost=new Decimal(estimatedRoundTripCostBps);
 if(!['number','string'].includes(typeof estimatedRoundTripCostBps)||!cost.isFinite()||cost.lt(0)||Math.abs(cost.e)>50)throw Error('ADAPTIVE_INPUT_INVALID');
 const latest=proof.books.at(-1),bid=positive(latest.bids?.[0]?.[0]),ask=positive(latest.asks?.[0]?.[0]);
 if(bid.gte(ask))throw Error('ADAPTIVE_INPUT_INVALID');
 const depth=proof.books.map(book=>{
  const levels=long?book.asks:book.bids;if(!Array.isArray(levels)||levels.length!==5)throw Error('ADAPTIVE_INPUT_INVALID');
  return levels.reduce((sum,row)=>{if(!Array.isArray(row)||row.length!==2)throw Error('ADAPTIVE_INPUT_INVALID');return sum.plus(positive(row[0]).mul(positive(row[1])));},new Decimal(0));
 });
 const atrFraction=atr.div(price),atrBps=atrFraction.mul(10000),spreadBps=ask.minus(bid).div(ask.plus(bid).div(2)).mul(10000),
  minContraDepthUsdt=Decimal.min(...depth),theoreticalStakeUsdt=new Decimal(1).div(Decimal.min(atrFraction,'.02').plus(cost.div(10000)).plus(mode==='demo'?'.005':0)),
  spreadPressure=Decimal.min(1,spreadBps.div(atrBps)),costPressure=Decimal.min(1,cost.div(atrBps.mul(3))),liquidityPressure=Decimal.min(1,theoreticalStakeUsdt.div(minContraDepthUsdt)),
  baseRiskScale=new Decimal(1).div(new Decimal(1).plus(spreadPressure).plus(costPressure).plus(liquidityPressure)),
  response=volatility===undefined?null:volatilityResponse(volatility),
  riskScale=response?Decimal.max('.25',baseRiskScale.mul(response.multiplier)):baseRiskScale;
 return {version:response?ADAPTIVE_FLOW_VERSION:LEGACY_ADAPTIVE_FLOW_VERSION,calibration:'prospective_rule_not_fitted',
  minTakerShare:fixed(new Decimal('.55').plus(spreadPressure.mul('.03')).plus(liquidityPressure.mul('.02'))),
  costBufferBps:fixed(new Decimal(30).plus(spreadPressure.mul(10))),riskScale:fixed(riskScale),riskBudgetUsdt:fixed(riskScale),
  inputs:{mode,long,atr15:atr.toFixed(),quotePrice:price.toFixed(),estimatedRoundTripCostBps:cost.toFixed(),...(response?{volatility:response.input}:{})},
  evidence:{atrBps:fixed(atrBps),spreadBps:fixed(spreadBps),minContraDepthUsdt:fixed(minContraDepthUsdt),theoreticalStakeUsdt:fixed(theoreticalStakeUsdt),spreadPressure:fixed(spreadPressure),costPressure:fixed(costPressure),liquidityPressure:fixed(liquidityPressure),flowSampledAt:latest.at,
   ...(response?{baseRiskScale:fixed(baseRiskScale),volatility:response.evidence}:{})}};
}
