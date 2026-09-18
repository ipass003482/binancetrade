// Live Demo forward trial. Historical v3 remains immutable in baseline.mjs;
// the original candidate B is retained below for reproducible v4 evidence.
import Decimal from 'decimal.js';
import {FLOW_POLICY,FLOW_ONLY_POLICY,FLOW_SELECTIVITY,assessOrderFlow,assessSpotFlowContinuation,assessFuturesFlowContinuation,SPOT_FLOW_CONTINUATION_VERSION,FUTURES_FLOW_CONTINUATION_VERSION,SPOT_FLOW_QUALITY_VERSION,SPOT_FLOW_EXIT_POLICY} from './order-flow.mjs';
import { baselineDecision } from './baseline.mjs';
import { evaluateEntryQuality } from './entry-quality.mjs';
import { isEntry } from './mode.mjs';
import { timeframeSpec } from './timeframe.mjs';
import { volumeMinimum,validateVolumeAssignment } from './volume-experiment.mjs';
import {modelMomentum,MODEL_ENTRY_POLICY} from './model-momentum.mjs';
import {modelPullback,netRewardRisk,PULLBACK_ENTRY_POLICY} from './model-pullback.mjs';
import {demoRiskPolicy} from './demo-risk.mjs';
import {deriveAdaptiveParameters,closedVolatilityInput,ADAPTIVE_FLOW_VERSION,LEGACY_ADAPTIVE_FLOW_VERSION} from './adaptive-parameters.mjs';
import {decisionTiming} from './entry-timing.mjs';
export const DEMO_RULE_VERSION='kronos-direction-v12';
export const V11_RULE_VERSION='kronos-forward-v11';
export const V10_RULE_VERSION='atr15m-forward-v10';
export const DEMO_PROFIT_PROTECTION=Object.freeze({version:'net-profit-trail-v1',triggerNetUsdt:.5,givebackNetUsdt:.25,riskMultiple:.5});
const LEGACY_DEMO_RULE_VERSION='atr15m-risk-v4';
export const DEMO_PARAMETERS=Object.freeze({
 timeframe:'5m',historyBars:96,directionTimeframe:'1h',referenceTimeframe:'4h',
 relativeVolumeMinimum:.8,breakoutLookbackBars:12,breakoutBufferAtr:.1,confirmationBars:1,confirmationRetestRequired:true,
 atrPeriod:14,atrTimeframe:'15m',stopAtr:1,targetAtr:2,stopFractionCap:.02,
 maxHoldingBars:48,maxHoldingSeconds:14400,profitProtection:DEMO_PROFIT_PROTECTION
});
export const PULLBACK_DEMO_PARAMETERS=Object.freeze({...DEMO_PARAMETERS,targetAtr:3});
export const FLOW_ONLY_PARAMETERS=Object.freeze({timeframe:'5m',historyBars:96,atrPeriod:14,atrTimeframe:'15m',stopAtr:1,targetAtr:3,stopFractionCap:.02,maxHoldingBars:48,maxHoldingSeconds:14400,profitProtection:DEMO_PROFIT_PROTECTION});
export const DEMO_RISK_BUDGET_USDT=1;
export function closed15mAtr(candles,boundary){
 const groups=[];
 for(let i=0;i<candles.length-2;i++){
  const a=candles[i],b=candles[i+1],c=candles[i+2];
  if(a.openTime%900000||b.openTime!==a.openTime+300000||c.openTime!==a.openTime+600000||c.closeTime>=boundary)continue;
  groups.push({high:Math.max(Number(a.high),Number(b.high),Number(c.high)),low:Math.min(Number(a.low),Number(b.low),Number(c.low)),close:Number(c.close)});i+=2;
 }
 if(groups.length<15)throw Error('DEMO_ATR15_WARMUP');
 return groups.slice(-14).reduce((sum,c,i)=>{const prev=groups[groups.length-15+i].close;return sum+Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));},0)/14;
}
export function legacyDemoRuleDecision(args){
 const {cost,candles,timeframe}=args;
 const hold=reasons=>({version:LEGACY_DEMO_RULE_VERSION,action:'hold',timeframe,reasons,directionChecks:[]});
 if(timeframe!=='5m'||!['demo','demo-futures'].includes(args.mode))return hold(['DEMO_RULE_MODE_OR_TIMEFRAME']);
 if(cost?.status!=='ok'||!Number.isFinite(Number(cost.requiredPriceSpaceBps))||Number(cost.requiredPriceSpaceBps)<0)return hold(['BASELINE_COSTS_REQUIRED']);
 // Ask v3 only for its unchanged direction/volume/5m-breakout prerequisites.
 const signal=baselineDecision({...args,cost:{...cost,requiredPriceSpaceBps:'0'}});
 if(signal.action==='hold')return {...signal,version:LEGACY_DEMO_RULE_VERSION};
 const atr15=closed15mAtr(candles.slice(-96),candles.at(-1).closeTime+1),close=Number(candles.at(-1).close);
 const targetFraction=2*atr15/close,stopFraction=Math.min(atr15/close,.02),check=signal.directionChecks.find(c=>c.action===signal.action);
 if(!(atr15>0)||targetFraction>1)return hold(['BASELINE_PLAN_INVALID']);
 check.costSpace={targetBps:targetFraction*10000,requiredBps:Number(cost.requiredPriceSpaceBps)};
 if(targetFraction*10000<Number(cost.requiredPriceSpaceBps)){
  check.eligible=false;check.reasons.push('BASELINE_PRICE_SPACE_TOO_SMALL');
  return {...hold(['BASELINE_PRICE_SPACE_TOO_SMALL']),directionChecks:signal.directionChecks,atr15};
 }
 return {...signal,version:LEGACY_DEMO_RULE_VERSION,atrTimeframe:'15m',atr15,stopFraction,targetFraction,requiredPriceSpaceBps:cost.requiredPriceSpaceBps,
  note:'Demo forward trial B: unchanged 5m breakout and 1h/4h direction; completed 15m ATR exits; risk-sized position. Actual exchange fills determine PnL.'};
}

// Reuse every original active-quality validation, including evidence identity,
// mode/action matching, complete OHLCV, contiguous and latest completed bars,
// timestamps and both SMA guards. Only the two documented strategy choices
// (4h direction and the volume threshold) are replaced after valid metrics exist.
export function evaluateDemoEntryQuality(snapshot,proposal,now){
 const original=evaluateEntryQuality({snapshot,proposal,analyst:{style:'active'},now});
 if(!isEntry(proposal.action))return original;
 if(!snapshot||snapshot.timeframe!==DEMO_PARAMETERS.timeframe||!['demo','demo-futures'].includes(snapshot.mode))
  return {eligible:false,reasons:[...new Set([...original.reasons,'DEMO_RULE_MODE_OR_TIMEFRAME'])],metrics:original.metrics};
 if(!original.metrics)return original;
 const reasons=original.reasons.filter(reason=>!['ENTRY_DIRECTION_NOT_ALIGNED','ENTRY_RELATIVE_VOLUME_BELOW_ONE'].includes(reason));
 const metrics={...original.metrics,ruleVersion:DEMO_RULE_VERSION,
  relativeVolumeMinimum:volumeMinimum(snapshot),directionPolicy:'1h_required_4h_reference'};
 const candles=snapshot.markets.find(market=>market?.pair===proposal.pair).candles,
  lastClose=new Decimal(candles.at(-1).close),hourClose=new Decimal(candles.at(-1-timeframeSpec(snapshot.timeframe).hourBars).close),
  long=proposal.action!=='open-short';
 // Compare validated raw values rather than the display return/ratio, whose
 // decimal division can round a tiny move or near-threshold volume.
 if(long?lastClose.lte(hourClose):lastClose.gte(hourClose))reasons.push('ENTRY_DIRECTION_NOT_ALIGNED');
 // The original undefined-volume guard remains in reasons. Null is not zero.
 if(metrics.volumeVsPrior19!==null){
  const priorVolume=candles.slice(-20,-1).reduce((sum,candle)=>sum.plus(candle.volume),new Decimal(0)).div(19);
  if(new Decimal(candles.at(-1).volume).lt(priorVolume.mul(metrics.relativeVolumeMinimum)))
   reasons.push('ENTRY_RELATIVE_VOLUME_BELOW_DEMO_MIN');
 }
 return {eligible:reasons.length===0,reasons,metrics};
}

// Historical v10 evaluator retained for reproducible rule diagnostics/tests.
export function demoRuleDecision({candles,timeframe,mode,pair,cost,now,volumeExperiment}={}){
 const params=DEMO_PARAMETERS,directionChecks=[];
 const hold=reasons=>({version:V10_RULE_VERSION,action:'hold',timeframe,reasons,directionChecks});
 if(timeframe!==params.timeframe||!['demo','demo-futures'].includes(mode))return hold(['DEMO_RULE_MODE_OR_TIMEFRAME']);
 if(!Array.isArray(candles)||candles.length<params.historyBars)return hold(['BASELINE_WARMUP']);
 const rows=candles.slice(-params.historyBars),last=rows.at(-1),boundary=last?.closeTime+1,checkedAt=now??boundary;
 if(!Number.isSafeInteger(boundary)||!Number.isSafeInteger(checkedAt)||checkedAt<boundary)return hold(['BASELINE_CANDLE_NOT_CLOSED']);
 const experiment=validateVolumeAssignment(volumeExperiment,boundary);
 if(cost?.status!=='ok'||!Number.isFinite(Number(cost.requiredPriceSpaceBps))||Number(cost.requiredPriceSpaceBps)<0)
  return hold(['BASELINE_COSTS_REQUIRED']);
 const futures=mode==='demo-futures',marketId=(futures?'futures:':'spot:')+pair;
 const snapshot={mode,timeframe,createdAt:new Date(checkedAt).toISOString(),candleBoundary:boundary,volumeExperiment:experiment,
  markets:[{pair,candles:rows,verifiedSpot:!futures,verifiedFutures:futures}],
  evidence:[{id:marketId,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}]};
 const reasons=[];
 for(const action of futures?['open-long','open-short']:['buy']){
  const quality=evaluateDemoEntryQuality(snapshot,{pair,action,evidenceIds:[marketId]},checkedAt);
  const check={action,eligible:false,reasons:[...quality.reasons],metrics:quality.metrics};directionChecks.push(check);
  const reject=reason=>{check.reasons.push(reason);reasons.push(reason);};
  if(!quality.eligible){reasons.push(...quality.reasons);continue;}
  // Fix the trigger using only data available at the breakout close. The last
  // bar is a separate confirmation; it must never move its own reference level.
  const long=action!=='open-short',close=Number(last.close),signalRows=rows.slice(0,-params.confirmationBars),signal=signalRows.at(-1),
   signalClose=Number(signal.close),prior=signalRows.slice(-params.breakoutLookbackBars-1,-1);
  const level=long?Math.max(...prior.map(c=>Number(c.high))):Math.min(...prior.map(c=>Number(c.low)));
  const atr=signalRows.slice(-params.atrPeriod).reduce((sum,c,i)=>{
   const previous=Number(signalRows[signalRows.length-params.atrPeriod-1+i].close);
   return sum+Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-previous),Math.abs(Number(c.low)-previous));
  },0)/params.atrPeriod;
  if(!Number.isFinite(atr)||atr<=0){reject('BASELINE_ATR_INVALID');continue;}
  const breakoutBuffer=atr*params.breakoutBufferAtr,trigger=level+(long?breakoutBuffer:-breakoutBuffer);
  check.breakout={level,trigger,close,atr,bufferAtr:params.breakoutBufferAtr,lookbackBars:params.breakoutLookbackBars,
   signalClose,signalAt:signal.closeTime+1,confirmationAt:boundary,confirmationBars:params.confirmationBars};
  if(long?signalClose<=trigger:signalClose>=trigger){reject('DEMO_PREVIOUS_BAR_BREAKOUT_REQUIRED');continue;}
  if(long?close<=trigger:close>=trigger){reject('DEMO_BREAKOUT_CONFIRMATION_FAILED');continue;}
  // The trigger is fixed at breakout time; a completed retest must reclaim it.
  const retestExtreme=Number(long?last.low:last.high);
  check.breakout.retestExtreme=retestExtreme;check.breakout.retestRequired=true;
  if(long?retestExtreme>trigger:retestExtreme<trigger){reject('DEMO_BREAKOUT_RETEST_REQUIRED');continue;}
  const atr15=closed15mAtr(rows,boundary),targetFraction=params.targetAtr*atr15/close,
   stopFraction=Math.min(params.stopAtr*atr15/close,params.stopFractionCap);
  if(!Number.isFinite(atr15)||atr15<=0||!Number.isFinite(targetFraction)||targetFraction>1||stopFraction<=0){reject('BASELINE_PLAN_INVALID');continue;}
  check.costSpace={targetBps:targetFraction*10000,requiredBps:Number(cost.requiredPriceSpaceBps)};
  if(targetFraction*10000<Number(cost.requiredPriceSpaceBps)){reject('BASELINE_PRICE_SPACE_TOO_SMALL');continue;}
  check.eligible=true;
  return {version:V10_RULE_VERSION,action,pair,timeframe,signalAt:boundary,level,trigger,breakoutBuffer,atr,
   entryConfirmation:{version:'retest-reclaim-v1',...check.breakout},
   atrTimeframe:params.atrTimeframe,atr15,targetFraction,stopFraction,maxHoldingBars:params.maxHoldingBars,
   maxHoldingSeconds:params.maxHoldingSeconds,directionChecks,requiredPriceSpaceBps:cost.requiredPriceSpaceBps,
   profitProtection:params.profitProtection,volumeExperiment:experiment,
   note:'Demo forward v10 keeps v9 entries, initial ATR exits and risk sizing. At 0.50 USDT net unrealized profit, persist the observed peak and tighten the native stop to peak minus 0.25 USDT, accounting for fees and funding. Actual fills determine realized PnL; the stop price is not a guaranteed fill.'};
 }
 return hold([...new Set(reasons)]);
}
// v11 replaces technical entry opinions with the validated pretrained forecast.
// Generic evidence, closed-candle, source, identity and time validation remain.
export function evaluateModelEntryQuality(snapshot,proposal,now){
 const q=evaluateEntryQuality({snapshot,proposal,analyst:{style:'active'},now});
 const replaced=new Set(['ENTRY_DIRECTION_NOT_ALIGNED','ENTRY_PRICE_NOT_BEYOND_BOTH_SMA',
  'ENTRY_RELATIVE_VOLUME_UNDEFINED','ENTRY_RELATIVE_VOLUME_BELOW_ONE']);
 const reasons=q.reasons.filter(reason=>!replaced.has(reason));
 if(snapshot?.timeframe!=='5m'||!['demo','demo-futures'].includes(snapshot?.mode))reasons.push('MODEL_MODE_OR_TIMEFRAME');
 return {...q,eligible:reasons.length===0,reasons,metrics:q.metrics?{...q.metrics,ruleVersion:DEMO_RULE_VERSION,entrySignalEngine:'kronos_pretrained',technicalIndicatorsRole:'context_only'}:null};
}
export function v11ModelRuleDecision({snapshot,pair,cost,modelEvidence,quote,now=Date.now()}={}){
 const {mode,timeframe}=snapshot??{},directionChecks=[];
 const hold=reasons=>({version:V11_RULE_VERSION,pair,action:'hold',timeframe,reasons,directionChecks,entrySignalEngine:'kronos_pretrained'});
 if(!['demo','demo-futures'].includes(mode)||timeframe!=='5m')return hold(['MODEL_MODE_OR_TIMEFRAME']);
 if(snapshot.volumeExperiment!=null)return hold(['MODEL_VOLUME_EXPERIMENT_NOT_SUPPORTED']);
 if(modelEvidence?.status!=='ok'||modelEvidence.entryAllowed!==true)return hold([modelEvidence?.reason??'MODEL_EVIDENCE_REQUIRED']);
 const matches=snapshot.markets?.filter(m=>m.pair===pair)??[],market=matches[0];
 const rows=modelEvidence.prediction?.forecasts?.filter(r=>r.pair===pair)??[],row=rows[0];
 if(matches.length!==1||rows.length!==1)return hold(['MODEL_PAIR_FORECAST_UNAVAILABLE']);
 try{
  const origin=new Decimal(market.candles.at(-1).close),target=new Decimal(row.forecastCloses.at(-1));
  if(!target.isFinite()||target.lte(0)||!origin.eq(row.originClose))return hold(['MODEL_PRICE_INVALID']);
  const long=target.gt(origin),action=long?(mode==='demo'?'buy':'open-long'):'open-short';
  if(target.eq(origin)||!long&&mode==='demo')return hold(['MODEL_NO_ALLOWED_DIRECTION']);
  const quality=evaluateModelEntryQuality(snapshot,{pair,action,evidenceIds:[(mode==='demo'?'spot:':'futures:')+pair]},now);
  const check={action,eligible:false,reasons:[...quality.reasons],metrics:quality.metrics?{...quality.metrics,ruleVersion:V11_RULE_VERSION}:quality.metrics};directionChecks.push(check);
  if(!quality.eligible)return hold(quality.reasons);
  if(cost?.status!=='ok')return hold(['ENTRY_COSTS_UNAVAILABLE']);
  const required=new Decimal(cost.requiredPriceSpaceBps),reserve=new Decimal(cost.estimatedRoundTripCostBps);
  const price=new Decimal(long?(quote??market).ask:(quote??market).bid);
  if(!required.isFinite()||!reserve.isFinite()||reserve.lt(0)||required.lt(reserve)||!price.isFinite()||price.lte(0))return hold(['MODEL_COST_OR_QUOTE_INVALID']);
  const edge=target.div(price).minus(1).mul(long?10000:-10000);
  check.model={forecastClose:target.toFixed(),quotePrice:price.toFixed(),forecastMoveBps:edge.toFixed(),requiredPriceSpaceBps:required.toFixed()};
  if(edge.lte(required))return hold(['MODEL_PRICE_SPACE_TOO_SMALL']);
  const atr15=closed15mAtr(market.candles,snapshot.candleBoundary),targetFraction=DEMO_PARAMETERS.targetAtr*atr15/Number(origin),
   stopFraction=Math.min(DEMO_PARAMETERS.stopAtr*atr15/Number(origin),DEMO_PARAMETERS.stopFractionCap);
  if(!Number.isFinite(atr15)||atr15<=0||!Number.isFinite(targetFraction)||targetFraction>1||stopFraction<=0)return hold(['BASELINE_PLAN_INVALID']);
  if(new Decimal(targetFraction).mul(10000).lt(required))return hold(['BASELINE_PRICE_SPACE_TOO_SMALL']);
  check.eligible=true;
  return {version:V11_RULE_VERSION,pair,action,timeframe,signalAt:snapshot.candleBoundary,atrTimeframe:'15m',atr15,
   targetFraction,stopFraction,maxHoldingBars:DEMO_PARAMETERS.maxHoldingBars,maxHoldingSeconds:DEMO_PARAMETERS.maxHoldingSeconds,
   requiredPriceSpaceBps:required.toFixed(),forecastMoveBps:edge.toFixed(),selectionScoreBps:edge.minus(required).toFixed(),
   directionChecks,profitProtection:DEMO_PROFIT_PROTECTION,entrySignalEngine:'kronos_pretrained',
   entryConfirmation:{version:'kronos-close-path-v1',confirmationAt:snapshot.candleBoundary,modelFingerprint:modelEvidence.modelFingerprint,
    predictionSha256:modelEvidence.predictionSha256,issuedAt:modelEvidence.prediction.issuedAt,targetCloseAt:row.targetCloseAt,
    originClose:origin.toFixed(),forecastClose:target.toFixed(),quotePrice:price.toFixed(),forecastMoveBps:edge.toFixed()},
   note:'v11 model chooses direction and entry eligibility; host costs/risk/closed-data guards and v10 native exits remain. Forecast return is not realized PnL.'};
 }catch{return hold(['MODEL_PLAN_INVALID']);}
}
// v12 tests directional consistency with actual Demo fills. ATR describes the
// planned exit distance; it is not a forecast or proof of expected net profit.
export function historicalNetEdgeDecision(args){return directionalDecision(args,false);}
export function historicalPullbackDecision(args){return directionalDecision(args,true);}
export function modelRuleDecision(args){return directionalDecision(args,true,true);}
function directionalDecision({snapshot,pair,cost,modelEvidence,quote,now=Date.now()}={},pullback,flow=false){
 const entryPolicy=flow?FLOW_POLICY:pullback?PULLBACK_ENTRY_POLICY:MODEL_ENTRY_POLICY;
 const priceSignalDiagnostics=[];
 let flowDiagnostics=null,entryRoute=null;
 if(pullback)for(const long of [true,false]){
  if(snapshot?.mode==='demo'&&!long)continue;
  try{const p=modelPullback(snapshot?.markets?.find(m=>m.pair===pair)?.candles,snapshot.candleBoundary,long);
   priceSignalDiagnostics.push({direction:long?'long':'short',eligible:p.eligible,checks:p.checks});
  }catch{priceSignalDiagnostics.push({direction:long?'long':'short',eligible:false,reason:'PRICE_DATA_INVALID'});}
 }

 const {mode,timeframe}=snapshot??{},directionChecks=[];
 const hold=reasons=>({version:DEMO_RULE_VERSION,pair,action:'hold',timeframe,reasons,directionChecks,entrySignalEngine:'kronos_pretrained',entryPolicyVersion:entryPolicy,...(pullback?{priceSignalDiagnostics}:{}),...(flow?{flowDiagnostics}:{})});
 if(!['demo','demo-futures'].includes(mode)||timeframe!=='5m')return hold(['MODEL_MODE_OR_TIMEFRAME']);
 if(snapshot.volumeExperiment!=null)return hold(['MODEL_VOLUME_EXPERIMENT_NOT_SUPPORTED']);
 if(modelEvidence?.status!=='ok'||modelEvidence.entryAllowed!==true)return hold([modelEvidence?.reason??'MODEL_EVIDENCE_REQUIRED']);
 const matches=snapshot.markets?.filter(m=>m.pair===pair)??[],market=matches[0];
 const rows=modelEvidence.prediction?.forecasts?.filter(r=>r.pair===pair)??[],row=rows[0];
 if(matches.length!==1||rows.length!==1)return hold(['MODEL_PAIR_FORECAST_UNAVAILABLE']);
 try{
  const origin=new Decimal(market.candles.at(-1).close);
  if(!origin.isFinite()||origin.lte(0)||!origin.eq(row.originClose)||!Array.isArray(row.forecastCloses)||row.forecastCloses.length!==3)return hold(['MODEL_PRICE_INVALID']);
  const path=row.forecastCloses.map(v=>new Decimal(v));
  if(path.some(v=>!v.isFinite()||v.lte(0)))return hold(['MODEL_PRICE_INVALID']);
  const long=path.every(v=>v.gt(origin)),short=path.every(v=>v.lt(origin)),target=path.at(-1);
  if(!long&&!short)return hold(['MODEL_DIRECTION_PATH_INCONSISTENT']);
  if(short&&mode==='demo')return hold(['MODEL_NO_ALLOWED_DIRECTION']);
  const action=long?(mode==='demo'?'buy':'open-long'):'open-short';
  const quality=evaluateModelEntryQuality(snapshot,{pair,action,evidenceIds:[(mode==='demo'?'spot:':'futures:')+pair]},now);
  const check={action,eligible:false,reasons:[...quality.reasons],metrics:quality.metrics};directionChecks.push(check);
  if(!quality.eligible)return hold(quality.reasons);
  const priceConfirmation=(pullback?modelPullback:modelMomentum)(market.candles,snapshot.candleBoundary,long);
  check.priceConfirmation=priceConfirmation;
  if(flow){
   flowDiagnostics=assessOrderFlow(market.orderFlow,{mode,pair,long,now});
   entryRoute=priceConfirmation.eligible?'pullback':priceConfirmation.checks.trend&&flowDiagnostics.eligible?'order-flow':null;
   if(!entryRoute)return hold(['MODEL_PRICE_AND_FLOW_UNCONFIRMED']);
  }else if(!priceConfirmation.eligible)return hold([pullback?'MODEL_TREND_PULLBACK_UNCONFIRMED':'MODEL_OBSERVED_MOMENTUM_CONFLICT']);
  if(cost?.status!=='ok')return hold(['ENTRY_COSTS_UNAVAILABLE']);
  const required=new Decimal(cost.requiredPriceSpaceBps),reserve=new Decimal(cost.estimatedRoundTripCostBps);
  const price=new Decimal(long?(quote??market).ask:(quote??market).bid);
  if(!required.isFinite()||!reserve.isFinite()||reserve.lt(0)||required.lt(reserve)||(pullback&&required.lt(reserve.plus(30)))||!price.isFinite()||price.lte(0))return hold(['MODEL_COST_OR_QUOTE_INVALID']);
  const edge=target.div(price).minus(1).mul(long?10000:-10000);
  check.model={forecastCloses:path.map(v=>v.toFixed()),originClose:origin.toFixed(),forecastClose:target.toFixed(),
   quotePrice:price.toFixed(),forecastMoveBps:edge.toFixed(),requiredPriceSpaceBps:required.toFixed(),
   directionPolicy:'all-three-same-side-of-origin',costGate:pullback?'atr-space-and-net-reward-risk':'forecast-net-edge-and-atr-space',forecastAmplitudeCoversCosts:edge.gt(required)};
  if(edge.lte(0))return hold(['MODEL_FORECAST_ALREADY_PASSED']);
  const atr15=closed15mAtr(market.candles,snapshot.candleBoundary),targetAtr=pullback?PULLBACK_DEMO_PARAMETERS.targetAtr:DEMO_PARAMETERS.targetAtr,
   targetFraction=targetAtr*atr15/Number(origin),stopFraction=Math.min(DEMO_PARAMETERS.stopAtr*atr15/Number(origin),DEMO_PARAMETERS.stopFractionCap);
  if(!Number.isFinite(atr15)||atr15<=0||!Number.isFinite(targetFraction)||targetFraction>1||stopFraction<=0)return hold(['BASELINE_PLAN_INVALID']);
  const targetBps=new Decimal(targetFraction).mul(10000);
  check.costSpace={targetBps:targetBps.toFixed(),requiredBps:required.toFixed(),basis:pullback?'planned_3x_closed_15m_atr_exit_not_forecast_return':'planned_2x_closed_15m_atr_exit_not_forecast_return'};
  if(targetBps.lt(required))return hold(['BASELINE_PRICE_SPACE_TOO_SMALL']);
  // ATR is an exit distance, not evidence that the model can pay trading costs.
  // Compare the unchanged forecast with the executable quote, using full costs
  // and the existing buffer. Strict equality leaves no forecast surplus.
  if(!pullback&&edge.lte(required))return hold(['MODEL_FORECAST_COST_SHORTFALL']);
  if(pullback){
   check.netRewardRisk=netRewardRisk({targetFraction,stopFraction,costFraction:reserve.div(10000),reserveFraction:demoRiskPolicy(mode).reserveFraction});
   if(!check.netRewardRisk.eligible)return hold(['MODEL_NET_REWARD_RISK_TOO_SMALL']);
  }
  check.eligible=true;
  return {version:DEMO_RULE_VERSION,entryPolicyVersion:entryPolicy,...(pullback?{priceSignalDiagnostics}:{}),...(flow?{flowDiagnostics,entryRoute}:{}),pair,action,timeframe,signalAt:snapshot.candleBoundary,atrTimeframe:'15m',atr15,targetAtr,
   targetFraction,stopFraction,maxHoldingBars:DEMO_PARAMETERS.maxHoldingBars,maxHoldingSeconds:DEMO_PARAMETERS.maxHoldingSeconds,
   requiredPriceSpaceBps:required.toFixed(),forecastMoveBps:edge.toFixed(),selectionScoreBps:(pullback?new Decimal(check.netRewardRisk.netRewardFraction).minus(check.netRewardRisk.riskFraction).mul(10000):edge.minus(required)).toFixed(),
   selectionScoreBasis:pullback?'planned_net_reward_minus_stressed_risk_not_expected_return':'forecast_minus_required_cost_space_not_expected_return',directionChecks,
   profitProtection:DEMO_PROFIT_PROTECTION,entrySignalEngine:'kronos_pretrained',
   entryConfirmation:{version:'kronos-direction-atr-v1',priceConfirmation,...(flow?{entryRoute,orderFlow:entryRoute==='order-flow'?market.orderFlow:null,flowDiagnostics}:{}),confirmationAt:snapshot.candleBoundary,modelFingerprint:modelEvidence.modelFingerprint,
    predictionSha256:modelEvidence.predictionSha256,issuedAt:modelEvidence.prediction.issuedAt,targetCloseAt:row.targetCloseAt,
    originClose:origin.toFixed(),forecastClose:target.toFixed(),forecastCloses:path.map(v=>v.toFixed()),quotePrice:price.toFixed(),
    forecastMoveBps:edge.toFixed(),atr15,targetAtr,targetFraction},
   note:flow?'Prospective trend-pullback-flow-v1 Demo: trend and model direction plus either original pullback/reclaim OR sampled taker flow and persistent top-five depth support. Missing flow disables only its own route. Actual fills and fee-adjusted PnL remain unproven.':pullback?'Prospective trend-pullback-model-v1 Demo: observed trend, pullback and reclaim plus immutable model direction. MAE and forecast amplitude are diagnostics. Planned net reward must cover stressed risk; target remains unproven. Actual fills alone establish PnL.':'v12 forecast-net-edge-v1 prospective Demo hypothesis: require forecast movement versus the executable quote to exceed unchanged full round-trip costs plus the existing buffer, with completed momentum confirmation and retained ATR exits. Forecast surplus is not calibrated expected profit. Actual fee-adjusted fills determine results.'};
 }catch{return hold(['MODEL_PLAN_INVALID']);}
}
export function riskCostFraction(cost){
 const n=new Decimal(cost?.estimatedRoundTripCostBps??NaN).div(10000);
 if(cost?.status!=='ok'||!n.isFinite()||n.lt(0))throw Error('DEMO_RISK_COSTS_REQUIRED');
 return n;
}
export function demoRiskStake(rules,cost,policy,available=policy.maxStakeUsdt){
 const reserve=rules.version===DEMO_RULE_VERSION?demoRiskPolicy(policy.mode).reserveFraction:0;
 const risk=new Decimal(rules.stopFraction).plus(riskCostFraction(cost)).plus(reserve);
 if(!risk.isFinite()||risk.lte(0))throw Error('DEMO_RISK_INVALID');
 const adaptive=rules.adaptiveParameters,scale=new Decimal(adaptive?.riskScale??1);
 if(!scale.isFinite()||scale.lt('.25')||scale.gt(1)||adaptive&&(![ADAPTIVE_FLOW_VERSION,LEGACY_ADAPTIVE_FLOW_VERSION].includes(adaptive.version)||!scale.eq(adaptive.riskBudgetUsdt)))throw Error('DEMO_ADAPTIVE_RISK_INVALID');
 return Decimal.max(0,Decimal.min(policy.maxStakeUsdt,available,new Decimal(DEMO_RISK_BUDGET_USDT).mul(scale).div(risk))).toFixed(8,Decimal.ROUND_DOWN);
}
export function demoSizeMeetsMinimum(market,stake,action){
 try{
  const filters=market.filters;if(!Array.isArray(filters))return false;
  const lot=filters.find(f=>f.filterType==='LOT_SIZE'),marketLot=filters.find(f=>f.filterType==='MARKET_LOT_SIZE');
  const minimum=filters.find(f=>['MIN_NOTIONAL','NOTIONAL'].includes(f.filterType));
  if(!lot||!minimum)return false;
  const step=Decimal.max(lot.stepSize,marketLot?.stepSize??0),price=new Decimal(action==='open-short'?market.bid:market.ask);
  if(!step.isFinite()||step.lte(0)||!price.isFinite()||price.lte(0))return false;
  const quantity=new Decimal(stake).div(price).div(step).floor().mul(step);
  return quantity.gte(Decimal.max(lot.minQty,marketLot?.minQty??0))&&quantity.mul(price).gte(minimum.minNotional??minimum.notional);
 }catch{return false;}
}


// Current entry engine: observed Demo tape/depth selects direction. Closed bars
// supply only a validated ATR exit distance; model evidence is not consulted.
export function evaluateFlowEntryQuality(snapshot,proposal,now){
 const q=evaluateModelEntryQuality(snapshot,proposal,now);
 return {...q,metrics:q.metrics?{...q.metrics,entrySignalEngine:'sampled_order_flow',technicalIndicatorsRole:'atr_risk_only'}:null};
}
export function orderFlowRuleDecision({snapshot,pair,cost,quote,now=Date.now()}={}){
 const {mode,timeframe}=snapshot??{},directionChecks=[];
 let flowDiagnostics=null,adaptiveParameters=null;
 const executionQualityVersion=mode==='demo'?SPOT_FLOW_QUALITY_VERSION:null;
 const hold=reasons=>({version:DEMO_RULE_VERSION,entryPolicyVersion:FLOW_ONLY_POLICY,executionQualityVersion,entrySignalEngine:'sampled_order_flow',pair,timeframe,action:'hold',reasons,directionChecks,flowDiagnostics,adaptiveParameters});
 if(!['demo','demo-futures'].includes(mode)||timeframe!=='5m')return hold(['FLOW_MODE_OR_TIMEFRAME']);
 let signalBoundary=snapshot.candleBoundary,adaptiveEnabled=false;
 try{const timing=decisionTiming(snapshot);if(timing){adaptiveEnabled=true;signalBoundary=timing.boundary;if(now<timing.boundary||now>=timing.deadline)return hold(['FLOW_DECISION_EXPIRED']);}}
 catch{return hold(['FLOW_DECISION_TIMING_INVALID']);}
 if(snapshot.volumeExperiment!=null)return hold(['FLOW_VOLUME_EXPERIMENT_NOT_SUPPORTED']);
 const matches=snapshot.markets?.filter(m=>m.pair===pair)??[];
 if(matches.length!==1)return hold(['FLOW_MARKET_REQUIRED']);
 const market=matches[0];
 for(const long of mode==='demo'?[true]:[true,false]){
  const action=long?(mode==='demo'?'buy':'open-long'):'open-short';
  const flow=assessOrderFlow(market.orderFlow,{mode,pair,long,now});
  const check={action,eligible:false,reasons:[],flowDiagnostics:flow};directionChecks.push(check);
  if(!flow.eligible){check.reasons.push(flow.reason);continue;}
  flowDiagnostics=flow;
  const continuation=mode==='demo'?assessSpotFlowContinuation(market.orderFlow,quote??market):assessFuturesFlowContinuation(market.orderFlow,quote??market,{long});
  if(continuation){check.executionContinuation=continuation;if(!continuation.eligible)return hold([continuation.reason]);}
  const quality=evaluateFlowEntryQuality(snapshot,{pair,action,evidenceIds:[(mode==='demo'?'spot:':'futures:')+pair]},now);
  check.metrics=quality.metrics;
  if(!quality.eligible)return hold(quality.reasons);
  try{
   if(cost?.status!=='ok')return hold(['ENTRY_COSTS_UNAVAILABLE']);
   let required=new Decimal(cost.requiredPriceSpaceBps);const reserve=new Decimal(cost.estimatedRoundTripCostBps);
   const price=new Decimal(long?(quote??market).ask:(quote??market).bid);
   if(!required.isFinite()||!reserve.isFinite()||reserve.lt(0)||required.lt(reserve.plus(30))||!price.isFinite()||price.lte(0))return hold(['FLOW_COST_OR_QUOTE_INVALID']);
   const atr15=closed15mAtr(market.candles,snapshot.candleBoundary),targetAtr=3;
   const targetFraction=targetAtr*atr15/Number(price),stopFraction=Math.min(atr15/Number(price),.02);
   if(!Number.isFinite(atr15)||atr15<=0||!Number.isFinite(targetFraction)||targetFraction>1||stopFraction<=0)return hold(['BASELINE_PLAN_INVALID']);
   if(adaptiveEnabled){
    adaptiveParameters=deriveAdaptiveParameters({mode,long,proof:market.orderFlow,atr15,quotePrice:price.toFixed(),estimatedRoundTripCostBps:reserve.toFixed(),volatility:closedVolatilityInput(market.candles,snapshot.candleBoundary)});
    check.adaptiveParameters=adaptiveParameters;
    const adaptiveFlow=assessOrderFlow(market.orderFlow,{mode,pair,long,now,minTakerShare:adaptiveParameters.minTakerShare,
     minMidChangeBps:FLOW_SELECTIVITY.minimumMidChangeBps,maxDepthImbalance:FLOW_SELECTIVITY.maximumDepthImbalance});
    check.flowDiagnostics=adaptiveFlow;flowDiagnostics=adaptiveFlow;
    if(!adaptiveFlow.eligible){check.reasons.push('FLOW_ADAPTIVE_SUPPORT_TOO_SMALL');return hold(['FLOW_ADAPTIVE_SUPPORT_TOO_SMALL']);}
    required=Decimal.max(required,reserve.plus(adaptiveParameters.costBufferBps));
   }
   check.costSpace={targetBps:String(targetFraction*10000),requiredBps:required.toFixed(),basis:'planned_atr_exit_not_forecast'};
   if(new Decimal(targetFraction).mul(10000).lt(required))return hold(['BASELINE_PRICE_SPACE_TOO_SMALL']);
   check.netRewardRisk=netRewardRisk({targetFraction,stopFraction,costFraction:reserve.div(10000),reserveFraction:demoRiskPolicy(mode).reserveFraction});
   if(!check.netRewardRisk.eligible)return hold(['FLOW_NET_REWARD_RISK_TOO_SMALL']);
   check.eligible=true;
   return {version:DEMO_RULE_VERSION,entryPolicyVersion:FLOW_ONLY_POLICY,executionQualityVersion,entrySignalEngine:'sampled_order_flow',entryRoute:'order-flow',pair,action,timeframe,
    ...(mode==='demo'?{flowStrength:{version:'depth-change-rank-v1',delta:new Decimal(flow.bookImbalances[2]).minus(flow.bookImbalances[0]).toFixed()},flowExit:{...SPOT_FLOW_EXIT_POLICY}}:{}),
    signalAt:signalBoundary,atrTimeframe:'15m',atr15,targetAtr,targetFraction,stopFraction,
    maxHoldingBars:DEMO_PARAMETERS.maxHoldingBars,maxHoldingSeconds:DEMO_PARAMETERS.maxHoldingSeconds,
    requiredPriceSpaceBps:required.toFixed(),selectionScoreBps:new Decimal(check.netRewardRisk.netRewardFraction).minus(check.netRewardRisk.riskFraction).mul(10000).toFixed(),
    selectionScoreBasis:'planned_net_reward_minus_stressed_risk_not_expected_return',directionChecks,flowDiagnostics,...(adaptiveParameters?{adaptiveParameters}:{}),profitProtection:DEMO_PROFIT_PROTECTION,
    entryConfirmation:{version:'order-flow-atr-v1',entryRoute:'order-flow',orderFlow:market.orderFlow,confirmationAt:snapshot.candleBoundary,quotePrice:price.toFixed(),atr15,targetAtr,targetFraction,
     ...(continuation?{executionContinuation:mode==='demo'?{version:SPOT_FLOW_CONTINUATION_VERSION,originAsk:continuation.originAsk}:{version:FUTURES_FLOW_CONTINUATION_VERSION,long:continuation.long,originPrice:continuation.originPrice,quotePrice:continuation.quotePrice}}:{})},
    note:'Order flow alone selects entry direction. Model and candle trends do not gate orders. ATR exits and costs describe planned geometry, not expected profit.'};
  }catch{return hold(['FLOW_PLAN_INVALID']);}
 }
 flowDiagnostics=directionChecks[0]?.flowDiagnostics??null;
 return hold(['FLOW_NOT_CONFIRMED']);
}
