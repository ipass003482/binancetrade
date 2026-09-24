import Decimal from 'decimal.js';
import {validateOrderFlowData,assessOrderFlow,assessFlowShock,recentLossCooldowns,FLOW_SELECTIVITY} from './order-flow.mjs';
import {decisionTiming} from './entry-timing.mjs';
import {demoRiskPolicy} from './demo-risk.mjs';
import {checkDemoOrderSize} from './demo-order-size.mjs';
import {riskCostFraction} from './demo-rules.mjs';
import {executableCostEconomics} from './trading-costs.mjs';
import {advanceConfirmation,confirmationForEntry,KEV_CONFIRMATION_VERSION,KEV_CONFIRMATION_WINDOWS,KEV_CONFIRMATION_INTERVAL_MS} from './kev-confirmation.mjs';

export const KEV_FLOW_POLICY='kev-order-flow-v1';
export const KEV_NATIVE_VERSION='kev-native-entry-v1';
export const KEV_FLOW_PARAMETERS=Object.freeze({version:'kev-flow-fixed-exits-v1',timeframe:'order-flow',
 stopFraction:.005,targetFraction:.015,maxHoldingSeconds:900,maxHoldingBars:0,riskBudgetUsdt:1});
export const KEV_NET_MARGIN_POLICY=Object.freeze({version:'kev-net-margin-v1',minimumNetMarginBps:'10'});
export const isKevFlow=snapshot=>snapshot?.entryPolicyVersion===KEV_FLOW_POLICY;

// Candidate generation and Kev's choice are separate gates.  A candidate is
// shown to Kev only after these host/native checks pass; the diagnostics keep
// the reasons for every rejected candidate visible in the run artifact and
// the order journal instead of collapsing them into a generic HOLD.
export const KEV_ENTRY_DIAGNOSTICS_VERSION='kev-entry-diagnostics-v1';
const HARD_BLOCKERS=new Set([
 'ENTRY_COSTS_UNAVAILABLE','KEV_FLOW_ACTION_INVALID','KEV_FLOW_DECISION_EXPIRED',
 'KEV_FLOW_TIMING_INVALID','KEV_FLOW_PRICE_SPACE_TOO_SMALL','KEV_FLOW_NET_REWARD_RISK_TOO_SMALL',
 'KEV_FLOW_PLAN_INVALID','FLOW_SOURCE','FLOW_IDENTITY','FLOW_INCOMPLETE','FLOW_WINDOW',
 'FLOW_BOOK_TIME','FLOW_BOOK_GAP','FLOW_CROSSED_BOOK','FLOW_TRADE_GAP','FLOW_TAPE_STALE',
 'FLOW_STALE','FLOW_DATA_INVALID','PAIR_NOT_ALLOWED','POSITION_OR_EXPOSURE_LIMIT',
 'POSITION_ALREADY_EXISTS','FLOW_PAIR_LOSS_COOLDOWN','QUOTE_REJECTED',
 'FLOW_VOLATILITY_SHOCK','FLOW_LIQUIDITY_SHOCK','FLOW_SHOCK_DATA_INVALID',
 'FLOW_TAPE_BOOK_MISMATCH','FLOW_BOOK_IMBALANCE_TOO_LARGE','FLOW_MID_MOVE_NOT_CONFIRMED','KEV_NET_MARGIN_TOO_SMALL',
 'KEV_FLOW_CONFIRMATION_PENDING','KEV_FLOW_CONFIRMATION_REQUIRED',
 'DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM'
]);
const blockerClass=reason=>HARD_BLOCKERS.has(reason)||String(reason??'').startsWith('KEV_')||String(reason??'').startsWith('FLOW_')?'hard':'soft';
export function kevCandidateDiagnostics(candidates){
 const rows=(Array.isArray(candidates)?candidates:[]).map(candidate=>{
  const reasons=[...(candidate?.reasons??[])].filter(reason=>typeof reason==='string');
  return {pair:candidate?.pair??null,requestedAction:candidate?.requestedAction??candidate?.action??null,
   action:candidate?.action??'hold',eligible:candidate?.action!=='hold',
   executionMode:candidate?.executionMode??(candidate?.shadowOnly?'shadow':'blocked'),shadowOnly:candidate?.shadowOnly===true,
   hardReasons:reasons.filter(reason=>blockerClass(reason)==='hard'),
   softReasons:reasons.filter(reason=>blockerClass(reason)==='soft')};
 });
 const counts=new Map();for(const row of rows)for(const reason of [...row.hardReasons,...row.softReasons])counts.set(reason,(counts.get(reason)??0)+1);
 const blockers=[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([reason,count])=>({reason,count,class:blockerClass(reason)}));
 return {version:KEV_ENTRY_DIAGNOSTICS_VERSION,total:rows.length,eligible:rows.filter(row=>row.eligible).length,
  blocked:rows.filter(row=>!row.eligible).length,hardBlocked:rows.filter(row=>row.hardReasons.length>0).length,
  softBlocked:rows.filter(row=>row.softReasons.length>0&&row.hardReasons.length===0).length,blockers,candidates:rows};
}
const formatBlockers=diagnostics=>diagnostics.blockers.length
 ?'; blockers='+diagnostics.blockers.slice(0,6).map(row=>`${row.reason}:${row.count}`).join(',')
 :'; blockers=none';

export function kevFlowQuality(snapshot,proposal,now=Date.now()){
 const reasons=[],market=snapshot.markets?.find(m=>m.pair===proposal.pair);
 try{
  const timing=decisionTiming(snapshot);
  if(!isKevFlow(snapshot)||snapshot.timeframe!=='order-flow'||!timing||now<timing.boundary||now>=timing.deadline)
   reasons.push('KEV_FLOW_DECISION_EXPIRED');
 }catch{reasons.push('KEV_FLOW_TIMING_INVALID');}
 const flow=validateOrderFlowData(market?.orderFlow,{mode:snapshot.mode,pair:proposal.pair,now});
 const long=proposal.action!=='open-short';
 const alignment=flow.eligible?assessOrderFlow(market?.orderFlow,{mode:snapshot.mode,pair:proposal.pair,long,now,
  minTakerShare:'.55',minMidChangeBps:FLOW_SELECTIVITY.minimumMidChangeBps,maxDepthImbalance:FLOW_SELECTIVITY.maximumDepthImbalance}):null;
 if(!flow.eligible)reasons.push(flow.reason);
 else if(!alignment?.eligible)reasons.push(alignment?.reason??'FLOW_TAPE_BOOK_MISMATCH');
 const shock=flow.eligible&&alignment?.eligible?assessFlowShock(alignment,{spreadBps:market?.spreadBps}):null;
 if(shock&&!shock.eligible)reasons.push(shock.reason);
 return {eligible:reasons.length===0,reasons,metrics:{...flow,alignment},alignment,shock,
  shadowOnly:Boolean(alignment&&!alignment.eligible&&alignment.shadowOnly)};
}

// Fixed prospective exit geometry, independent of candles or forecasts. The
// price space is a plan, not an estimate that the market will reach the target.
export function kevFlowRule({snapshot,pair,action,cost,quote,policy={},confirmation=null,confirmationRequired=false,now=Date.now()}){
 const base={version:KEV_FLOW_POLICY,entryPolicyVersion:KEV_FLOW_POLICY,entrySignalEngine:'kev_order_flow',
  pair,action,timeframe:'order-flow',...KEV_FLOW_PARAMETERS};
 base.version=KEV_FLOW_POLICY;
 const hold=(reasons,extra={})=>({...base,action:'hold',reasons,...extra});
 if(!['demo','demo-futures'].includes(snapshot.mode)||!(snapshot.mode==='demo'?['buy']:['open-long','open-short']).includes(action))
  return hold(['KEV_FLOW_ACTION_INVALID']);
 const quality=kevFlowQuality(snapshot,{pair,action},now);
 if(!quality.eligible)return hold(quality.reasons,{flowDiagnostics:quality.metrics,shadowOnly:quality.shadowOnly,executionMode:quality.shadowOnly?'shadow':'blocked'});
 const market=snapshot.markets.find(m=>m.pair===pair),q=quote??market;
 try{
  if(cost?.status!=='ok')return hold(['ENTRY_COSTS_UNAVAILABLE']);
  const required=new Decimal(cost.requiredPriceSpaceBps),fees=riskCostFraction(cost),
   reward=new Decimal(base.targetFraction).minus(fees),risk=new Decimal(base.stopFraction).plus(fees),
   price=new Decimal(action==='open-short'?q.bid:q.ask);
  if(!required.isFinite()||required.lt(0)||required.lt(fees.mul(10000))||!price.isFinite()||price.lte(0))throw Error();
  if(new Decimal(base.targetFraction).mul(10000).lt(required))return hold(['KEV_FLOW_PRICE_SPACE_TOO_SMALL']);
  if(reward.lte(risk))return hold(['KEV_FLOW_NET_REWARD_RISK_TOO_SMALL']);
  const economics=executableCostEconomics({mode:snapshot.mode,action,market:{...market,bid:q.bid,ask:q.ask,spreadBps:q.spreadBps??market.spreadBps,entryCost:cost},
   stopFraction:base.stopFraction,targetFraction:base.targetFraction});
  const targetNetBps=new Decimal(economics.targetNetUsdtPer100).div(100).mul(10000),
   driftReserveBps=Decimal.min(new Decimal(policy?.maxPriceMoveBps??0),new Decimal(cost.slippageBpsPerSide),
    new Decimal(base.targetFraction).mul(10000).minus(required)),
   netAfterDriftBps=targetNetBps.minus(driftReserveBps),minimumNetMarginBps=new Decimal(KEV_NET_MARGIN_POLICY.minimumNetMarginBps);
  if(!targetNetBps.isFinite()||!driftReserveBps.isFinite()||driftReserveBps.lt(0)||netAfterDriftBps.lt(minimumNetMarginBps))
   return hold(['KEV_NET_MARGIN_TOO_SMALL'],{flowDiagnostics:quality.metrics,shadowOnly:false,executionMode:'blocked',netMargin:{version:KEV_NET_MARGIN_POLICY.version,
    targetNetMarginBps:targetNetBps.toFixed(),quoteDriftReserveBps:driftReserveBps.toFixed(),netMarginAfterQuoteDriftBps:netAfterDriftBps.toFixed(),
    minimumNetMarginBps:minimumNetMarginBps.toFixed(),costEconomics:economics}});
  if(confirmationRequired&&!confirmationForEntry(confirmation,{snapshot,mode:snapshot.mode,pair,action,now}))
   return hold(['KEV_FLOW_CONFIRMATION_REQUIRED'],{flowDiagnostics:quality.metrics,shadowOnly:false,executionMode:'blocked'});
  return {...base,reasons:[],requiredPriceSpaceBps:required.toFixed(),estimatedRoundTripCostBps:fees.mul(10000).toFixed(),orderFlowMetrics:quality.metrics,
   costSpace:{targetBps:'150',requiredBps:required.toFixed(),basis:'fixed_exit_plan_not_forecast'},
   netRewardRisk:{netRewardFraction:reward.toFixed(),riskFraction:risk.toFixed(),ratio:reward.div(risk).toFixed()},
   netMargin:{version:KEV_NET_MARGIN_POLICY.version,targetNetMarginBps:targetNetBps.toFixed(),quoteDriftReserveBps:driftReserveBps.toFixed(),
    netMarginAfterQuoteDriftBps:netAfterDriftBps.toFixed(),minimumNetMarginBps:minimumNetMarginBps.toFixed()},costEconomics:economics,
   // Keep the native callback proof schema closed. Alignment is already
   // carried in the order-flow evidence and diagnostics; adding it here
   // makes the Python guard reject an otherwise valid bridge plan.
   entryConfirmation:{version:'kev-flow-confirmation-v1',orderFlow:market.orderFlow,quotePrice:price.toFixed()}};
 }catch{return hold(['KEV_FLOW_PLAN_INVALID']);}
}

export function kevFlowStake(rules,cost,policy,available=policy.maxStakeUsdt){
 const risk=new Decimal(rules.stopFraction).plus(riskCostFraction(cost)).plus(demoRiskPolicy(policy.mode).reserveFraction);
 if(!risk.isFinite()||risk.lte(0))throw Error('KEV_FLOW_RISK_INVALID');
 return Decimal.max(0,Decimal.min(policy.maxStakeUsdt,available,new Decimal(1).div(risk))).toFixed(8,Decimal.ROUND_DOWN);
}

export function kevFlowReference(snapshot,policy,account,{recentHistory=[],now=Date.now(),review,confirmationState}={}){
 const used=account.trades.reduce((s,t)=>s+Number(t.stake_amount),0),available=Math.max(0,Number(policy.maxExposureUsdt)-used),
  cooldowns=recentLossCooldowns(recentHistory,{now}),futures=policy.mode==='demo-futures';
 const full=account.trades.length>=policy.maxOpenTrades||available<=0;
 let nextConfirmationState=confirmationState;
 const candidates=snapshot.markets.flatMap(m=>(futures?['open-long','open-short']:['buy']).map(action=>{
  const rule=kevFlowRule({snapshot,pair:m.pair,action,cost:m.entryCost,policy,now});
  const advanced=advanceConfirmation(nextConfirmationState,{mode:snapshot.mode,pair:m.pair,action,
   snapshotId:snapshot.id,boundary:snapshot.decisionBoundary,intervalMs:snapshot.decisionIntervalMs,
   eligible:rule.action!=='hold'&&!(rule.reasons?.length),now});
  nextConfirmationState=advanced.state;
  const confirmation=advanced.confirmation;
  const reasons=[...(rule.reasons??[])];
  if(rule.action!=='hold'&&!(rule.reasons?.length)&&!confirmation?.confirmed)reasons.push('KEV_FLOW_CONFIRMATION_PENDING');
  if(!policy.pairs.includes(m.pair))reasons.push('PAIR_NOT_ALLOWED');
  if(full)reasons.push('POSITION_OR_EXPOSURE_LIMIT');
  if(account.trades.some(t=>t.pair===m.pair))reasons.push('POSITION_ALREADY_EXISTS');
  if(cooldowns.has(m.pair))reasons.push('FLOW_PAIR_LOSS_COOLDOWN');
  if((futures?m.verifiedFutures:m.verifiedSpot)!==true||!Number.isFinite(m.spreadBps)||m.spreadBps<0||m.spreadBps>policy.maxSpreadBps)
   reasons.push('QUOTE_REJECTED');
  let stakeUsdt='0',sizing;
  if(!reasons.length){
   stakeUsdt=kevFlowStake(rule,m.entryCost,policy,available);
   sizing=checkDemoOrderSize({market:m,price:action==='open-short'?m.bid:m.ask,stakeUsdt,leverage:1});
   if(!sizing.eligible)reasons.push('DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM');
  }
  return {...rule,confirmation,action:reasons.length?'hold':action,requestedAction:action,stakeUsdt:reasons.length?'0':stakeUsdt,reasons,sizing,
   shadowOnly:Boolean(rule.shadowOnly),executionMode:rule.shadowOnly?'shadow':reasons.length?'blocked':'live',
   riskPolicy:demoRiskPolicy(policy.mode)};
 }));
 const approved=review?.status==='reviewed'?review.decisions?.filter(d=>d.approved):[];
 const selected=approved?.length===1?candidates.find(c=>c.pair===approved[0].pair&&c.action===approved[0].action&&c.action!=='hold'):null;
 const diagnostics=kevCandidateDiagnostics(candidates);
 const noSelectionReason=review?.status==='reviewed'
  ?(selected?null:(approved?.length?'KEV_ENTRY_VETO_OR_CANDIDATE_UNAVAILABLE':(review.reason??'KEV_ENTRY_VETO')))
  :(diagnostics.eligible?'等待 Kev 選擇交易對與方向。':'KEV_NO_ELIGIBLE_ENTRY');
 const proposal={snapshotId:snapshot.id,action:selected?.action??'hold',pair:selected?.pair??policy.pairs[0],stakeUsdt:selected?.stakeUsdt??'0',
  evidenceIds:selected?[(futures?'futures:':'spot:')+selected.pair,'cost:'+selected.pair]:[],
 reason:selected?'Kev 依即時訂單簿與主動成交流選定交易對及方向；固定停損 0.5%、停利 1.5%、最長持倉 15 分鐘，估計風險預算 1 USDT。':
   'Kev 訂單流決策：'+noSelectionReason+formatBlockers(diagnostics),
  ...(futures?{leverage:1}:{}),...(selected?.confirmation?{kevConfirmation:selected.confirmation}:{})};
 const shadowCandidates=candidates.filter(c=>c.shadowOnly).map(c=>({pair:c.pair,requestedAction:c.requestedAction,shadowReason:c.reasons?.[0]??'FLOW_TAPE_BOOK_MISMATCH',
  flowDiagnostics:c.flowDiagnostics?.alignment??c.flowDiagnostics??null}));
 return {proposal,candidates,selected:selected??null,metadata:{decisionEngine:'rules',ruleVersion:KEV_FLOW_POLICY,entryPolicyVersion:KEV_FLOW_POLICY,
   entrySignalEngine:'kev_order_flow',parameters:KEV_FLOW_PARAMETERS,llmInvoked:false,modelUsedForDecision:Boolean(selected),
   snapshotId:snapshot.id,timeframe:'order-flow',performanceSource:'demo-exchange-fills',candidateDiagnostics:diagnostics,
   shadowCandidates,shadowPolicy:'one-sided-or-misaligned-order-flow-is-observation-only',confirmationPolicy:{version:KEV_CONFIRMATION_VERSION,requiredWindows:KEV_CONFIRMATION_WINDOWS,intervalMs:KEV_CONFIRMATION_INTERVAL_MS},confirmationState:nextConfirmationState}};
}
