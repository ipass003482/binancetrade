import {copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson, writeJson, exists, lock, journalRead} from './io.mjs';
import {buildForwardTrialReport} from './forward-trial.mjs';
import {refreshProfitReview} from './profit-review-store.mjs';
import {loadVolumeExperiment,isVolumeVariant} from './volume-experiment.mjs';
import {buildVolumeReport} from './volume-report.mjs';

export const FORWARD_TRIAL_VERSION = 'kronos-direction-v12';
const KEV_FLOW_POLICY='kev-order-flow-v1';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const entryActions = new Set(['buy', 'open-long', 'open-short']);
const validMode = value => ['demo', 'demo-futures'].includes(value);
const validTag = value => typeof value === 'string' && /^codex-[a-f0-9]{32}$/.test(value);
const validId = value => Number.isSafeInteger(value) && value > 0
 || typeof value === 'string' && /^[1-9]\d*$/.test(value);
const file = local => join(local, 'forward-trial.json');
const locked = (local, fn) => lock(join(local, 'forward.lock'), fn);

function validateHistory(trades) {
 if (!Array.isArray(trades) || trades.some(t => !t || !validId(t.trade_id))
  || new Set(trades.map(t => String(t.trade_id))).size !== trades.length) throw Error('FORWARD_HISTORY_INVALID');
 return trades;
}
function validateTrial(trial, mode) {
 if (!trial || trial.version !== FORWARD_TRIAL_VERSION || !validMode(trial.mode)
  || (mode !== undefined && trial.mode !== mode) || trial.source !== 'freqtrade-demo'
  || typeof trial.historyComplete !== 'boolean') throw Error('FORWARD_TRIAL_IDENTITY_INVALID');
 // Reuse the pure report's manifest validation. No account data is invented.
 buildForwardTrialReport({trial, trades: [], journal: [], asOf: new Date().toISOString()});
 for (const key of ['strategyTags', 'probeTags'])
  if (!Array.isArray(trial[key]) || trial[key].some(tag => !validTag(tag))) throw Error('FORWARD_TRIAL_TAGS_INVALID');
 if (!Array.isArray(trial.excludedTradeIds)) throw Error('FORWARD_TRIAL_EXCLUSIONS_INVALID');
 if(trial.policyTags!==undefined){
  if(!trial.policyTags||typeof trial.policyTags!=='object'||Array.isArray(trial.policyTags))throw Error('FORWARD_POLICY_TAGS_INVALID');
  const seen=new Set();
  for(const [policy,tags] of Object.entries(trial.policyTags)){
   if(!/^[a-z0-9][a-z0-9/._-]{0,119}$/.test(policy)||!Array.isArray(tags)||tags.some(tag=>
    !validTag(tag)||!trial.strategyTags.includes(tag)||seen.has(tag)))throw Error('FORWARD_POLICY_TAGS_INVALID');
   for(const tag of tags){if(seen.has(tag))throw Error('FORWARD_POLICY_TAGS_INVALID');seen.add(tag);}
  }
 }
 return trial;
}
function kevAttributable(entry){
 const e=entry.entryEvidence,r=e?.kevReview,d=r?.decision,at=Date.parse(entry.at),
  completed=Date.parse(r?.completedAt),expiry=Date.parse(r?.expiresAt);
 return entry.status==='pending'&&entry.purpose==='strategy'&&entry.ruleVersion===KEV_FLOW_POLICY&&
  entry.entryPolicyVersion===KEV_FLOW_POLICY&&entry.entrySignalEngine==='kev_order_flow'&&entryActions.has(entry.action)&&
  typeof entry.pair==='string'&&entry.pair.length>0&&typeof entry.snapshotId==='string'&&entry.snapshotId.length>0&&
  e?.version==='kev-order-flow-evidence-v1'&&e.usedForEntryDecision===true&&e.snapshotId===entry.snapshotId&&hash(e.proofSha256)&&
  r?.version==='kev-codex-entry-v1'&&r.decisionMode==='autonomous'&&r.provider==='codex-cli'&&
  typeof r.model==='string'&&r.model.length>0&&typeof r.requestId==='string'&&r.requestId.length>0&&r.requestId.length<=100&&
  r.snapshotId===entry.snapshotId&&hash(r.snapshotSha256)&&hash(r.configSha256)&&hash(r.proofSha256)&&
  r.probabilitiesCalibrated===false&&d?.approved===true&&d.choice==='select'&&d.pair===entry.pair&&d.action===entry.action&&
  Number.isFinite(at)&&Number.isFinite(completed)&&Number.isFinite(expiry)&&at>=completed&&at<expiry&&expiry<=completed+60000;
}
function scopeOf(entry) {
 const {purpose,ruleVersion}=entry;
 // A partially labelled Kev record must not fall through to a legacy rule.
 if(ruleVersion===KEV_FLOW_POLICY||entry.entryPolicyVersion===KEV_FLOW_POLICY||entry.entrySignalEngine==='kev_order_flow'||
  entry.entryEvidence?.version==='kev-order-flow-evidence-v1')return kevAttributable(entry)?'strategyTags':null;
 if (purpose === 'execution_probe') return 'probeTags';
 if ((purpose === undefined || purpose === 'strategy') && (ruleVersion === FORWARD_TRIAL_VERSION||(isVolumeVariant(ruleVersion)&&ruleVersion.startsWith(FORWARD_TRIAL_VERSION+'/')))) return 'strategyTags';
 return null;
}
function attribute(trial, entry) {
 const scope = scopeOf(entry);
 if (!scope || !validTag(entry.tag)) throw Error('FORWARD_ENTRY_NOT_ATTRIBUTABLE');
 const other = scope === 'strategyTags' ? 'probeTags' : 'strategyTags';
 if (trial[other].includes(entry.tag)) throw Error('FORWARD_ENTRY_SCOPE_CONFLICT');
 if(scope==='strategyTags'){
  const policy=typeof entry.entryPolicyVersion==='string'&&/^[a-z0-9][a-z0-9/._-]{0,119}$/.test(entry.entryPolicyVersion)
   ?entry.entryPolicyVersion:entry.ruleVersion;
  const policyTags=trial.policyTags??{};
  if(Object.entries(policyTags).some(([key,tags])=>key!==policy&&tags.includes(entry.tag)))throw Error('FORWARD_ENTRY_POLICY_CONFLICT');
  const tags=policyTags[policy]??=[];if(!tags.includes(entry.tag))tags.push(entry.tag);
  trial.policyTags=policyTags;
 }
 if (!trial[scope].includes(entry.tag)) trial[scope].push(entry.tag);
}

function withPolicyCohorts(report,{trial,trades,journal,asOf}){
 const groups=new Map(Object.entries(trial.policyTags??{}).filter(([,tags])=>tags.length));
 const attributed=new Set([...groups.values()].flat()),unknown=trial.strategyTags.filter(tag=>!attributed.has(tag));
 if(unknown.length)groups.set('historical-unclassified',unknown);
 const cohorts=[];
 for(const [entryPolicyVersion,tags] of groups){
  const tagSet=new Set(tags),ids=new Set(journal.filter(row=>tagSet.has(row.tag)).map(row=>row.id));
  const cohort=buildForwardTrialReport({trial:{...trial,strategyTags:tags,probeTags:[]},
   trades:trades.filter(t=>tagSet.has(t.enter_tag)),journal:journal.filter(row=>ids.has(row.id)),asOf});
  cohorts.push({entryPolicyVersion,attributedTags:tags.length,strategy:cohort.strategy,validation:cohort.validation,warnings:cohort.warnings});
 }
 const mixedPolicies=cohorts.length>1;
 report.policyCohorts={version:'entry-policy-cohorts-v1',mixedPolicies,pooledSampleEligible:!mixedPolicies,cohorts};
 if(mixedPolicies){
  report.validation.preliminarySampleAvailable=false;
  report.validation.stableProfitabilityValidated=false;
  report.validation.profitabilityValidationComplete=false;
  report.validation.promotionAuthorized=false;
  report.validation.remainingClosedTrades=null;
  if(report.validation.evidenceComplete)report.validation.status='mixed_entry_policies';
  report.limitations.push('Strategy totals contain distinct entry policies. They are descriptive account totals only; use policyCohorts for each policy sample and never pool policies to meet a sample threshold or claim profitability. Historical tags without a policy record remain unclassified.');
 }
 return report;
}

// The caller supplies the entire identity-checked client.history() result,
// including open positions. These IDs remain excluded after they close.
export async function beginForwardTrial(local, mode, trades, metadata = {}) {
 if (!validMode(mode)) throw Error('FORWARD_DEMO_MODE_REQUIRED');
 validateHistory(trades);
 if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('FORWARD_METADATA_INVALID');
 return locked(local, async () => {
  const path = file(local);
  if (await exists(path)) {
   const previous = await readJson(path);
   if (previous?.version === FORWARD_TRIAL_VERSION) return validateTrial(previous, mode);
   if (previous?.mode !== undefined && previous.mode !== mode) throw Error('FORWARD_TRIAL_IDENTITY_INVALID');
   const version = String(previous?.version ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
   await copyFile(path, join(local, `forward-trial.${version}.${randomUUID()}.json`), constants.COPYFILE_EXCL);
   const reportPath=join(local,'forward-report.json');
   if(await exists(reportPath))await copyFile(reportPath,join(local,`forward-report.${version}.${randomUUID()}.json`),constants.COPYFILE_EXCL);
  }
  const startedAt = new Date().toISOString();
  const trial = {version: FORWARD_TRIAL_VERSION, mode, startedAt, source: 'freqtrade-demo', historyComplete: true,
   historyObservedAt: startedAt, baselineTradeCount: trades.length, excludedTradeIds: trades.map(t => t.trade_id),
   strategyTags: [], probeTags: [], metadata: structuredClone(metadata)};
  validateTrial(trial, mode);
  await writeJson(path, trial);
  return trial;
 });
}

export async function recordForwardEntry(local, entry) {
 return locked(local, async () => {
  const trial = validateTrial(await readJson(file(local)));
  attribute(trial, entry);
  await writeJson(file(local), trial);
  return trial;
 });
}

function recoverTags(trial, journal, asOf) {
 const start = Date.parse(trial.startedAt), end = Date.parse(asOf);
 for (const row of journal) {
  const at = Date.parse(row.at);
  if (row.status !== 'pending' || !entryActions.has(row.action) || at < start || at > end || !scopeOf(row)) continue;
  attribute(trial, row);
 }
}

async function storeReadFailure(local, trial, trades, journal, code) {
 const asOf = new Date().toISOString();
 let report;
 if (trial) {
  trial.historyComplete = false;
  trial.lastReadAttemptAt = asOf;
  trial.lastReadError = code;
  report = withPolicyCohorts(buildForwardTrialReport({trial, trades, journal, asOf}),{trial,trades,journal,asOf});
  report.warnings.push({code});
  await writeJson(file(local), trial);
 } else {
  // A missing/corrupt marker cannot safely be reconstructed from account
  // dates. Replace a stale success report with an explicit read failure.
  report = {schemaVersion: 1, source: 'freqtrade-demo-forward-trial', asOf,
   historyComplete: false, strategy: {pnlComplete: false, netRealizedUsdt: null},
   probes: {pnlComplete: false, netRealizedUsdt: null}, warnings: [{code}],
   validation: {status: 'incomplete_evidence', evidenceComplete: false,
    preliminarySampleAvailable: false, stableProfitabilityValidated: false,
    profitabilityValidationComplete: false, promotionAuthorized: false}};
 }
 await writeJson(join(local, 'forward-report.json'), report);
}

export async function refreshForwardReport(local, client) {
 return locked(local, async () => {
  let trial, trades = [], journal = [], stage = 'FORWARD_TRIAL_READ_FAILED';
  try {
   trial = validateTrial(await readJson(file(local)));
   stage = 'FORWARD_HISTORY_READ_FAILED';
   // FreqtradeClient.history() verifies Demo engine identity, reads every
   // closed-history page plus current positions, then rechecks the count.
   if (client.policy?.mode !== undefined && client.policy.mode !== trial.mode) throw Error('FORWARD_CLIENT_MODE_MISMATCH');
   trades = validateHistory(await client.history());
   stage = 'FORWARD_JOURNAL_READ_FAILED';
   journal = await journalRead(join(local, 'orders.jsonl'));
   const asOf = new Date().toISOString();
   stage = 'FORWARD_ATTRIBUTION_FAILED';
   recoverTags(trial, journal, asOf);
   trial.historyComplete = true;
   trial.historyObservedAt = asOf;
   trial.lastReadAttemptAt = asOf;
   delete trial.lastReadError;
   const report = withPolicyCohorts(buildForwardTrialReport({trial, trades, journal, asOf}),{trial,trades,journal,asOf});
   report.volumeComparison=buildVolumeReport({report,trades,journal,config:await loadVolumeExperiment(),asOf});
   if(journal.some(row=>row.status==='pending'&&isVolumeVariant(row.ruleVersion)&&trial.strategyTags.includes(row.tag))){
    report.validation.preliminarySampleAvailable=false;
    report.validation.status=report.validation.evidenceComplete?'parameter_comparison':report.validation.status;
    report.limitations.push('The v8 family total includes distinct volume variants; use volumeComparison arms and portfolio version cohorts for parameter conclusions. Do not pool variants to satisfy a sample threshold.');
   }
   try { report.profitReview = await refreshProfitReview(local, {report, trades}); }
   catch { report.profitReview = {status: 'unavailable', asOf, error: 'PROFIT_OBSERVATIONS_UNAVAILABLE', strategy: null, probes: null}; }
   stage = 'FORWARD_REPORT_WRITE_FAILED';
   await writeJson(file(local), trial);
   await writeJson(join(local, 'forward-report.json'), report);
   return report;
  } catch (error) {
   // No order submission or reconciliation belongs in this reporting layer.
   // Do not persist raw exception text, which may contain transport details.
   try { await storeReadFailure(local, trial, trades, journal, stage); }
   catch { /* Preserve the original failure for the workflow's reporting catch. */ }
   throw error;
  }
 });
}
