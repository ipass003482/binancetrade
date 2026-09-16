// Shared deterministic Demo signal and offline benchmark. No order client here.
import { timeframeSpec } from './timeframe.mjs';
import { evaluateEntryQuality } from './entry-quality.mjs';
export const BASELINE_VERSION='buffered-breakout-atr-v3';
export function baselineDecision({candles,mode,pair,cost,now,timeframe='15m'}){
 const spec=timeframeSpec(timeframe);
 const directionChecks=[];
 const hold=reasons=>({version:BASELINE_VERSION,action:'hold',timeframe,reasons,directionChecks});
 if(!Array.isArray(candles)||candles.length<spec.historyBars)return hold(['BASELINE_WARMUP']);
 const rows=candles.slice(-spec.historyBars),last=rows.at(-1),boundary=last.closeTime+1;
 if(!Number.isSafeInteger(boundary)||!Number.isSafeInteger(now??boundary)||(now??boundary)<boundary)return hold(['BASELINE_CANDLE_NOT_CLOSED']);
 const snapshot={mode,timeframe,createdAt:new Date(now??boundary).toISOString(),candleBoundary:boundary,
  markets:[{pair,candles:rows,verifiedSpot:mode!=='demo-futures',verifiedFutures:mode==='demo-futures'}],
  evidence:[{id:(mode==='demo-futures'?'futures:':'spot:')+pair,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}]};
 if(cost?.status!=='ok'||!Number.isFinite(Number(cost.requiredPriceSpaceBps))||Number(cost.requiredPriceSpaceBps)<0)return hold(['BASELINE_COSTS_REQUIRED']);
 const directions=mode==='demo-futures'?['open-long','open-short']:['buy'];
 const reasons=[];
 for(const action of directions){
  const q=evaluateEntryQuality({snapshot,proposal:{pair,action,evidenceIds:[snapshot.evidence[0].id]},analyst:{style:'active'},now:now??boundary});
  const check={action,eligible:false,reasons:[...q.reasons],metrics:q.metrics};directionChecks.push(check);
  const reject=reason=>{check.reasons.push(reason);reasons.push(reason);};
  if(!q.eligible){reasons.push(...q.reasons);continue;}
  const long=action!=='open-short',close=Number(last.close);
  // Include the previous bar and exclude only the completed signal bar.
  const prior=rows.slice(-21,-1);
  const level=long?Math.max(...prior.map(c=>Number(c.high))):Math.min(...prior.map(c=>Number(c.low)));
  const atr=rows.slice(-14).reduce((sum,c,i)=>{const prior=Number(rows[rows.length-15+i].close);return sum+Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-prior),Math.abs(Number(c.low)-prior));},0)/14;
  if(!Number.isFinite(atr)||atr<=0){reject('BASELINE_ATR_INVALID');continue;}
  const breakoutBuffer=atr*.1,trigger=level+(long?breakoutBuffer:-breakoutBuffer);
  check.breakout={level,trigger,close,atr,bufferAtr:.1};
  if(long?close<=trigger:close>=trigger){reject('BASELINE_BUFFERED_BREAKOUT_REQUIRED');continue;}
  const targetFraction=2*atr/close,stopFraction=Math.min(atr/close,.02);
  check.costSpace={targetBps:targetFraction*10000,requiredBps:Number(cost.requiredPriceSpaceBps)};
  if(targetFraction>1||stopFraction<=0){reject('BASELINE_PLAN_INVALID');continue;}
  if(targetFraction*10000<Number(cost.requiredPriceSpaceBps)){reject('BASELINE_PRICE_SPACE_TOO_SMALL');continue;}
  check.eligible=true;
  return {version:BASELINE_VERSION,action,pair,timeframe,signalAt:boundary,level,trigger,breakoutBuffer,atr,targetFraction,stopFraction,maxHoldingBars:spec.maxHoldingBars,maxHoldingSeconds:spec.maxHoldingSeconds,directionChecks,
   requiredPriceSpaceBps:cost.requiredPriceSpaceBps,note:'One completed close beyond previous 20-bar extreme plus 0.1 ATR buffer; 1 ATR stop capped at 2%, 2 ATR target. Not an expected-return forecast.'};
 }
 return hold([...new Set(reasons)]);
}
export function validateDataset(d){
 const spec=timeframeSpec(d?.timeframe),M=spec.ms;
 if(d?.schemaVersion!==1||!['demo','demo-futures'].includes(d.mode)||!Array.isArray(d.candles)||d.candles.length<spec.historyBars+1||typeof d.pair!=='string')throw Error('BASELINE_DATA_INVALID');
 if(!(d.mode==='demo-futures'?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(d.pair))throw Error('BASELINE_PAIR_INVALID');
 for(const [i,c] of d.candles.entries()){
  if(!Number.isSafeInteger(c.openTime)||c.openTime%M!==0||c.closeTime!==c.openTime+M-1||(i&&c.openTime!==d.candles[i-1].openTime+M))throw Error('BASELINE_GAP_OR_INVALID_TIME');
  const values=['open','high','low','close','volume'].map(k=>typeof c[k]==='string'&&c[k].trim()||typeof c[k]==='number'?Number(c[k]):NaN);
  if(values.some(v=>!Number.isFinite(v))||values.slice(0,4).some(v=>v<=0)||values[4]<0||values[1]<Math.max(values[0],values[2],values[3])||values[2]>Math.min(values[0],values[1],values[3]))throw Error('BASELINE_OHLC_INVALID');
 }
 if(d.mode==='demo-futures'){
  const f=d.funding;
  if(!f||f.complete!==true||!Number.isSafeInteger(f.from)||!Number.isSafeInteger(f.to)||f.from>d.candles[0].openTime||f.to<d.candles.at(-1).closeTime||!Array.isArray(f.events))throw Error('BASELINE_FUNDING_COVERAGE_REQUIRED');
  let previous=-1;
  for(const e of f.events){if(!Number.isSafeInteger(e.time)||e.time%M!==0||e.time<=previous||e.time<f.from||e.time>f.to||typeof e.rate!=='string'||!Number.isFinite(Number(e.rate))||typeof e.markPrice!=='string'||!(Number(e.markPrice)>0)||!Number.isFinite(Number(e.markPrice)))throw Error('BASELINE_FUNDING_INVALID');previous=e.time;}
 }
 return d;
}
export function backtestBaseline(dataset,{initialCapital=2000,stakeUsdt=150,buyRate,sellRate,slippageBpsPerSide=5,priceSpaceBufferBps=30,decide=baselineDecision}={}){
 const d=validateDataset(dataset),spec=timeframeSpec(d.timeframe);
 for(const v of [initialCapital,stakeUsdt,buyRate,sellRate,slippageBpsPerSide,priceSpaceBufferBps])if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error('BASELINE_CONFIG_INVALID');
 if(initialCapital<=0||stakeUsdt<=0||stakeUsdt>initialCapital||buyRate>.1||sellRate>.1||slippageBpsPerSide>100||priceSpaceBufferBps>1000)throw Error('BASELINE_CONFIG_INVALID');
 let cash=initialCapital,position=null,pending=null,peak=initialCapital,maxDrawdown=0,maxDrawdownPct=0;
 let lastFunding=0,eventIndex=0;const events=d.funding?.events??[],trades=[],curve=[],signals=[];
 const slip=slippageBpsPerSide/10000;
 const close=(price,at,reason)=>{
  const p=position,fill=price*(1+(p.short?slip:-slip)),fee=fill*p.amount*(p.short?buyRate:sellRate);
  const gross=(fill-p.entry)*p.amount*(p.short?-1:1),net=gross-p.entryFee-fee+p.funding;
  cash+=gross-fee;trades.push({...p,exit:fill,closedAt:at,reason,gross,exitFee:fee,net});position=null;
 };
 for(let i=0;i<d.candles.length;i++){
  const c=d.candles[i];
  // Apply boundary funding to positions already open; a new fill at this boundary is later.
  while(eventIndex<events.length&&events[eventIndex].time<=c.openTime){const e=events[eventIndex++];lastFunding=Number(e.rate);if(position){const payment=position.amount*Number(e.markPrice)*lastFunding*(position.short?1:-1);cash+=payment;position.funding+=payment;}}
  if(pending&&!position){
   const short=pending.action==='open-short',entry=Number(c.open)*(1+(short?-slip:slip)),amount=stakeUsdt/entry,entryFee=stakeUsdt*(short?sellRate:buyRate);
   if(cash>=stakeUsdt+entryFee){position={short,openedAt:c.openTime,signalAt:pending.signalAt,entry,amount,entryFee,funding:0,
    stop:entry*(1+(short?pending.stopFraction:-pending.stopFraction)),target:entry*(1+(short?-pending.targetFraction:pending.targetFraction)),entryIndex:i,maxHoldingBars:pending.maxHoldingBars};cash-=entryFee;}
   pending=null;
  }
  if(position){
   const p=position,o=Number(c.open),h=Number(c.high),l=Number(c.low);
   if(i-p.entryIndex>=p.maxHoldingBars)close(o,c.openTime,'time_exit');
   else if(p.short?o>=p.stop:o<=p.stop)close(o,c.openTime,'gap_stop');
   else if(p.short?h>=p.stop:l<=p.stop)close(p.stop,c.closeTime,'stop_first_if_both');
   else if(p.short?l<=p.target:h>=p.target)close(p.target,c.closeTime,'target');
  }
  // Current cost assumptions are deliberately fixed, not reconstructed historical account fees.
  const cost={status:'ok',requiredPriceSpaceBps:String((buyRate+sellRate)*10000+2*slippageBpsPerSide+Math.abs(lastFunding)*10000+priceSpaceBufferBps)};
  if(i>=spec.historyBars-1&&!position){const decision=decide({candles:d.candles.slice(Math.max(0,i-spec.historyBars+1),i+1),timeframe:spec.timeframe,mode:d.mode,pair:d.pair,cost,now:c.closeTime+1});signals.push({at:c.closeTime+1,action:decision.action,reasons:decision.reasons});if(decision.action!=='hold'&&i<d.candles.length-1)pending=decision;}
  const equity=cash+(position?(Number(c.close)-position.entry)*position.amount*(position.short?-1:1):0);
  peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-equity)/peak*100);
  curve.push({at:c.closeTime,equity});
 }
 if(position)close(Number(d.candles.at(-1).close),d.candles.at(-1).closeTime,'end_of_sample');
 peak=Math.max(peak,cash);maxDrawdown=Math.max(maxDrawdown,peak-cash);maxDrawdownPct=Math.max(maxDrawdownPct,(peak-cash)/peak*100);
 curve.push({at:d.candles.at(-1).closeTime,equity:cash,liquidated:true});
 const stats=items=>({trades:items.length,netUsdt:items.reduce((s,t)=>s+t.net,0),wins:items.filter(t=>t.net>0).length});
 return {version:BASELINE_VERSION,timeframe:spec.timeframe,mode:d.mode,pair:d.pair,simulation:true,outOfSample:false,source:d.source,from:d.candles[0].openTime,to:d.candles.at(-1).closeTime,
  config:{initialCapital,stakeUsdt,buyRate,sellRate,slippageBpsPerSide,priceSpaceBufferBps},finalEquity:cash,netUsdt:cash-initialCapital,returnPct:(cash/initialCapital-1)*100,
  sampledMaxDrawdownUsdt:maxDrawdown,sampledMaxDrawdownPct:maxDrawdownPct,long:stats(trades.filter(t=>!t.short)),short:stats(trades.filter(t=>t.short)),trades,curve,signals,
  limitations:['Historical simulation, not AI strategy or verified future edge. One instrument, 1x, fixed quote notional; no portfolio aggregation.',
   'Signals only see completed bars; fills at next open. Stop before target within ambiguous bars; gaps filled at worse open. Drawdown sampled at closes, not tick maximum.',
   'Fixed fee/slippage assumptions; no order book, queue, outages, quantity rounding or guaranteed fill. Funding events only for positions held at event time.',
   'Live engine also retains existing ROI and spot trailing protection; this baseline models structured rule exits only, so it is not exact live-engine parity.',
   'Whole period is descriptive. No parameter search or retrospective out-of-sample label. Buy-and-hold comparison must match exposure and period.']};
}
