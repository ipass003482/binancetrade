import {recordedEntryId,entryArtifactStem} from './entry-identity.mjs';
// Entry-time provenance. Never read authentication, local engine config, or credentials.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { AnalystSchema,loadAnalyst } from './analyst.mjs';
import { demoStrategyContract } from './strategy-contract.mjs';
import { FLOW_ONLY_POLICY } from './order-flow.mjs';
import { MODES,isFutures } from './mode.mjs';
import { exists,readJson } from './io.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
 return value;
}
const policyFields=['timeframe','mode','pairs','maxStakeUsdt','maxExposureUsdt','maxOpenTrades','maxDailyLossUsdt','maxEntriesPerDay',
 'maxSignalAgeSeconds','maxSpreadBps','maxPriceMoveBps','intervalSeconds','leverage','marginMode','maxNotionalUsdt','maxTotalNotionalUsdt'];
const engineFields=['strategy','strategy_version','timeframe','trading_mode','margin_mode','stoploss','minimal_roi','trailing_stop',
 'trailing_stop_positive','trailing_stop_positive_offset','trailing_only_offset_is_reached','use_exit_signal',
 'exit_profit_only','ignore_roi_if_entry_signal','position_adjustment_enable','max_open_trades','order_types','stoploss_on_exchange'];
const select=(input,fields)=>Object.fromEntries(fields.filter(k=>input?.[k]!==undefined).map(k=>[k,input[k]]));
// These files belong only to the independent forecast observer. Shared risk
// helpers and the native entry guard remain mandatory execution sources.
const observerSources=Object.freeze(['src/model-entry.mjs','config/model-execution.json','config/model-research.json',
 'src/pretrained_model.py','scripts/kronos-worker.py','scripts/setup_kronos.py','requirements.model.lock']);
export async function captureStrategyVersion({policy,analyst,engine,root=ROOT,now=Date.now(),entryPolicyVersion}){
 if(!MODES.includes(policy.mode))throw Error('VERSION_MODE_REJECTED');
 // The default follows the host's executable contract, not observer config or
 // snapshot text. Historical/non-flow callers retain the original source scope.
 const entryPolicy=entryPolicyVersion===undefined&&policy.mode!=='dry-run'?demoStrategyContract(policy).entryPolicyVersion:entryPolicyVersion;
 const flowOnly=policy.mode!=='dry-run'&&entryPolicy===FLOW_ONLY_POLICY;
 const profile=AnalystSchema.parse(analyst??await loadAnalyst());
 const files=['src/volume-experiment.mjs','config/volume-experiment.json','src/strategy-contract.mjs','src/demo-probe.mjs','src/demo-order-size.mjs','src/demo-rules.mjs','src/timeframe.mjs','src/account-facts.mjs','src/trading-costs.mjs','src/baseline.mjs','src/decision.mjs','config/costs.json','config/decision.json','scripts/demo-account-facts.py',
  'src/exchange-clock.mjs','src/entry-timing.mjs','src/strategy-version.mjs','src/analyst.mjs','src/codex.mjs','src/research.mjs','src/research-profile.mjs','src/position-context.mjs',
  'src/entry-quality.mjs','src/workflow.mjs','src/bridge.mjs','src/entry-rejection.mjs','src/risk.mjs','src/freqtrade.mjs','src/config.mjs',
  'src/mode.mjs','src/engine-config.mjs','src/candle-schedule.mjs','src/io.mjs','src/http.mjs','config/research.json','config/policy.json','config/analyst.json','requirements.windows.lock','package.json','package-lock.json',
  'prompts/analyst-'+(isFutures(policy.mode)?'futures-':'')+profile.style+'.md',
  'freqtrade/strategies/'+(isFutures(policy.mode)?'CodexDemoFutures':'CodexResearchSpot')+'.py'];
 // The quote-study helpers are statically imported by the trading runtime;
 // unlike the detached forecast observer, their code remains source-attested.
 files.push('src/adaptive-parameters.mjs','src/order-flow.mjs','src/order-flow-collector.mjs','src/spot-flow-observer.mjs','src/spot-flow-store.mjs','src/spot-candidate.mjs','src/spot-candidate-store.mjs','src/cli.mjs','scripts/demo_order_flow.py','scripts/demo_flow_exit.py','src/model-pullback.mjs','src/demo-risk.mjs','src/model-momentum.mjs','src/entry-identity.mjs','src/batch-entry.mjs');
 if(policy.mode==='demo')files.push('freqtrade/strategies/CodexDemoSpot.py','scripts/demo-engine.py');
 if(policy.mode==='demo-futures')files.push('scripts/demo-futures-engine.py');
 if(policy.mode!=='dry-run')files.push('freqtrade/strategies/RuleExits.py','scripts/demo_protection.py','scripts/demo_rpc_sessions.py','scripts/demo_model_guard.py','scripts/supervisor-inventory.ps1','src/protection.mjs','src/portfolio.mjs','src/portfolio-store.mjs','src/entry-wait.mjs','config/portfolio.json',
  ...(!flowOnly?observerSources:[]));
 const sources=await Promise.all(files.sort().map(async path=>({path,sha256:hash(await readFile(join(root,path)))})));
 const contract=canonical({schemaVersion:1,mode:policy.mode,analyst:profile,policy:select(policy,policyFields),
  engine:engine?select(engine,engineFields):null,sources,
  ...(flowOnly?{executionScope:{version:'flow-execution-sources-v1',entryPolicyVersion:FLOW_ONLY_POLICY,excludedObserverSources:observerSources},
   // Deliberately no observer filesystem reads, even best-effort ones: a slow
   // or missing research store must not consume the entry's deadline. The
   // watchdog still verifies its own pin independently; this is not its proof.
   observerProvenance:{status:'not_collected',reason:'OBSERVER_PROVENANCE_OUTSIDE_ENTRY_PATH',
    usedForEntryDecision:false,modelPinVerified:false,verificationOwner:'src/model-watchdog.mjs'}}:{})});
 return {...contract,fingerprint:hash(JSON.stringify(contract)),capturedAt:new Date(now).toISOString(),
  scope:'On-disk source files, effective policy and observed engine exit settings at entry. Restart after source edits; this does not attest loaded process code, external Web3 adapter code, a historical holdout, or unchanged exits throughout a position.'+
   (flowOnly?' Pure forecast-observer sources are excluded. Observer availability and model pin are not verified by this execution manifest; consult the independent model watchdog.':'')};
}

// Only join exact recorded entry tags to entry-time manifests. Never backfill old trades.
export async function readTradeVersions(local,trades,records,mode){
 const versions={},warnings=[];
 for(const t of trades){
  if(!/^codex-[a-f0-9]{32}$/.test(t.enter_tag??''))continue;
  const entries=records.filter(r=>r.status==='pending'&&['buy','open-long','open-short'].includes(r.action)&&r.tag===t.enter_tag&&r.pair===t.pair);
  if(entries.length!==1)continue;
  const entry=entries[0];
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.snapshotId??''))continue;
  const expectedId=recordedEntryId(entry);
  if(entry.id!==expectedId||entry.tag!=='codex-'+expectedId||!Number.isFinite(Date.parse(entry.at)))continue;
  const file=join(local,'runs',entryArtifactStem(entry.snapshotId,entry.pair,entry.executionPolicyVersion)+'.version.json');
  if(!await exists(file))continue;
  try{
   const v=await readJson(file),{fingerprint,capturedAt,scope,...contract}=v;
   if(v.mode!==mode||v.schemaVersion!==1||!Number.isFinite(Date.parse(capturedAt))||Date.parse(capturedAt)>Date.parse(entry.at)
    ||fingerprint!==hash(JSON.stringify(canonical(contract))))throw Error('INVALID_VERSION_MANIFEST');
   versions[t.trade_id]=fingerprint;
  }catch{warnings.push({tradeId:t.trade_id,code:'VERSION_UNAVAILABLE_OR_INVALID'});}
 }
 return {versions,warnings};
}
