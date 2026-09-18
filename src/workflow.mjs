import { join } from 'node:path';
import { timeframeSpec } from './timeframe.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { exists,lock,writeJson,journalRead } from './io.mjs';
import { collect } from './research.mjs';
import { analyze } from './codex.mjs';
import { execute } from './bridge.mjs';
import { healthUpdate,recordFailure,event,safeError } from './health.mjs';
import { withEntryReasons } from './position-context.mjs';
import { accountContext,buildAnalystPrompt } from './analyst.mjs';
import { verifyScheduledCandles,verifyScheduledDecision } from './candle-schedule.mjs';
import { decisionTiming } from './entry-timing.mjs';
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
export async function runCycle({local,policy,client,signal,scheduledCandleBoundary,scheduledDecisionBoundary,collectFn=collect,analyzeFn=analyze,executeFn=execute,costsFn=collectCosts}){
 return lock(join(local,'cycle.lock'),async()=>{
  if(await exists(join(local,'STOP')))return {status:'stopped',message:'Entries paused; engine exits remain active'};
  let snapshot,proposal,executionStarted=false;const runId=randomUUID(),startedAt=new Date().toISOString();
  try{
   await healthUpdate(local,{mode:policy.mode,stage:'collecting',lastCycleStartedAt:startedAt});
   const account=await withEntryReasons(await client.snapshot(),local);
   const version=await captureStrategyVersion({policy,engine:account.engine});
   const decisionConfig=await loadDecisionConfig(),useRules=policy.mode!=='dry-run'&&decisionConfig.demoEngine==='rules';
   if(useRules&&account.engine?.strategy_version!==RULE_ENGINE_VERSION)throw Error('RULE_ENGINE_RESTART_REQUIRED');
   const costs=await costsFn(policy);
   // The independent research/chain observers retain Web3 context. Flow-only
   // execution needs fresh tape/quotes and must not await unrelated web queries.
   snapshot=await collectFn(policy,{includeWeb3:!useRules});
   attachCosts(snapshot,costs,await loadCosts());
   snapshot.decisionEngine=useRules?'rules':'ai';
   if(useRules){snapshot.ruleVersion=decisionConfig.ruleVersion;snapshot.entrySignalEngine='sampled_order_flow';}
   if(useRules)snapshot.volumeExperiment=volumeAssignment(snapshot.candleBoundary,await loadVolumeExperiment());
   if(scheduledCandleBoundary!==undefined){
    verifyScheduledCandles(snapshot,scheduledCandleBoundary);
    snapshot.scheduledCandleBoundary=scheduledCandleBoundary;
   }
   if(scheduledDecisionBoundary!==undefined){
    verifyScheduledDecision(snapshot,scheduledDecisionBoundary);
    snapshot.scheduledDecisionBoundary=scheduledDecisionBoundary;
   }
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
   const modelEvidence=useRules?{status:'observation_only',entryAllowed:null,usedForEntryDecision:false,reason:'ORDER_FLOW_ONLY_NO_MODEL_WAIT'}:undefined;
   if(useRules)await writeJson(join(local,'runs',snapshot.id+'.model-decision.json'),modelEvidence);
   const reference=rulesProposal(snapshot,policy,account,modelEvidence,{recentHistory,now:Date.parse(snapshot.completedAt??snapshot.createdAt)});
   await writeJson(join(local,'runs',snapshot.id+'.rules.json'),reference);
   if(useRules&&policy.mode==='demo')enqueueInitialSpotCandidates(local,{snapshot,reference,policy,account,strategyVersion:version,now:Date.now()});
   if(useRules){
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
   const result=useRules&&isEntry(proposal.action)?await runEntryBatch({reference,snapshot,policy,client,local,modelEvidence,strategyVersion:version,executeFn,signal}):await executeFn({proposal,snapshot,policy,client,local,strategyVersion:version});
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
