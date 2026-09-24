import { join } from 'node:path';
import { timeframeSpec } from './timeframe.mjs';
import { randomUUID } from 'node:crypto';
import { appendFile,writeFile } from 'node:fs/promises';
import { exists,lock,writeJson,readJson,journalRead } from './io.mjs';
import { collect,collectOrderFlow } from './research.mjs';
import { analyze } from './codex.mjs';
import { execute } from './bridge.mjs';
import { healthUpdate,recordFailure,event,safeError } from './health.mjs';
import { withEntryReasons } from './position-context.mjs';
import { accountContext,buildAnalystPrompt } from './analyst.mjs';
import { verifyScheduledCandles,verifyScheduledDecision } from './candle-schedule.mjs';
import { decisionTiming,aiEntryWindow } from './entry-timing.mjs';
import { captureStrategyVersion } from './strategy-version.mjs';
import { clockRange } from './exchange-clock.mjs';
import { collectCosts,attachCosts,loadCosts } from './trading-costs.mjs';
import { loadDecisionConfig,rulesProposal,RULE_ENGINE_VERSION } from './decision.mjs';
import { refreshForwardReport } from './forward-store.mjs';
import { expectedEntryWait,dailyEntryAllowance } from './entry-wait.mjs';
import { isEntry } from './mode.mjs';
import {runEntryBatch} from './batch-entry.mjs';
import {loadVolumeExperiment,volumeAssignment} from './volume-experiment.mjs';
import {enqueueInitialSpotCandidates} from './spot-candidate-store.mjs';
import {waitForModelEvidence} from './model-entry.mjs';
import {loadKevEntryConfig,reviewKevEntries,kevBlockedPairs} from './kev-entry.mjs';
import {KEV_FLOW_POLICY,kevFlowReference} from './kev-flow.mjs';
import {normalizeConfirmationState} from './kev-confirmation.mjs';
export async function runCycle({local,policy,client,signal,scheduledCandleBoundary,scheduledDecisionBoundary,collectFn=collect,analyzeFn=analyze,executeFn=execute,costsFn=collectCosts,modelEvidenceFn=waitForModelEvidence,kevReviewFn=reviewKevEntries,kevConfigFn=loadKevEntryConfig}){
 return lock(join(local,'cycle.lock'),async()=>{
  if(await exists(join(local,'STOP')))return {status:'stopped',message:'Entries paused; engine exits remain active'};
  let snapshot,proposal,executionStarted=false;const runId=randomUUID(),startedAt=new Date().toISOString();
  try{
   await healthUpdate(local,{mode:policy.mode,stage:'collecting',lastCycleStartedAt:startedAt});
   const account=await withEntryReasons(await client.snapshot(),local);
   const version=await captureStrategyVersion({policy,engine:account.engine});
   const decisionConfig=await loadDecisionConfig(),useRules=policy.mode!=='dry-run'&&decisionConfig.demoEngine==='rules';
   const kevConfig=useRules?await kevConfigFn({local,mode:policy.mode}):null;
   const kevFlow=useRules&&kevConfig?.marketData==='order-flow';
   if(kevFlow&&(!kevConfig.enabled||kevConfig.decisionMode!=='autonomous'))throw Error('KEV_ORDER_FLOW_ACTIVATION_REQUIRED');
   if(useRules&&account.engine?.strategy_version!==RULE_ENGINE_VERSION)throw Error('RULE_ENGINE_RESTART_REQUIRED');
   const costs=await costsFn(policy);
   // The independent research/chain observers retain Web3 context. Flow-only
   // execution needs fresh tape/quotes and must not await unrelated web queries.
   snapshot=await (kevFlow&&collectFn===collect?collectOrderFlow:collectFn)(policy,{includeWeb3:!useRules});
   attachCosts(snapshot,costs,await loadCosts());
   snapshot.decisionEngine=useRules?'rules':'ai';
   const modelAssist=useRules&&!kevFlow&&['demo','demo-futures'].includes(policy.mode);
   if(modelAssist)snapshot.aiAssist={version:'kronos-flow-v1',enabled:true,entryMode:'ai-only',
    scope:policy.mode==='demo'?'spot-ai-entry':'futures-ai-entry',model:'kronos-small-pretrained-v1'};
   if(kevConfig?.enabled)snapshot.kevEntry={version:kevConfig.version,enabled:true,model:kevConfig.expectedModel,
    decisionMode:kevConfig.decisionMode,role:kevConfig.decisionMode==='autonomous'?'autonomous_selection':'entry_approval'};
   if(useRules){snapshot.ruleVersion=kevFlow?KEV_FLOW_POLICY:decisionConfig.ruleVersion;snapshot.entrySignalEngine=kevFlow?'kev_order_flow':modelAssist?'kronos_ai':'sampled_order_flow';}
   if(useRules&&!kevFlow)snapshot.volumeExperiment=volumeAssignment(snapshot.candleBoundary,await loadVolumeExperiment());
   if(scheduledCandleBoundary!==undefined){
    verifyScheduledCandles(snapshot,scheduledCandleBoundary);
    snapshot.scheduledCandleBoundary=scheduledCandleBoundary;
   }
   if(scheduledDecisionBoundary!==undefined){
    verifyScheduledDecision(snapshot,scheduledDecisionBoundary);
    snapshot.scheduledDecisionBoundary=scheduledDecisionBoundary;
   }
   const modelSchedule=modelAssist?aiEntryWindow(snapshot):null;
   if(modelSchedule)snapshot.modelSchedule=modelSchedule;
   await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),snapshot);
   await writeJson(join(local,'runs',snapshot.id+'.version.json'),version);
   await writeJson(join(local,'runs',snapshot.id+'.account.json'),{capturedAt:startedAt,
    context:accountContext(account,Date.parse(snapshot.createdAt))});
   const boundary=snapshot.candleBoundary;
   const decision=decisionTiming(snapshot);
   const created=Date.parse(snapshot.createdAt),clockLower=snapshot.clock?clockRange(snapshot.clock,policy.mode,created).lower:created;
   const timing={snapshotId:snapshot.id,createdAt:snapshot.createdAt,
    ...(decision?{decisionCadenceVersion:snapshot.decisionCadenceVersion,decisionBoundary:decision.boundary,decisionIntervalMs:decision.intervalMs}:{}),
    lastCandleCloseAt:Number.isSafeInteger(boundary)?new Date(boundary-1).toISOString():null,
    signalExpiresAt:new Date(Math.min(clockLower+policy.maxSignalAgeSeconds*1000,
     decision?.deadline??(Number.isSafeInteger(boundary)?boundary+timeframeSpec(snapshot.timeframe).ms:Infinity))).toISOString()};
   await healthUpdate(local,{stage:'analyzing',snapshotId:snapshot.id,timing});
   const recentHistory=useRules&&typeof client.history==='function'?await client.history():[];
   const modelEvidence=useRules?(modelAssist?(modelSchedule.due
    ?await modelEvidenceFn({snapshot,local,signal})
    :{status:'not_due',entryAllowed:false,usedForEntryDecision:false,reason:modelSchedule.reason,
      scheduleVersion:modelSchedule.version,nextEntryAt:new Date(modelSchedule.nextEntryBoundary).toISOString()})
    :{status:'observation_only',entryAllowed:null,usedForEntryDecision:false,reason:'ORDER_FLOW_ONLY_NO_MODEL_WAIT'}):undefined;
   if(useRules)await writeJson(join(local,'runs',snapshot.id+'.model-decision.json'),modelEvidence);
   const confirmationPath=join(local,'kev-confirmation.json');
   const confirmationState=kevFlow
    ?normalizeConfirmationState(await (await exists(confirmationPath)?readJson(confirmationPath):null),{mode:policy.mode,intervalMs:snapshot.decisionIntervalMs})
    :null;
   let reference=kevFlow?kevFlowReference(snapshot,policy,account,{recentHistory,confirmationState,now:Date.parse(snapshot.completedAt??snapshot.createdAt)}):rulesProposal(snapshot,policy,account,modelEvidence,{recentHistory,now:Date.parse(snapshot.completedAt??snapshot.createdAt)});
   if(kevFlow)await writeJson(confirmationPath,reference.metadata.confirmationState);
   if(kevFlow)await appendFile(join(local,'kev-shadow-signals.jsonl'),JSON.stringify({version:'kev-shadow-alignment-v1',at:new Date().toISOString(),snapshotId:snapshot.id,
    mode:policy.mode,signals:reference.metadata?.shadowCandidates??[],policy:'one-sided-order-flow-never-submits'})+'\n','utf8');
   await writeJson(join(local,'runs',snapshot.id+'.rules.json'),reference);
   let kevReview;
   if(kevConfig?.enabled){
    kevReview=await kevReviewFn({reference,snapshot,policy,account,config:kevConfig,signal});
    await writeJson(join(local,'runs',snapshot.id+'.kev-review.json'),kevReview);
    if(kevFlow){
      reference=kevFlowReference(snapshot,policy,account,{recentHistory,review:kevReview,
       confirmationState:reference.metadata.confirmationState,now:Date.now()});
      if(kevFlow)await writeJson(confirmationPath,reference.metadata.confirmationState);
    }else if(isEntry(reference.proposal.action)||kevReview.status==='reviewed'){
     reference=rulesProposal(snapshot,policy,account,modelEvidence,{recentHistory,excludedPairs:kevBlockedPairs(kevReview,policy),now:Date.now()});
     reference.proposal.reason+=(isEntry(reference.proposal.action)
      ?(kevReview.decisionMode==='autonomous'?' Kev／Codex 自主選定本輪候選；仍須通過送單前風控。':' Kev／Codex 同意本輪候選；仍須通過送單前風控。')
      :' Kev／Codex 未批准本輪進場：'+(kevReview.reason??'KEV_ENTRY_VETO')+'。');
    }
    reference.metadata={...reference.metadata,llmInvoked:kevReview.invoked,
     kevEntry:{version:kevReview.version,decisionMode:kevReview.decisionMode??kevConfig.decisionMode,status:kevReview.status,
      reason:kevReview.reason,model:kevReview.actualModel??kevConfig.expectedModel,requestAttempted:kevReview.requestAttempted,
      requestId:kevReview.requestId??null,approvedPairs:kevReview.approvedPairs,selection:kevReview.selection??null,usage:kevReview.usage??null}};
    await writeJson(join(local,'runs',snapshot.id+'.rules-reviewed.json'),reference);
   }
   if(useRules&&!kevFlow&&policy.mode==='demo')enqueueInitialSpotCandidates(local,{snapshot,reference,policy,account,strategyVersion:version,now:Date.now()});
   if(useRules&&!kevFlow){
    const review=await buildAnalystPrompt({snapshot,policy,account,ruleReference:reference});
    await writeFile(join(local,'runs',snapshot.id+'.review-prompt.txt'),review.prompt,'utf8');
    await writeJson(join(local,'runs',snapshot.id+'.prompt-contract.json'),{...review.metadata,llmInvoked:false,role:'review_only'});
   }
   const analysis=useRules?reference:await analyzeFn(snapshot,policy,account,{signal});proposal=analysis.proposal;
   if(analysis.metadata)await writeJson(join(local,'runs',snapshot.id+'.analysis.json'),analysis.metadata);
   await writeJson(join(local,'runs',snapshot.id+'.proposal.json'),proposal);
   if(signal?.aborted)throw new Error('CYCLE_ABORTED');
   const latestVersion=await captureStrategyVersion({policy,engine:account.engine});
   if(latestVersion.fingerprint!==version.fingerprint)throw new Error('STRATEGY_CHANGED_DURING_CYCLE');
   await healthUpdate(local,{stage:'executing'});
   executionStarted=true;
   const result=useRules&&isEntry(proposal.action)?await runEntryBatch({reference,snapshot,policy,client,local,modelEvidence,strategyVersion:version,executeFn,signal,kevReview}):await executeFn({proposal,snapshot,policy,client,local,strategyVersion:version,kevReview});
   const outcome={mode:policy.mode,at:new Date().toISOString(),startedAt,snapshotId:snapshot.id,status:'completed',result};
   await writeJson(join(local,'runs',snapshot.id+'.outcome.json'),outcome);
   await healthUpdate(local,{stage:'idle',consecutiveFailures:0,lastError:null,lastSuccessAt:outcome.at,
    lastCycleCompletedAt:outcome.at,entryWait:null,lastDecisionStatus:result.status,timing:{...timing,consumed:true}});
   await event(local,{type:'cycle_completed',snapshotId:snapshot.id,action:proposal.action,result:result.status});
   if(policy.mode!=='dry-run'&&await exists(join(local,'forward-trial.json'))){
    try{await refreshForwardReport(local,client);await healthUpdate(local,{lastForwardError:null});}
    catch(e){await healthUpdate(local,{lastForwardError:safeError(e)});}
   }
   return {snapshot:join(local,'runs',snapshot.id+'.snapshot.json'),proposal,runDir:analysis.runDir,result};
  }catch(error){
   const aborted=signal?.aborted===true;
   const wait=!aborted&&executionStarted&&isEntry(proposal?.action)?expectedEntryWait(error):null;
   if(wait){
    // A matching error message never releases an unresolved submission. The
    // bridge journal remains authoritative even if an adapter reports a limit.
    let allowance;
    try{
     const records=await journalRead(join(local,'orders.jsonl'));
     const latest=new Map(records.map(r=>[r.id,r]));
     if([...latest.values()].some(r=>['pending','unknown'].includes(r.status)))throw Error('UNRESOLVED_SUBMISSION');
     allowance=dailyEntryAllowance(records,policy);
    }catch(journalError){error=journalError;}
    if(allowance){
     const at=new Date().toISOString();
     const result={...wait,dailyEntryAllowance:allowance};
     await writeJson(join(local,'runs',snapshot.id+'.outcome.json'),{
      mode:policy.mode,at,startedAt,snapshotId:snapshot.id,...result,result});
     await healthUpdate(local,{stage:'waiting_risk',consecutiveFailures:0,lastError:null,lastSuccessAt:at,
      lastCycleCompletedAt:at,lastDecisionStatus:'waiting',entryWait:{...wait,since:at},dailyEntryAllowance:allowance});
     await event(local,{type:'cycle_waiting',snapshotId:snapshot.id,action:proposal.action,...wait});
     return {status:'waiting',reason:wait.reason,resetAt:wait.resetAt,
      snapshot:join(local,'runs',snapshot.id+'.snapshot.json'),proposal,result};
    }
   }
   await writeJson(join(local,'runs',(snapshot?.id??runId)+'.outcome.json'),{
    mode:policy.mode,at:new Date().toISOString(),startedAt,snapshotId:snapshot?.id??null,status:aborted?'aborted':'failed',code:safeError(error)});
   if(aborted)await healthUpdate(local,{stage:'aborted'});else await recordFailure(local,error);
   throw error;
  }
 });
}
