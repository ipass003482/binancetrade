import Decimal from 'decimal.js';

export const PULLBACK_ENTRY_POLICY='trend-pullback-model-v1';
// Fixed prospective hypothesis, not parameters selected by maximizing past PnL.
// Twenty bars describe the local trend; five bars its slope; twelve bars one hour.
export function modelPullback(candles,boundary,long){
 const rows=candles?.slice(-25);
 if(!Number.isSafeInteger(boundary)||boundary%300000||rows?.length!==25||typeof long!=='boolean')throw Error('MODEL_PULLBACK_DATA_INVALID');
 const bars=rows.map((r,i)=>{
  if(r.openTime!==boundary-(25-i)*300000||r.closeTime!==r.openTime+299999)throw Error('MODEL_PULLBACK_DATA_INVALID');
  const bar=['open','high','low','close'].map(k=>{
   if(!['number','string'].includes(typeof r[k])||String(r[k]).trim()==='')throw Error('MODEL_PULLBACK_DATA_INVALID');
   const d=new Decimal(r[k]);if(!d.isFinite()||d.lte(0)||Math.abs(d.e)>50)throw Error('MODEL_PULLBACK_DATA_INVALID');return d;
  });
  if(bar[1].lt(Decimal.max(...bar))||bar[2].gt(Decimal.min(...bar)))throw Error('MODEL_PULLBACK_DATA_INVALID');
  return bar;
 });
 const closes=bars.map(b=>b[3]),last=closes.at(-1),sum=a=>a.reduce((s,v)=>s.plus(v),new Decimal(0));
 const currentSum=sum(closes.slice(-20)),priorSum=sum(closes.slice(0,20));
 const aligned=(a,b)=>long?a.gt(b):a.lt(b);
 const trend=aligned(last.mul(20),currentSum)&&aligned(currentSum,priorSum)&&aligned(last,closes.at(-13));
 const pullback=[21,22,23].some(i=>aligned(closes[i-1],closes[i]));
 const reclaim=aligned(last,bars[23][long?1:2]);
 return {version:PULLBACK_ENTRY_POLICY,confirmationAt:boundary,closeTimes:rows.map(r=>r.closeTime),
  bars:bars.map(b=>b.map(v=>v.toFixed())),eligible:trend&&pullback&&reclaim,checks:{trend,pullback,reclaim}};
}

export function netRewardRisk({targetFraction,stopFraction,costFraction,reserveFraction}){
 const target=new Decimal(targetFraction),stop=new Decimal(stopFraction),cost=new Decimal(costFraction),reserve=new Decimal(reserveFraction);
 if([target,stop,cost,reserve].some(v=>!v.isFinite()||v.lt(0))||target.lte(0)||stop.lte(0))throw Error('MODEL_NET_REWARD_RISK_INVALID');
 const reward=target.minus(cost),risk=stop.plus(cost).plus(reserve);
 return {version:'net-reward-risk-v1',minimumRatio:'1',netRewardFraction:reward.toFixed(),riskFraction:risk.toFixed(),
  ratio:reward.div(risk).toFixed(),eligible:reward.gte(risk)};
}
