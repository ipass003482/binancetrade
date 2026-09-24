#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile,unlink,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {startOrderFlowSampler} from './order-flow-collector.mjs';
import { ROOT } from './paths.mjs';
import { modeArgs,modeLocal } from './mode.mjs';
import { loadPolicy } from './config.mjs';
import { readJson,writeJson,exists,lock,journalRead } from './io.mjs';
import { setup } from './setup.mjs';
import { setupDemo } from './demo-setup.mjs';
import { collect,web3 } from './research.mjs';
import { analyze } from './codex.mjs';
import { FreqtradeClient } from './freqtrade.mjs';
import { execute } from './bridge.mjs';
import { startEngine,PYTHON } from './engine.mjs';
import { runCycle } from './workflow.mjs';
import { reconcile } from './reconcile.mjs';
import { healthStatus,healthUpdate,recoverLock,safeError } from './health.mjs';
import { buildReport } from './report.mjs';
import { evaluateSavedHistory } from './evaluation.mjs';
import { nextDecisionBoundary,lastDecisionClaim,claimDecisionBoundary,closeBufferMs } from './candle-schedule.mjs';
import {FLOW_DECISION_CADENCE_VERSION,FLOW_DECISION_INTERVAL_MS} from './entry-timing.mjs';
import { recordEquity } from './equity.mjs';
import { collectCosts } from './trading-costs.mjs';
import { beginForwardTrial,refreshForwardReport } from './forward-store.mjs';
import { FLOW_ONLY_PARAMETERS as DEMO_PARAMETERS,DEMO_RULE_VERSION } from './demo-rules.mjs';
import { refreshPortfolio } from './portfolio-store.mjs';
import { loadKevEntryConfig } from './kev-entry.mjs';
const out=x=>console.log(JSON.stringify(x,null,2));
const parsed=modeArgs(process.argv.slice(2)),mode=parsed.mode,LOCAL=modeLocal(mode);
const [command,...args]=parsed.args;
function count(n){if(args.length!==n)throw new Error('INVALID_ARGUMENTS: run help');}
export function watchDecisionSettings(selectedMode,kevConfig){
 if(selectedMode==='dry-run')return {};
 if(!['demo','demo-futures'].includes(selectedMode))throw Error('MODE_REJECTED');
 const settings={decisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,decisionIntervalMs:FLOW_DECISION_INTERVAL_MS};
 if(kevConfig?.marketData!=='order-flow')return settings;
 if(kevConfig.enabled!==true||kevConfig.decisionMode!=='autonomous')throw Error('KEV_ORDER_FLOW_ACTIVATION_REQUIRED');
 const route={entryPolicyVersion:'kev-order-flow-v1'};
 return {...settings,...route,timeframe:'order-flow',entryDecisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,
  entryDecisionIntervalMs:FLOW_DECISION_INTERVAL_MS,collectionDelayMs:closeBufferMs(selectedMode,route)};
}
async function client(){return new FreqtradeClient(await loadPolicy(mode),await readJson(join(LOCAL,'api-auth.json')));}
async function saveResearch(){
 const snapshot=await collect(await loadPolicy(mode)),file=join(LOCAL,'runs',snapshot.id+'.snapshot.json');
 await writeJson(file,snapshot);return {snapshot,file};
}
async function cycle(signal,scheduledDecisionBoundary){return runCycle({local:LOCAL,policy:await loadPolicy(mode),client:await client(),signal,scheduledDecisionBoundary});}
export async function assertProtectionResumeAllowed(selectedMode,{localFor=modeLocal}={}){
 if(selectedMode==='dry-run')return;
 if(!['demo','demo-futures'].includes(selectedMode))throw Error('MODE_REJECTED');
 for(const checkMode of ['demo','demo-futures']){
  const file=join(localFor(checkMode),'protection-readiness.json');
  if(!await exists(file))continue; // Missing readiness is not a claim of protection.
  const protection=await readJson(file);
  if(protection.version!=='demo-native-stop-v1'||protection.mode!==checkMode||!Array.isArray(protection.attempts)
   ||!Number.isInteger(protection.unresolvedStops)||protection.unresolvedStops<0
   ||protection.attempts.some(attempt=>!attempt||!['pending','unknown','confirmed','rejected'].includes(attempt.status)))
   throw Error('DEMO_PROTECTION_STATE_INVALID');
  if(protection.unresolvedStops>0||protection.attempts.some(attempt=>['pending','unknown'].includes(attempt.status)))
   throw Error('DEMO_PROTECTION_UNRESOLVED');
 }
}
async function doctor(){
 const report={node:process.version,mode,dockerRequired:false,checks:{}};
 for(const[name,exe,argv]of[['codex',process.platform==='win32'?'codex.exe':'codex',['--version']],['freqtrade',PYTHON,['-m','freqtrade','--version']]]){
  try{report.checks[name]={ok:true,version:execFileSync(exe,argv,{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim()};}
  catch{report.checks[name]={ok:false,message:name==='freqtrade'?'Run bootstrap-native.ps1':'Check native Codex installation/login'};}
 }
 report.checks.setup={ok:await exists(join(LOCAL,'api-auth.json'))};
 if(mode!=='dry-run')report.checks.credentials={ok:await exists(join(LOCAL,'credentials.dpapi.json')),note:'Presence only; no secret read by doctor'};
 try{report.health=await healthStatus(LOCAL,await client(),await loadPolicy(mode));}
 catch(e){report.health={healthy:false,error:safeError(e)};}
 return report;
}
async function watch(){
 if(await exists(join(LOCAL,'TRADING_DISABLED')))return {status:'trading_disabled',message:'本機交易已停用；未啟動研究排程或進場流程。'};
 return lock(join(LOCAL,'watch.lock'),async()=>{
  const schedule=watchDecisionSettings(mode,mode==='dry-run'?null:await loadKevEntryConfig({local:LOCAL,mode}));
  // One startup marker records the user's requested continuous operation.
  // STOP pauses this entry watcher, while the separate engine supervisor can
  // still maintain exits. Heartbeats and shutdown must not reset this marker.
  await writeJson(join(LOCAL,'continuous.json'),{enabled:true,updatedAt:new Date().toISOString(),...schedule});
  const forwardClient=mode==='dry-run'?null:await client();
  if(forwardClient)await beginForwardTrial(LOCAL,mode,await forwardClient.history(),{ruleVersion:DEMO_RULE_VERSION,parameters:DEMO_PARAMETERS});
  const abort=new AbortController(),stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let pending=Promise.resolve();
  const heartbeat=()=>{pending=pending.then(()=>writeJson(join(LOCAL,'watch-heartbeat.json'),{pid:process.pid,at:new Date().toISOString()})).catch(()=>{});};
  heartbeat();const timer=setInterval(heartbeat,15000);
  const stopFlow=mode==='dry-run'?async()=>{}:startOrderFlowSampler(await loadPolicy(mode),LOCAL);
  let equityTask=null;
  const sampleEquity=()=>{if(mode==='dry-run'||equityTask)return;equityTask=recordEquity(LOCAL,mode)
   .then(r=>healthUpdate(LOCAL,{lastEquitySampleAt:r?.observedAt??null,lastEquityError:r?.lastAttempt?.reason??null}))
   .catch(e=>healthUpdate(LOCAL,{lastEquityError:safeError(e)})).catch(()=>{})
   .then(()=>refreshForwardReport(LOCAL,forwardClient))
   .catch(e=>healthUpdate(LOCAL,{lastForwardError:safeError(e)})).catch(()=>{})
   .finally(()=>{equityTask=null;});};
  sampleEquity();const equityTimer=setInterval(sampleEquity,60000);
  let portfolioTask=null;
  const samplePortfolio=()=>{
   if(mode==='dry-run'||portfolioTask)return;
   portfolioTask=refreshPortfolio()
    .then(report=>healthUpdate(LOCAL,{lastPortfolioSampleAt:report.asOf,lastPortfolioError:null}))
    .catch(error=>healthUpdate(LOCAL,{lastPortfolioError:safeError(error)})).catch(()=>{})
    .finally(()=>{portfolioTask=null;});
  };
  samplePortfolio();const portfolioTimer=setInterval(samplePortfolio,60000);
  try{
   while(!abort.signal.aborted){
    if(await exists(join(LOCAL,'STOP'))){out({status:'stopped'});break;}
    let boundary;const closeBuffer=closeBufferMs(mode,schedule);
    if(mode!=='dry-run'){
     boundary=nextDecisionBoundary(Date.now(),await lastDecisionClaim(LOCAL),mode,schedule);
     await healthUpdate(LOCAL,{stage:'waiting_decision',nextResearchAt:new Date(boundary+closeBuffer).toISOString()});
     while(Date.now()<boundary+closeBuffer&&!abort.signal.aborted&&!await exists(join(LOCAL,'STOP'))){
      try{await delay(Math.min(1000,boundary+closeBuffer-Date.now()),null,{signal:abort.signal});}catch{break;}
     }
     if(abort.signal.aborted||await exists(join(LOCAL,'STOP')))break;
     if(!await claimDecisionBoundary(LOCAL,boundary,Date.now(),mode,schedule))continue;
    }
    try{out(await cycle(abort.signal,boundary));}
    catch(e){out({status:'cycle_failed',error:safeError(e)});}
    if(mode!=='dry-run')continue;
    const end=Date.now()+(await loadPolicy(mode)).intervalSeconds*1000;
    while(Date.now()<end&&!abort.signal.aborted&&!await exists(join(LOCAL,'STOP'))){
     try{await delay(Math.min(1000,end-Date.now()),null,{signal:abort.signal});}catch{break;}
    }
   }
  }finally{
   clearInterval(timer);clearInterval(equityTimer);clearInterval(portfolioTimer);
   await stopFlow();await pending;await Promise.allSettled([equityTask,portfolioTask]);
   process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
 });
}
async function main(){
 switch(command){
 case 'setup':count(0);return out(mode!=='dry-run'?await setupDemo(await loadPolicy(mode)):await setup());
 case 'doctor':count(0);return out(await doctor());
 case 'engine':count(0);return startEngine(mode);
 case 'research':count(0);{const r=await saveResearch();return out({mode,file:r.file,coverage:r.snapshot.researchCoverage,errors:r.snapshot.errors});}
 case 'web3':count(3);return out(await web3(args[0],args[1],JSON.parse(args[2])));
 case 'analyze':case 'codex-smoke':count(1);{
  const s=await readJson(args[0]);if(s.mode!==mode)throw new Error('SNAPSHOT_MODE_MISMATCH');
  return out(await analyze(s,await loadPolicy(mode),{trades:[]},{forceHold:command==='codex-smoke'}));
 }
 case 'execute':count(2);return out(await execute({snapshot:await readJson(args[0]),proposal:await readJson(args[1]),
  policy:await loadPolicy(mode),client:await client(),local:LOCAL}));
 case 'cycle':count(0);{
  const abort=new AbortController(),stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return out(await cycle(abort.signal));}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
 case 'watch':count(0);return watch();
 case 'costs':count(0);return out(await collectCosts(await loadPolicy(mode)));
 case 'equity':count(0);return out(await recordEquity(LOCAL,mode));
 case 'portfolio':count(0);if(mode==='dry-run')throw Error('PORTFOLIO_DEMO_ONLY');return out(await refreshPortfolio());
 case 'stop':count(0);await mkdir(LOCAL,{recursive:true});await writeFile(join(LOCAL,'STOP'),new Date().toISOString());
  return out({mode,status:'entry_stopped',message:'Existing positions remain managed by engine exits. No liquidation requested.'});
 case 'resume':count(0);{
  await(await client()).snapshot();
  await assertProtectionResumeAllowed(mode);
  const records=await journalRead(join(LOCAL,'orders.jsonl')),latest=new Map(records.map(r=>[r.id,r]));
  if([...latest.values()].some(r=>['pending','unknown'].includes(r.status)))throw new Error('UNRESOLVED_SUBMISSION');
  if(await exists(join(LOCAL,'STOP')))await unlink(join(LOCAL,'STOP'));
  await healthUpdate(LOCAL,{consecutiveFailures:0,lastError:null,stage:'idle'});
  return out({mode,status:'entry_enabled',message:'Run cycle or watch explicitly.'});
 }
 case 'status':count(0);{
  let engine;try{engine=await(await client()).snapshot();}catch(e){engine={available:false,error:safeError(e)};}
  return out({mode,stopped:await exists(join(LOCAL,'STOP')),engine,journal:(await journalRead(join(LOCAL,'orders.jsonl'))).slice(-10)});
 }
 case 'health':count(0);return out(await healthStatus(LOCAL,await client(),await loadPolicy(mode)));
 case 'recover-lock':count(1);return out(await recoverLock(LOCAL,args[0]));
 case 'reconcile':count(0);return out(await reconcile(LOCAL,await client()));
 case 'report':count(0);return out(await buildReport(LOCAL,await client(),mode));
 case 'forward':count(0);return out(await refreshForwardReport(LOCAL,await client()));
 case 'evaluate':if(args.length>1)throw new Error('INVALID_ARGUMENTS: evaluate [saved-history.json]');
  return out(await evaluateSavedHistory({local:LOCAL,mode,...(args[0]?{input:args[0]}:{})}));
 case 'demo-check':count(0);{
  if(mode==='dry-run')throw new Error('DEMO_MODE_REQUIRED');
  try{
   const result=execFileSync(PYTHON,[join(ROOT,mode==='demo-futures'?'scripts/demo-futures-engine.py':'scripts/demo-check.py'),...(mode==='demo-futures'?['--check']:[])],{cwd:ROOT,encoding:'utf8',timeout:90000,
    windowsHide:true,stdio:['ignore','pipe','pipe']});
   return out(JSON.parse(result));
  }catch(e){
   try{const value=JSON.parse(e.stdout);if(value.status==='failed'){process.exitCode=1;return out(value);}}catch{}
   throw new Error('DEMO_CHECK_FAILED');
  }
 }
 case 'help':case undefined:return console.log(
  'Binance trade | native Windows | dry-run default; --mode demo for spot; --mode demo-futures for isolated perpetuals (max 3x)\n'+
  'setup / doctor / engine       Prepare, inspect, start selected engine\n'+
  'research / analyze <snapshot> Collect evidence or produce a proposal\n'+
  'codex-smoke <snapshot>        Force HOLD to check native CLI integration\n'+
  'cycle / watch                One guarded cycle or foreground repeat\n'+
  'stop / resume                Pause or enable entries; no liquidation\n'+
  'status / health / report     Account, health, Markdown + JSON report\n'+
  'forward                     Current actual Demo trial results, probes separated\n'+
  'portfolio --mode demo        Refresh shared spot/futures Demo capital and performance\n'+
  'evaluate [saved-history.json] Offline performance evidence; no orders or network\n'+
  'costs / equity               Read-only Demo fee facts or equity sample\n'+
  'reconcile                    Resolve only proven submission outcomes\n'+
  'recover-lock <name>          Remove one lock only after proving no owner/child/project process\n'+
  'demo-check --mode demo       Read-only Demo account/market connectivity\n'+
  'execute <snapshot> <proposal> Guarded execution of saved proposal\n'+
  'web3 <skill> <cmd> <json>     Reviewed public query\n'+
  'Demo credentials: powershell.exe -NoProfile -File scripts/configure-demo.ps1');
 default:throw new Error('UNKNOWN_COMMAND');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(e=>{console.error(JSON.stringify({error:safeError(e)}));process.exitCode=1;});
