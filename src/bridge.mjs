import {assessOrderFlow,FLOW_ONLY_POLICY} from './order-flow.mjs';
import {createHash} from 'node:crypto';
import { isEntry,isExit, isFutures } from './mode.mjs';
import { join } from 'node:path';
import {entryId,entryArtifactStem,BATCH_EXECUTION_VERSION} from './entry-identity.mjs';
import Decimal from 'decimal.js';
import { assess } from './risk.mjs';
import { market } from './research.mjs';
import { proposalSchema } from './config.mjs';
import { lock,journalRead,journalAppend,exists,writeJson } from './io.mjs';
import { loadAnalyst } from './analyst.mjs';
import { evaluateEntryQuality } from './entry-quality.mjs';
import { captureStrategyVersion } from './strategy-version.mjs';
import { readExchangeClock } from './exchange-clock.mjs';
import { verifyEntryTiming,decisionTiming } from './entry-timing.mjs';
import { entryCost,loadCosts } from './trading-costs.mjs';
import { loadDecisionConfig,RULE_ENGINE_VERSION } from './decision.mjs';
import { orderFlowRuleDecision,evaluateFlowEntryQuality,demoRiskStake,riskCostFraction,DEMO_RULE_VERSION,DEMO_RISK_BUDGET_USDT,DEMO_PROFIT_PROTECTION } from './demo-rules.mjs';
import { checkDemoOrderSize } from './demo-order-size.mjs';
import {demoRiskPolicy} from './demo-risk.mjs';
import { validateProbePermit,PROBE_VERSION } from './demo-probe.mjs';
import { withPortfolioEntry } from './portfolio-store.mjs';
import { assertNativeProtection,NATIVE_ENTRY_GUARD_VERSION } from './protection.mjs';
import {loadVolumeExperiment,assertVolumeAssignment} from './volume-experiment.mjs';
import {entryPlanDigest,readEntryRejection} from './entry-rejection.mjs';
export async function execute({proposal,snapshot,policy,client,local,now=()=>Date.now(),getQuote=market,
 strategyVersion,executionPolicyVersion,entryQualityFn=evaluateEntryQuality,getClock=readExchangeClock,getDecisionConfig=loadDecisionConfig,getVolumeConfig=loadVolumeExperiment,probePermitId,portfolioEntryFn=withPortfolioEntry,protectionCheckFn=assertNativeProtection}) {
 if(executionPolicyVersion!==undefined&&(executionPolicyVersion!==BATCH_EXECUTION_VERSION||!['demo','demo-futures'].includes(policy.mode)||!isEntry(proposal.action)||probePermitId))throw Error('BATCH_EXECUTION_MODE_REJECTED');
 const artifactStem=entryArtifactStem(snapshot.id,proposal.pair,executionPolicyVersion);
 const run=portfolioCheck=>lock(join(local,'execution.lock'),async()=>{
  const journal=join(local,'orders.jsonl'), records=await journalRead(journal);
  const id=entryId(snapshot.id,proposal.pair,executionPolicyVersion);
  if(records.some(r=>r.id===id)) throw new Error('SNAPSHOT_ALREADY_CONSUMED');
  const latest=new Map(records.map(r=>[r.id,r]));
  if([...latest.values()].some(r=>['pending','unknown'].includes(r.status))) throw new Error('UNRESOLVED_SUBMISSION: reconcile before more orders');
  proposalSchema(policy).parse(proposal);
  const volumeExperiment=policy.mode!=='dry-run'&&snapshot.decisionEngine==='rules'&&!probePermitId?
   assertVolumeAssignment(snapshot,await getVolumeConfig()):null;
  if(volumeExperiment&&!probePermitId)throw Error('MODEL_VOLUME_EXPERIMENT_NOT_SUPPORTED');
  if(proposal.action!=='hold' && !policy.pairs.includes(proposal.pair)) throw new Error('PAIR_NOT_ALLOWED');
  const executionQuote=isEntry(proposal.action)?await getQuote(proposal.pair,{mode:policy.mode}):null;
  if(executionQuote)await writeJson(join(local,'runs',artifactStem+'.execution-quote.json'),executionQuote);
  const account=await client.snapshot();
  const decision=assess({proposal,snapshot,policy,account,records,executionQuote,stopped:await exists(join(local,'STOP')),now:now()});
  const at=new Date(now()).toISOString();
  if(decision.action==='hold') {
   await journalAppend(journal,{id,at,status:'hold',action:'hold',snapshotId:snapshot.id,reason:proposal.reason,volumeExperiment});
   return {status:'hold',id};
  }
  let entryVersion,rulePlan,nativeGuardInputs,costConfig,decisionConfig,probePermit,portfolioCheckedAt,modelEvidence;
  if(probePermitId)probePermit=await validateProbePermit({local,id:probePermitId,proposal,snapshot,mode:policy.mode,now:now()});
  if(isEntry(proposal.action)){
   verifyEntryTiming({snapshot,pair:proposal.pair,mode:policy.mode,clock:executionQuote.clock,now:now()});
   const analyst=await loadAnalyst();
   entryVersion=await captureStrategyVersion({policy,analyst,engine:account.engine,now:now()});
   if(strategyVersion&&entryVersion.fingerprint!==strategyVersion.fingerprint)throw Error('STRATEGY_CHANGED_DURING_CYCLE');
   if(policy.mode!=='dry-run'){
    costConfig=await loadCosts();decisionConfig=await getDecisionConfig();
    const cost=entryCost(snapshot.costFacts,executionQuote,policy.mode,costConfig,now());
    await writeJson(join(local,'runs',artifactStem+'.cost-check.json'),cost);
    if(cost.status!=='ok')throw Error('ENTRY_COSTS_UNAVAILABLE');
    if(decisionConfig.demoEngine==='rules'||probePermit){
     if(snapshot.decisionEngine!=='rules'||account.engine?.strategy_version!==RULE_ENGINE_VERSION)throw Error('RULE_ENGINE_RESTART_REQUIRED');
     if(!probePermit){
      if(snapshot.ruleVersion!==DEMO_RULE_VERSION)throw Error('MODEL_STRATEGY_VERSION_REQUIRED');

     }
     const rules=probePermit??orderFlowRuleDecision({snapshot,pair:proposal.pair,cost,modelEvidence,quote:executionQuote,now:now()});
     if(!probePermit){
      const checkedAt=new Date(now()).toISOString();
      await writeJson(join(local,'runs',artifactStem+'.rules-recheck.json'),{schemaVersion:1,at:checkedAt,mode:policy.mode,snapshotId:snapshot.id,pair:proposal.pair,requestedAction:proposal.action,strategyFingerprint:entryVersion.fingerprint,entrySignalEngine:'sampled_order_flow',modelUsedForDecision:false,rules});
      if(rules.action==='hold'||rules.action!==proposal.action){
       const reason='FLOW_ENTRY_RECHECK_FILTERED',reasons=rules.reasons??['FLOW_DIRECTION_CHANGED'];
       await journalAppend(journal,{id,at:checkedAt,status:'rejected',decisionStatus:'filtered',action:proposal.action,pair:proposal.pair,snapshotId:snapshot.id,...(executionPolicyVersion?{executionPolicyVersion}:{}),reason,reasons,purpose:'strategy',ruleVersion:DEMO_RULE_VERSION});
       return {id,status:'filtered',action:proposal.action,reason,reasons,purpose:'strategy',ruleVersion:DEMO_RULE_VERSION};
      }
     }
     if(rules.action!==proposal.action)throw Error('RULE_SIGNAL_REJECTED');
     const requestedStakeUsdt=proposal.stakeUsdt;
     proposal={...proposal,stakeUsdt:Decimal.min(proposal.stakeUsdt,demoRiskStake(rules,cost,policy)).toFixed(8,Decimal.ROUND_DOWN)};
     const sizing=checkDemoOrderSize({market:executionQuote,price:proposal.action==='open-short'?executionQuote.bid:executionQuote.ask,stakeUsdt:proposal.stakeUsdt,leverage:proposal.leverage??1});
     await writeJson(join(local,'runs',artifactStem+'.sizing.json'),{requestedStakeUsdt,stakeUsdt:proposal.stakeUsdt,...sizing});
     if(!sizing.eligible)throw Error('DEMO_ORDER_SIZE_REJECTED: '+sizing.reasons.join(','));
     assess({proposal,snapshot,policy,account,records,executionQuote,stopped:await exists(join(local,'STOP')),now:now()});
     await writeJson(join(local,'runs',artifactStem+'.executed-proposal.json'),proposal);
     const minuteTiming=probePermit?null:decisionTiming(snapshot);
     const cadence=minuteTiming?{decisionCadenceVersion:snapshot.decisionCadenceVersion,decisionIntervalMs:snapshot.decisionIntervalMs,decisionBoundary:snapshot.decisionBoundary}:{};
     rulePlan={ruleVersion:probePermit?PROBE_VERSION:DEMO_RULE_VERSION,purpose:probePermit?'execution_probe':'strategy',timeframe:rules.timeframe,...(probePermit?{}:{atrTimeframe:'15m',...cadence}),maxHoldingSeconds:rules.maxHoldingSeconds,pair:proposal.pair,isShort:proposal.action==='open-short',
      stopFraction:rules.stopFraction,targetFraction:rules.targetFraction,maxHoldingBars:rules.maxHoldingBars,riskBudgetUsdt:rules.adaptiveParameters?Number(rules.adaptiveParameters.riskBudgetUsdt):DEMO_RISK_BUDGET_USDT,
      ...(rules.adaptiveParameters?{adaptiveParameters:rules.adaptiveParameters}:{}),
      riskCostFraction:Number(riskCostFraction(cost)),maxEntryNotionalUsdt:Number(proposal.stakeUsdt),
      ...(probePermit?{}:{riskPolicy:demoRiskPolicy(policy.mode),profitProtection:{...DEMO_PROFIT_PROTECTION},entryConfirmation:rules.entryConfirmation,
       volumeExperiment,entryPolicyVersion:rules.entryPolicyVersion,...(rules.executionQualityVersion?{executionQualityVersion:rules.executionQualityVersion,flowStrength:rules.flowStrength,flowExit:rules.flowExit}:{}),strategyVariant:DEMO_RULE_VERSION,entrySignalEngine:'sampled_order_flow',
       entryEvidence:{version:'order-flow-evidence-v1',snapshotId:snapshot.id,usedForEntryDecision:true,
        proofSha256:createHash('sha256').update(JSON.stringify(rules.entryConfirmation.orderFlow)).digest('hex')}})};
     if(!probePermit)nativeGuardInputs={version:minuteTiming?NATIVE_ENTRY_GUARD_VERSION:'kronos-native-entry-v10',snapshotId:snapshot.id,...cadence,
      mode:policy.mode,pair:proposal.pair,side:proposal.action==='open-short'?'short':'long',
      candleBoundary:snapshot.candleBoundary,entryDeadline:minuteTiming?.deadline??snapshot.candleBoundary+60000,
      requiredPriceSpaceBps:rules.requiredPriceSpaceBps,bridgeQuotePrice:rules.entryConfirmation.quotePrice,
      atr15:rules.atr15,targetAtr:rules.targetAtr,targetFraction:rules.targetFraction,
      quoteFetchedAt:executionQuote.fetchedAt,maxPriceMoveBps:policy.maxPriceMoveBps,leverage:proposal.leverage??1};
    }
   }
   const quality=probePermit?{eligible:true,reasons:[],purpose:'execution_probe',note:'Explicit one-shot Demo order/exit verification; excluded from strategy performance.'}
    :decisionConfig?.demoEngine==='rules'&&entryQualityFn===evaluateEntryQuality?evaluateFlowEntryQuality(snapshot,proposal,now()):await entryQualityFn({proposal,snapshot,analyst,now:now()});
   await writeJson(join(local,'runs',artifactStem+'.quality.json'),{mode:policy.mode,snapshotId:snapshot.id,at,...quality});
   if(!quality.eligible){
    await journalAppend(journal,{id,at,status:'rejected',decisionStatus:'filtered',action:proposal.action,pair:proposal.pair,snapshotId:snapshot.id,...(executionPolicyVersion?{executionPolicyVersion}:{}),reason:'ENTRY_QUALITY_REJECTED',reasons:quality.reasons});
    return {id,status:'filtered',action:proposal.action,reason:'ENTRY_QUALITY_REJECTED',reasons:quality.reasons};
   }
   await writeJson(join(local,'runs',artifactStem+'.version.json'),entryVersion);
   if(policy.mode!=='dry-run'){
    const proof=await protectionCheckFn({mode:policy.mode,local,account,pair:proposal.pair});
    await writeJson(join(local,'runs',artifactStem+'.protection-check.json'),proof);
   }
   if(portfolioCheck){
    const result=await portfolioCheck({proposal,mode:policy.mode,entryPlan:rulePlan});
    portfolioCheckedAt=now();
    await writeJson(join(local,'runs',artifactStem+'.portfolio-check.json'),result);
   }
  }
  const tag='codex-'+id;
  if(probePermit)await writeJson(join(local,'probe-permits',probePermit.id+'.json'),{...probePermit,consumedAt:new Date(now()).toISOString(),tag});
  if(rulePlan){
   rulePlan={...rulePlan,...(executionPolicyVersion?{executionPolicyVersion}:{}),tag,snapshotId:snapshot.id,createdAt:new Date(now()).toISOString()};
   await writeJson(join(local,'entry-plans',tag+'.json'),rulePlan);
  }
  await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'pending',action:proposal.action,pair:proposal.pair,stakeUsdt:proposal.stakeUsdt,
    snapshotId:snapshot.id,tag,...(executionPolicyVersion?{executionPolicyVersion}:{}),tradeId:decision.tradeId??null,...(rulePlan?{purpose:rulePlan.purpose,ruleVersion:rulePlan.strategyVariant??rulePlan.ruleVersion,volumeExperiment:rulePlan.volumeExperiment??null,...(rulePlan.entryEvidence?{entrySignalEngine:rulePlan.entrySignalEngine,entryEvidence:rulePlan.entryEvidence,entryPolicyVersion:rulePlan.entryPolicyVersion,...(rulePlan.executionQualityVersion?{executionQualityVersion:rulePlan.executionQualityVersion}:{}),...(rulePlan.entryConfirmation?.entryRoute?{entryRoute:rulePlan.entryConfirmation.entryRoute}:{}),riskPolicy:rulePlan.riskPolicy,strategyFingerprint:entryVersion.fingerprint}:{})}:{}),...(isFutures(policy.mode)?{leverage:proposal.leverage}:{})});
  let nativeAttempt,submissionResponded=false;
  try {
   if(isEntry(proposal.action) && await exists(join(local,'STOP'))) {
    await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'rejected',reason:'ENTRY_STOPPED_BEFORE_SEND'});
    throw new Error('ENTRY_STOPPED_BEFORE_SEND');
   }
   const result=await client.submit(proposal,tag,decision.tradeId,{beforeSend:async engine=>{
    if(isEntry(proposal.action)){
     if(await exists(join(local,'STOP')))throw Error('ENTRY_STOPPED_BEFORE_SEND');
     if(rulePlan&&engine.strategy_version!==RULE_ENGINE_VERSION)throw Error('RULE_ENGINE_RESTART_REQUIRED');
     if(!probePermit&&policy.mode!=='dry-run'&&snapshot.decisionEngine==='rules')assertVolumeAssignment(snapshot,await getVolumeConfig());
     if(portfolioCheckedAt!==undefined&&(now()-portfolioCheckedAt>15000||now()<portfolioCheckedAt))throw Error('PORTFOLIO_ACCOUNT_STALE');
     const nativeProtection=policy.mode!=='dry-run'?await protectionCheckFn({mode:policy.mode,local,account:{...account,engine},pair:proposal.pair}):null;
     if(policy.mode!=='dry-run'&&entryCost(snapshot.costFacts,executionQuote,policy.mode,costConfig,now()).status!=='ok')throw Error('ENTRY_COSTS_UNAVAILABLE');
     const latestVersion=await captureStrategyVersion({policy,engine,now:now()});
     if(latestVersion.fingerprint!==entryVersion.fingerprint)throw Error('STRATEGY_CHANGED_BEFORE_SEND');
     const clock=await getClock(policy.mode),wall=Date.now(),mono=performance.now();
     const check=()=>{
      if(Math.abs((Date.now()-wall)-(performance.now()-mono))>250)throw Error('CLOCK_JUMP_DETECTED');
      if(rulePlan?.entryPolicyVersion===FLOW_ONLY_POLICY){
       if(Date.now()>=(decisionTiming(snapshot)?.deadline??snapshot.candleBoundary+60000)||!assessOrderFlow(rulePlan.entryConfirmation.orderFlow,{mode:policy.mode,pair:proposal.pair,long:proposal.action!=='open-short',now:Date.now(),minTakerShare:rulePlan.adaptiveParameters?.minTakerShare}).eligible)throw Error('FLOW_EXPIRED_BEFORE_SEND');
      }
      return verifyEntryTiming({snapshot,pair:proposal.pair,mode:policy.mode,clock,now:Date.now()});
     };
     const timing=check();
     await writeJson(join(local,'runs',artifactStem+'.timing.json'),{mode:policy.mode,snapshotId:snapshot.id,checkedAt:new Date().toISOString(),clock,...timing});
     // Native callback and final CCXT transport enforce this same decision after
     // RPC queuing/throttling. Persist the final clock atomically, preserving age.
     if(nativeGuardInputs){
      rulePlan={...rulePlan,nativeEntryGuard:{...nativeGuardInputs,clock}};
      await writeJson(join(local,'entry-plans',tag+'.json'),rulePlan);
      nativeAttempt={mode:policy.mode,processId:nativeProtection?.engineProcessId,startedAt:now(),planSha256:entryPlanDigest(rulePlan)};
     }
     if(await exists(join(local,'STOP')))throw Error('ENTRY_STOPPED_BEFORE_SEND');
     return check;
    }
   },validUntil:Math.min(
    Date.parse(snapshot.createdAt)+policy.maxSignalAgeSeconds*1000,
    executionQuote?Date.parse(executionQuote.fetchedAt)+15000:Infinity)});
   submissionResponded=true;
   if(isEntry(proposal.action) && (!Number.isInteger(result?.trade_id)||result.pair!==proposal.pair||result.enter_tag!==tag))
    throw new Error('UNEXPECTED_ORDER_RESPONSE');
   if(isFutures(policy.mode)&&isEntry(proposal.action)&&(result.is_short!==(proposal.action==='open-short')||result.leverage!==proposal.leverage))throw new Error('UNEXPECTED_FUTURES_RESPONSE');
   if(isExit(proposal.action) && result?.result!==('Created exit order for trade '+decision.tradeId+'.'))
    throw new Error('UNEXPECTED_EXIT_RESPONSE');
   const record={id,at:new Date(now()).toISOString(),status:'submitted',action:proposal.action,
    tradeId:result.trade_id??decision.tradeId,pair:proposal.pair,tag};
   await journalAppend(journal,record);
   return record;
  } catch(e) {
   if(!submissionResponded&&e.submissionStarted!==false&&nativeAttempt&&isEntry(proposal.action)){
    const receipt=await readEntryRejection({local,plan:rulePlan,attempt:nativeAttempt,now:now()});
    if(receipt){
     const rejected={id,at:new Date(now()).toISOString(),status:'rejected',decisionStatus:'filtered',action:proposal.action,pair:proposal.pair,tag,snapshotId:snapshot.id,
      reason:'NATIVE_CALLBACK_REJECTED',reasons:[receipt.reason],purpose:rulePlan.purpose,ruleVersion:rulePlan.ruleVersion,
      nativeRejection:{...receipt,path:'entry-rejections/'+tag+'.json'}};
     await journalAppend(journal,rejected);
     return {...rejected,status:'filtered'};
    }
   }
   if(e.submissionStarted===false||e.message==='ORDER_DEADLINE_EXPIRED')await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'rejected',reason:e.message});
   else if(e.message!=='ENTRY_STOPPED_BEFORE_SEND')
    await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'unknown',action:proposal.action,tag,reason:'Submission outcome requires reconciliation'});
   throw e;
  }
 });
 return policy.mode!=='dry-run'&&isEntry(proposal.action)?portfolioEntryFn({mode:policy.mode},run):run(null);
}
