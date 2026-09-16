// Offline experiment only. Never imported by the trading bridge or scheduler.
import { evaluateEntryQuality } from './entry-quality.mjs';
import { baselineDecision } from './baseline.mjs';
export const VARIANTS=['control-5m','atr15m','atr15m-hour1'];
export const BAR=300000;
export function aggregateClosed15m(candles,now){
 const out=[];
 for(let i=0;i<candles.length;i++){
  const a=candles[i],b=candles[i+1],c=candles[i+2];
  if(a.openTime%900000||!b||!c||b.openTime!==a.openTime+BAR||c.openTime!==a.openTime+2*BAR||c.closeTime>=now)continue;
  out.push({openTime:a.openTime,closeTime:c.closeTime,open:a.open,close:c.close,
   high:Math.max(Number(a.high),Number(b.high),Number(c.high)),low:Math.min(Number(a.low),Number(b.low),Number(c.low)),
   volume:Number(a.volume)+Number(b.volume)+Number(c.volume)});i+=2;
 }
 return out;
}
export function atr14(rows){
 if(rows.length<15)return null;
 return rows.slice(-14).reduce((sum,c,i)=>{const p=Number(rows[rows.length-15+i].close);return sum+Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-p),Math.abs(Number(c.low)-p));},0)/14;
}
export function featureFrame({candles,mode,pair,now}){
 const rows=candles.slice(-96),last=rows.at(-1);
 if(rows.length!==96||last.closeTime+1!==now)throw Error('EXPERIMENT_FRAME_ALIGNMENT');
 const snapshot={mode,timeframe:'5m',createdAt:new Date(now).toISOString(),candleBoundary:now,
  markets:[{pair,candles:rows,verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures'}],
  evidence:[{id:(mode==='demo-futures'?'futures:':'spot:')+pair,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}]};
 const atr5=atr14(rows),atr15=atr14(aggregateClosed15m(rows,now)),close=Number(last.close);
 const prior=rows.slice(-21,-1),high=Math.max(...prior.map(c=>Number(c.high))),low=Math.min(...prior.map(c=>Number(c.low)));
 const directions=(mode==='demo-futures'?['open-long','open-short']:['buy']).map(action=>{
  const q=evaluateEntryQuality({snapshot,proposal:{pair,action,evidenceIds:[snapshot.evidence[0].id]},analyst:{style:'active'},now});
  return {action,...q};
 });
 return {pair,mode,now,close,atr5,atr15,high,low,directions};
}
export function decideFrame(frame,variant,requiredBps){
 if(!VARIANTS.includes(variant)||!Number.isFinite(requiredBps)||requiredBps<0)throw Error('EXPERIMENT_VARIANT_OR_COST');
 const checks=[];
 for(const q of frame.directions){
  const long=q.action!=='open-short';
  const reasons=q.reasons.filter(r=>variant==='atr15m-hour1'?r!=='ENTRY_DIRECTION_NOT_ALIGNED':true);
  if(variant==='atr15m-hour1'&&(long?Number(q.metrics.return1hPct)<=0:Number(q.metrics.return1hPct)>=0))reasons.push('ENTRY_DIRECTION_NOT_ALIGNED');
  const check={action:q.action,reasons};checks.push(check);
  if(reasons.length)continue;
  // Entry trigger remains 0.1 * FIVE-minute ATR for all three arms.
  const trigger=long?frame.high+.1*frame.atr5:frame.low-.1*frame.atr5;
  if(long?frame.close<=trigger:frame.close>=trigger){reasons.push('BASELINE_BUFFERED_BREAKOUT_REQUIRED');continue;}
  const riskAtr=variant==='control-5m'?frame.atr5:frame.atr15;
  if(!(riskAtr>0)){reasons.push('BASELINE_ATR_INVALID');continue;}
  const stopFraction=Math.min(riskAtr/frame.close,.02),targetFraction=2*riskAtr/frame.close;
  if(targetFraction>1){reasons.push('BASELINE_PLAN_INVALID');continue;}
  if(targetFraction*10000<requiredBps){reasons.push('BASELINE_PRICE_SPACE_TOO_SMALL');continue;}
  return {action:q.action,pair:frame.pair,signalAt:frame.now,stopFraction,targetFraction,maxHoldingBars:48,
   atr5:frame.atr5,riskAtr,requiredBps,marginBps:targetFraction*10000-requiredBps,checks};
 }
 return {action:'hold',checks};
}
export function assertControlParity(frame,candles,costBps){
 const legacy=baselineDecision({candles,timeframe:'5m',mode:frame.mode,pair:frame.pair,now:frame.now,cost:{status:'ok',requiredPriceSpaceBps:String(costBps)}});
 const current=decideFrame(frame,'control-5m',costBps);
 if(legacy.action!==current.action||legacy.action!=='hold'&&(legacy.stopFraction!==current.stopFraction||legacy.targetFraction!==current.targetFraction))throw Error('EXPERIMENT_CONTROL_PARITY');
}
export function riskStake({budget,maxStake,available,stopFraction,costFraction}){
 if(![budget,maxStake,available,stopFraction,costFraction].every(Number.isFinite)||budget<=0||stopFraction<=0||costFraction<0)throw Error('EXPERIMENT_RISK_INPUT');
 return Math.max(0,Math.min(maxStake,available,budget/(stopFraction+costFraction)));
}
export function validateInput(d,from,to){
 if(!['demo','demo-futures'].includes(d.mode)||d.timeframe!=='5m'||!Array.isArray(d.candles)||d.candles.length<97)throw Error('EXPERIMENT_DATA_INVALID');
 if(d.candles[0].openTime!==from||d.candles.at(-1).closeTime!==to-1)throw Error('EXPERIMENT_DATA_COVERAGE');
 for(const [i,c] of d.candles.entries()){
  const v=['open','high','low','close','volume'].map(k=>Number(c[k]));
  if(c.openTime!==from+i*BAR||c.openTime%BAR||c.closeTime!==c.openTime+BAR-1||v.some(n=>!Number.isFinite(n))||v.slice(0,4).some(n=>n<=0)||v[4]<0||v[1]<Math.max(v[0],v[2],v[3])||v[2]>Math.min(v[0],v[1],v[3]))throw Error('EXPERIMENT_CANDLE_INVALID');
 }
 if(d.mode==='demo-futures'){
  const f=d.funding;
  if(!f?.events?.length||!f.complete||f.from>from||f.to<to-1)throw Error('EXPERIMENT_FUNDING_COVERAGE');
  let previous=-1;
  for(const e of f.events){if(!Number.isSafeInteger(e.time)||e.time<=previous||e.time<f.from||e.time>f.to||!Number.isFinite(Number(e.rate))||!(Number(e.markPrice)>0))throw Error('EXPERIMENT_FUNDING_INVALID');previous=e.time;}
 }
 return d;
}
// Shared 2,000-USDT portfolio per mode. Bar model, not engine ROI/trailing parity.
export function simulatePortfolio({datasets,frames,variant,config,from,to,extraSlippageBps=0}){
 const mode=datasets[0].mode;
 if(datasets.some(d=>d.mode!==mode||d.candles.length!==datasets[0].candles.length))throw Error('EXPERIMENT_PORTFOLIO_ALIGNMENT');
 let cash=config.initialCapital,peak=cash,maxDd=0,maxDdPct=0,pending=null;
 const positions=new Map(),trades=[],curve=[],dayEntries=new Map(),dayNet=new Map(),counts={eligible:0,selected:0,filled:0,tooSmall:0,riskBlocked:0},funnel={};
 const fundingState=new Map(datasets.map(d=>[d.pair,{index:0,lastRate:0}]));
 const fees=d=>config.fees[d.pair], slip=d=>(config.slippageBpsPerSide+extraSlippageBps+fees(d).spreadBps/2)/10000;
 const day=t=>new Date(t).toISOString().slice(0,10);
 const charge=(amount,t)=>{cash+=amount;dayNet.set(day(t),(dayNet.get(day(t))??0)+amount);};
 const close=(d,p,raw,t,reason)=>{
  const fill=raw*(1+(p.short?slip(d):-slip(d))),exitFee=fill*p.amount*(p.short?fees(d).buyRate:fees(d).sellRate);
  const gross=(fill-p.entry)*p.amount*(p.short?-1:1);charge(gross-exitFee,t);
  trades.push({...p,closedAt:t,exit:fill,exitFee,gross,net:gross-p.entryFee-exitFee+p.funding,reason});positions.delete(d.pair);
 };
 for(let i=0;i<datasets[0].candles.length;i++){
  const t=datasets[0].candles[i].openTime;if(t>=to)break;
  const active=t>=from;
  // Funding exactly at the open belongs to positions held before that open.
  for(const d of datasets){const st=fundingState.get(d.pair),events=d.funding?.events??[];
   while(st.index<events.length&&events[st.index].time<=t){const e=events[st.index++];st.lastRate=Number(e.rate);const p=positions.get(d.pair);if(p){const payment=p.amount*Number(e.markPrice)*Number(e.rate)*(p.short?1:-1);p.funding+=payment;charge(payment,e.time);}}
  }
  if(active&&pending){
   const d=datasets.find(x=>x.pair===pending.pair),c=d.candles[i],short=pending.action==='open-short',f=fees(d);
   const used=[...positions.values()].reduce((s,p)=>s+p.stake,0),available=Math.min(config.maxExposure-used,cash-used);
   const costFraction=f.buyRate+f.sellRate+2*slip(d)+Math.abs(fundingState.get(d.pair).lastRate);
   let stake=riskStake({budget:config.riskBudgetUsdt,maxStake:config.maxStake,available,stopFraction:pending.stopFraction,costFraction});
   const entry=Number(c.open)*(1+(short?-slip(d):slip(d)));
   // Current symbol lot/minimum filters are assumptions for historical fills.
   const amount=Math.floor((stake/entry)/f.stepSize)*f.stepSize;stake=amount*entry;
   const entryFee=stake*(short?f.sellRate:f.buyRate),date=day(t);
   if(stake<f.minNotional||amount<f.minQty)counts.tooSmall++;
   else if(positions.size>=config.maxOpenTrades||(config.maxEntriesPerDay!==0&&(dayEntries.get(date)??0)>=config.maxEntriesPerDay)||(dayNet.get(date)??0)<=-config.maxDailyLoss||cash-used<stake+entryFee)counts.riskBlocked++;
   else{positions.set(d.pair,{pair:d.pair,short,openedAt:t,signalAt:pending.signalAt,entry,amount,stake,entryFee,funding:0,entryIndex:i,
     stop:entry*(1+(short?pending.stopFraction:-pending.stopFraction)),target:entry*(1+(short?-pending.targetFraction:pending.targetFraction)),plannedRiskUsdt:stake*(pending.stopFraction+costFraction),riskBudgetUsdt:config.riskBudgetUsdt});
    charge(-entryFee,t);dayEntries.set(date,(dayEntries.get(date)??0)+1);counts.filled++;}
   pending=null;
  }
  for(const d of datasets){
   const c=d.candles[i],st=fundingState.get(d.pair),events=d.funding?.events??[],p=positions.get(d.pair);
   const o=Number(c.open),h=Number(c.high),l=Number(c.low);
   let exit=null;
   if(p){
    if(i-p.entryIndex>=48)exit={raw:o,time:t,reason:'time_exit'};
    else if(p.short?o>=p.stop:o<=p.stop)exit={raw:o,time:t,reason:'gap_stop'};
    else if(p.short?h>=p.stop:l<=p.stop)exit={raw:p.stop,time:c.closeTime,reason:'stop_first_if_both'};
    else if(p.short?l<=p.target:h>=p.target)exit={raw:p.target,time:c.closeTime,reason:'target'};
   }
   if(exit?.time===t)close(d,p,exit.raw,exit.time,exit.reason);
   while(st.index<events.length&&events[st.index].time<=c.closeTime){const e=events[st.index++];st.lastRate=Number(e.rate);const held=positions.get(d.pair);
    if(held){let payment=held.amount*Number(e.markPrice)*Number(e.rate)*(held.short?1:-1);
     // Unknown intrabar exit ordering: charge funding debits, omit credits.
     if(exit)payment=Math.min(0,payment);held.funding+=payment;charge(payment,e.time);}
   }
   if(exit&&exit.time!==t)close(d,p,exit.raw,exit.time,exit.reason);
  }
  if(active){
   const equity=cash+datasets.reduce((sum,d)=>{const p=positions.get(d.pair);return sum+(p?(Number(d.candles[i].close)-p.entry)*p.amount*(p.short?-1:1):0);},0);
   peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak-equity);maxDdPct=Math.max(maxDdPct,(peak-equity)/peak*100);curve.push({at:t+BAR-1,equity});
  }
  const boundary=t+BAR;
  if(boundary<from||boundary>=to||i<95)continue;
  const choices=[];
  for(const d of datasets){
   const f=fees(d),costBps=(f.buyRate+f.sellRate)*10000+2*(config.slippageBpsPerSide+extraSlippageBps)+f.spreadBps+Math.abs(fundingState.get(d.pair).lastRate)*10000+config.priceSpaceBufferBps;
   const dec=decideFrame(frames.get(d.pair)[i],variant,costBps);
   for(const check of dec.checks){const bucket=funnel[check.action]??={};const reason=check.reasons[0]??'eligible';bucket[reason]=(bucket[reason]??0)+1;}
   if(dec.action!=='hold'){counts.eligible++;if(!positions.has(d.pair))choices.push(dec);}
  }
  choices.sort((a,b)=>b.marginBps-a.marginBps||a.pair.localeCompare(b.pair));
  if(choices.length&&positions.size<config.maxOpenTrades){pending=choices[0];counts.selected++;}
 }
 for(const d of datasets){const p=positions.get(d.pair);if(p){const c=d.candles.findLast(c=>c.openTime<to);close(d,p,Number(c.close),c.closeTime,'end_of_segment');}}
 peak=Math.max(peak,cash);maxDd=Math.max(maxDd,peak-cash);maxDdPct=Math.max(maxDdPct,(peak-cash)/peak*100);
 const wins=trades.filter(t=>t.net>0),losses=trades.filter(t=>t.net<0),winNet=wins.reduce((s,t)=>s+t.net,0),lossNet=-losses.reduce((s,t)=>s+t.net,0);
 const stats=items=>({trades:items.length,netUsdt:items.reduce((s,t)=>s+t.net,0)});
 return {mode,variant,from,to,extraSlippageBps,initialCapital:config.initialCapital,finalEquity:cash,netUsdt:cash-config.initialCapital,
  trades:trades.length,winRate:trades.length?wins.length/trades.length:null,meanNetUsdt:trades.length?(cash-config.initialCapital)/trades.length:null,
  profitFactor:lossNet?winNet/lossNet:null,sampledMaxDrawdownUsdt:maxDd,sampledMaxDrawdownPct:maxDdPct,
  maxPlannedRiskUsdt:Math.max(0,...trades.map(t=>t.plannedRiskUsdt)),long:stats(trades.filter(t=>!t.short)),short:stats(trades.filter(t=>t.short)),counts,funnel,tradeDetails:trades,curve};
}
