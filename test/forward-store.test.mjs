import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginForwardTrial, recordForwardEntry, refreshForwardReport, FORWARD_TRIAL_VERSION} from '../src/forward-store.mjs';
import {readJson, journalAppend, exists} from '../src/io.mjs';

const directory = () => mkdtemp(join(tmpdir(), 'binancetrade-forward-store-'));
const id = n => n.toString(16).padStart(32, '0');
const tag = n => 'codex-' + id(n);
const trade = (n, at, extra = {}) => ({trade_id: n, pair: 'ETH/USDT', is_short: false, is_open: false,
 enter_tag: tag(n), open_timestamp: at, close_timestamp: at, profit_abs: '-.1', stake_amount: 25, leverage: 1, ...extra});
async function appendEntry(local, value, extra = {}) {
 const pending = {id: id(value.trade_id), at: new Date(value.open_timestamp).toISOString(), status: 'pending',
  action: value.is_short ? 'open-short' : 'buy', pair: value.pair, tag: value.enter_tag,
  purpose: 'strategy', ruleVersion: FORWARD_TRIAL_VERSION, ...extra};
 await journalAppend(join(local, 'orders.jsonl'), pending);
 await journalAppend(join(local, 'orders.jsonl'), {id: pending.id, at: pending.at, status: 'submitted', tradeId: value.trade_id});
}

test('baseline excludes complete supplied history and repeated starts keep the same trial', async () => {
 const local = await directory(), old = trade(1, Date.now() - 1000), open = trade(2, Date.now() - 1000, {is_open: true});
 const first = await beginForwardTrial(local, 'demo', [old, open], {timeframe: '5m', version: 'cannot-override'});
 assert.equal(first.version, FORWARD_TRIAL_VERSION);
 assert.equal(FORWARD_TRIAL_VERSION, 'kronos-direction-v12');
 assert.equal(first.historyComplete, true);
 assert.deepEqual(first.excludedTradeIds, [1, 2]);
 assert.deepEqual(first.strategyTags, []);
 const second = await beginForwardTrial(local, 'demo', [old, open, trade(3, Date.now())], {timeframe: '1m'});
 assert.deepEqual(second, first);
 assert.equal(second.metadata.timeframe, '5m');
 assert.equal((await readdir(local)).some(name => name === 'forward.lock'), false);
});

test('version change preserves the exact old marker as a versioned backup', async () => {
 const local = await directory(), old = '{"version":"atr15m-risk-v4","mode":"demo","note":"keep this exact version"}\n';
 await writeFile(join(local, 'forward-trial.json'), old);
 const current = await beginForwardTrial(local, 'demo', [trade(1, Date.now() - 1)]);
 const backups = (await readdir(local)).filter(name => name.startsWith('forward-trial.atr15m-risk-v4.'));
 assert.equal(backups.length, 1);
 assert.equal(await readFile(join(local, backups[0]), 'utf8'), old);
 assert.equal(current.version, FORWARD_TRIAL_VERSION);
});

test('v12 archives the exact v11 trial and report while excluding its closed and still-open trades', async () => {
 const local=await directory(),oldClosed=trade(1,Date.now()-10000,{profit_abs:'-7.5'}),
  oldOpen=trade(2,Date.now()-5000,{is_open:true,close_timestamp:null,profit_abs:'-.3'});
 const marker=JSON.stringify({version:'kronos-forward-v11',mode:'demo',startedAt:'2026-09-14T02:58:25.478Z',
  strategyTags:[tag(1),tag(2)],note:'Do not reset the historical trial or losses.'},null,2)+'\n';
 const oldReport='{"version":"kronos-forward-v11","strategy":{"netRealizedUsdt":"-7.5"}}\n';
 await writeFile(join(local,'forward-trial.json'),marker);
 await writeFile(join(local,'forward-report.json'),oldReport);
 const current=await beginForwardTrial(local,'demo',[oldClosed,oldOpen]);
 const names=await readdir(local),markers=names.filter(n=>n.startsWith('forward-trial.kronos-forward-v11.')),
  reports=names.filter(n=>n.startsWith('forward-report.kronos-forward-v11.'));
 assert.equal(markers.length,1);assert.equal(reports.length,1);
 assert.equal(await readFile(join(local,markers[0]),'utf8'),marker);
 assert.equal(await readFile(join(local,reports[0]),'utf8'),oldReport);
 assert.deepEqual(current.excludedTradeIds,[1,2]);assert.deepEqual(current.strategyTags,[]);
 assert.equal(current.version,'kronos-direction-v12');
 await assert.rejects(recordForwardEntry(local,{tag:tag(3),purpose:'strategy',ruleVersion:'kronos-forward-v11'}),/NOT_ATTRIBUTABLE/);
 await beginForwardTrial(local,'demo',[oldClosed,oldOpen]);
 assert.equal((await readdir(local)).filter(n=>n.startsWith('forward-trial.kronos-forward-v11.')).length,1);
});

test('invalid baseline or mode is rejected without asserting complete history', async () => {
 const local = await directory();
 for (const rows of [null, {}, [{trade_id: null}], [{trade_id: 1}, {trade_id: '1'}]])
  await assert.rejects(beginForwardTrial(local, 'demo', rows), /FORWARD_HISTORY_INVALID/);
 await assert.rejects(beginForwardTrial(local, 'live', []), /FORWARD_DEMO_MODE_REQUIRED/);
 assert.equal(await exists(join(local, 'forward-trial.json')), false);
 await beginForwardTrial(local, 'demo', []);
 await assert.rejects(beginForwardTrial(local, 'demo-futures', []), /FORWARD_TRIAL_IDENTITY_INVALID/);
});

test('explicit exact-tag attribution is idempotent and rejects mixed purpose or legacy strategy', async () => {
 const local = await directory(); await beginForwardTrial(local, 'demo', []);
 const entry = {tag: tag(1), purpose: 'strategy', ruleVersion: FORWARD_TRIAL_VERSION};
 await recordForwardEntry(local, entry);
 await recordForwardEntry(local, entry);
 await recordForwardEntry(local, {tag: tag(2), purpose: 'execution_probe', ruleVersion: 'demo-execution-probe-v1'});
 await assert.rejects(recordForwardEntry(local, {...entry, purpose: 'execution_probe'}), /SCOPE_CONFLICT/);
 await assert.rejects(recordForwardEntry(local, {...entry, tag: tag(3), ruleVersion: 'atr15m-risk-v4'}), /NOT_ATTRIBUTABLE/);
 await assert.rejects(recordForwardEntry(local, {...entry, tag: 'prefix-only'}), /NOT_ATTRIBUTABLE/);
 const saved = await readJson(join(local, 'forward-trial.json'));
 assert.deepEqual(saved.strategyTags, [tag(1)]); assert.deepEqual(saved.probeTags, [tag(2)]);
});

test('refresh recovers matching pending intents and keeps actual probe PnL separate', async () => {
 const local = await directory(), old = trade(1, Date.now() - 1000);
 const trial = await beginForwardTrial(local, 'demo', [old]), at = Date.parse(trial.startedAt);
 const strategy = trade(2, at, {profit_abs: '-.2'}), probe = trade(3, at, {profit_abs: '100'}), legacy = trade(4, at, {profit_abs: '999'});
 await appendEntry(local, strategy);
 await appendEntry(local, probe, {purpose: 'execution_probe', ruleVersion: 'demo-execution-probe-v1'});
 await appendEntry(local, legacy, {ruleVersion: 'atr15m-risk-v4'});
 let calls = 0;
 const report = await refreshForwardReport(local, {policy: {mode: 'demo'}, history: async () => {calls++; return [old, strategy, probe, legacy];}});
 assert.equal(calls, 1);
 assert.equal(report.strategy.closedTrades, 1); assert.equal(report.strategy.netRealizedUsdt, '-0.2');
 assert.equal(report.probes.closedTrades, 1); assert.equal(report.probes.netRealizedUsdt, '100');
 assert.ok(report.ignored.some(row => row.tradeId === 1 && row.reason === 'explicitly_excluded'));
 assert.ok(report.ignored.some(row => row.tradeId === 4 && row.reason === 'unattributed_entry_tag'));
 assert.equal(report.validation.evidenceComplete, false);
 const saved = await readJson(join(local, 'forward-trial.json'));
 assert.deepEqual(saved.strategyTags, [tag(2)]); assert.deepEqual(saved.probeTags, [tag(3)]);
 assert.equal(saved.historyComplete, true);
 assert.deepEqual(await readJson(join(local, 'forward-report.json')), report);
});

test('profit observations are refreshed with actual forward trades; a broken observation log cannot masquerade as a peak', async () => {
 const local = await directory(), trial = await beginForwardTrial(local, 'demo', []), at = Date.parse(trial.startedAt);
 const current = trade(1, at, {is_open: true, close_timestamp: null, profit_abs: '.25'});
 await appendEntry(local, current);
 const client = {history: async () => [current]};
 const report = await refreshForwardReport(local, client);
 assert.equal(report.profitReview.status, 'observed');
 assert.equal(report.profitReview.strategy.trades[0].sampledPeakNetUsdt, '0.25');
 const file = join(local, 'profit-observations.jsonl');
 await writeFile(file, '{broken');
 const broken = await refreshForwardReport(local, client);
 assert.equal(broken.validation.evidenceComplete, true);
 assert.equal(broken.profitReview.status, 'unavailable');
 assert.equal(broken.profitReview.strategy, null);
 assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('pre-trial and versionless legacy pending records do not gain strategy attribution', async () => {
 const local = await directory(), trial = await beginForwardTrial(local, 'demo', []), start = Date.parse(trial.startedAt);
 await appendEntry(local, trade(1, start - 1));
 await appendEntry(local, trade(2, start), {ruleVersion: undefined});
 await refreshForwardReport(local, {history: async () => [trade(1, start - 1), trade(2, start)]});
 const saved = await readJson(join(local, 'forward-trial.json'));
 assert.deepEqual(saved.strategyTags, []);
});

test('history failure clears completeness without exposing error text, and successful refresh recovers', async () => {
 const local = await directory(); await beginForwardTrial(local, 'demo', []);
 await refreshForwardReport(local, {history: async () => []});
 await assert.rejects(refreshForwardReport(local, {history: async () => {throw Error('RAW_SECRET_TRANSPORT_DETAIL');}}), /RAW_SECRET/);
 const failed = await readJson(join(local, 'forward-report.json'));
 assert.equal(failed.validation.status, 'incomplete_evidence');
 assert.equal(failed.strategy.netRealizedUsdt, null);
 assert.equal(JSON.stringify(failed).includes('RAW_SECRET'), false);
 assert.equal((await readJson(join(local, 'forward-trial.json'))).historyComplete, false);
 const recovered = await refreshForwardReport(local, {history: async () => []});
 assert.equal(recovered.validation.evidenceComplete, true);
 assert.equal((await readJson(join(local, 'forward-trial.json'))).historyComplete, true);
});

test('torn journal and invalid history cannot reuse a complete report', async () => {
 const local = await directory(); await beginForwardTrial(local, 'demo', []);
 await writeFile(join(local, 'orders.jsonl'), '{"partial":');
 await assert.rejects(refreshForwardReport(local, {history: async () => []}), /JOURNAL_INCOMPLETE/);
 assert.equal((await readJson(join(local, 'forward-report.json'))).validation.evidenceComplete, false);
 await writeFile(join(local, 'orders.jsonl'), '');
 await assert.rejects(refreshForwardReport(local, {history: async () => [{trade_id: 1}, {trade_id: 1}]}), /FORWARD_HISTORY_INVALID/);
 assert.equal((await readJson(join(local, 'forward-trial.json'))).historyComplete, false);
});

test('pending or unknown submissions stay unresolved and report refresh never settles them', async () => {
 const local = await directory(), trial = await beginForwardTrial(local, 'demo', []), t = trade(1, Date.parse(trial.startedAt));
 await appendEntry(local, t);
 await journalAppend(join(local, 'orders.jsonl'), {id: id(1), at: trial.startedAt, status: 'unknown'});
 const before = await readFile(join(local, 'orders.jsonl'), 'utf8');
 const result = await refreshForwardReport(local, {history: async () => [t]});
 assert.equal(result.journal.unresolvedSubmissions.length, 1);
 assert.equal(result.validation.evidenceComplete, false);
 assert.equal(await readFile(join(local, 'orders.jsonl'), 'utf8'), before);
});

test('forward lock prevents concurrent marker updates without losing recorded tags', async () => {
 const local = await directory(); await beginForwardTrial(local, 'demo', []);
 let entered, release;
 const started = new Promise(resolve => {entered = resolve;});
 const wait = new Promise(resolve => {release = resolve;});
 const refreshing = refreshForwardReport(local, {history: async () => {entered(); await wait; return [];}});
 await started;
 await assert.rejects(recordForwardEntry(local, {tag: tag(1), ruleVersion: FORWARD_TRIAL_VERSION}), /BUSY_OR_STALE_LOCK/);
 release(); await refreshing;
 await recordForwardEntry(local, {tag: tag(1), ruleVersion: FORWARD_TRIAL_VERSION});
 assert.deepEqual((await readJson(join(local, 'forward-trial.json'))).strategyTags, [tag(1)]);
});

test('corrupt marker invalidates a previous complete report without guessing a replacement trial', async () => {
 const local = await directory(); await beginForwardTrial(local, 'demo', []);
 await refreshForwardReport(local, {history: async () => []});
 await writeFile(join(local, 'forward-trial.json'), '{broken');
 let calls = 0;
 await assert.rejects(refreshForwardReport(local, {history: async () => {calls++; return [];}}));
 assert.equal(calls, 0);
 const result = await readJson(join(local, 'forward-report.json'));
 assert.equal(result.historyComplete, false); assert.equal(result.validation.evidenceComplete, false);
 assert.equal(await readFile(join(local, 'forward-trial.json'), 'utf8'), '{broken');
});

function kevEntry(n,at,extra={}){
 const snapshotId='00000000-0000-4000-8000-'+String(n).padStart(12,'0');
 return {id:id(n),tag:tag(n),at:new Date(at).toISOString(),status:'pending',purpose:'strategy',
  ruleVersion:'kev-order-flow-v1',entryPolicyVersion:'kev-order-flow-v1',entrySignalEngine:'kev_order_flow',
  pair:'ETH/USDT',action:'buy',snapshotId,
  entryEvidence:{version:'kev-order-flow-evidence-v1',snapshotId,usedForEntryDecision:true,proofSha256:'a'.repeat(64),
   kevReview:{version:'kev-codex-entry-v1',decisionMode:'autonomous',provider:'codex-cli',model:'gpt-6-astra',
    requestId:'synthetic-'+n,snapshotId,snapshotSha256:'b'.repeat(64),configSha256:'c'.repeat(64),proofSha256:'d'.repeat(64),
    completedAt:new Date(at-1000).toISOString(),expiresAt:new Date(at+59000).toISOString(),probabilitiesCalibrated:false,
    decision:{pair:'ETH/USDT',action:'buy',approved:true,choice:'select'}}},...extra};
}

test('Kev attribution requires its exact reviewed pending intent and preserves the existing trial identity',async()=>{
 const local=await directory(),old=trade(1,Date.now()-1000),first=await beginForwardTrial(local,'demo',[old]);
 const at=Date.parse(first.startedAt),entry=kevEntry(2,at);
 await recordForwardEntry(local,entry);await recordForwardEntry(local,entry);
 const saved=await readJson(join(local,'forward-trial.json'));
 assert.equal(saved.version,first.version);assert.equal(saved.startedAt,first.startedAt);
 assert.deepEqual(saved.excludedTradeIds,first.excludedTradeIds);assert.deepEqual(saved.strategyTags,[tag(2)]);
 assert.deepEqual(saved.policyTags,{'kev-order-flow-v1':[tag(2)]});
 await appendEntry(local,trade(2,at,{profit_abs:'.4'}),entry);
 const report=await refreshForwardReport(local,{history:async()=>[old,trade(2,at,{profit_abs:'.4'})]});
 assert.equal(report.strategy.closedTrades,1);assert.equal(report.strategy.netRealizedUsdt,'0.4');
 assert.equal(report.policyCohorts.mixedPolicies,false);
 assert.equal(report.policyCohorts.cohorts[0].entryPolicyVersion,'kev-order-flow-v1');
 assert.equal(report.policyCohorts.cohorts[0].strategy.closedTrades,1);
 assert.equal(report.policyCohorts.cohorts[0].validation.preliminarySampleAvailable,false);
});

test('missing, expired or mismatched Kev receipts stay unattributed and cannot fall through to legacy rules',async()=>{
 const local=await directory(),trial=await beginForwardTrial(local,'demo',[]),at=Date.parse(trial.startedAt);
 const changes=[e=>delete e.entryEvidence.kevReview,e=>e.entryEvidence.snapshotId='other',
  e=>e.entryEvidence.proofSha256='bad',e=>e.entryEvidence.kevReview.proofSha256='bad',
  e=>e.entryEvidence.kevReview.snapshotSha256='bad',e=>e.entryEvidence.kevReview.configSha256='bad',
  e=>e.entryEvidence.kevReview.snapshotId='other',e=>e.entryEvidence.kevReview.decision.approved=false,
  e=>e.entryEvidence.kevReview.decision.pair='BTC/USDT',e=>e.entryEvidence.kevReview.decision.action='open-short',
  e=>e.entryEvidence.kevReview.expiresAt=e.at,e=>e.purpose=undefined,e=>e.status='submitted',
  e=>e.entryPolicyVersion='order-flow-only-v1',e=>e.entrySignalEngine='sampled_order_flow',
  e=>e.ruleVersion=FORWARD_TRIAL_VERSION];
 const trades=[];
 for(const [i,change] of changes.entries()){
  const entry=kevEntry(i+1,at);change(entry);
  await assert.rejects(recordForwardEntry(local,entry),/NOT_ATTRIBUTABLE/);
  const t=trade(i+1,at);trades.push(t);await appendEntry(local,t,entry);
 }
 const report=await refreshForwardReport(local,{history:async()=>trades});
 assert.equal(report.strategy.closedTrades,0);assert.equal(report.policyCohorts.cohorts.length,0);
 assert.equal(report.ignored.filter(row=>row.reason==='unattributed_entry_tag').length,changes.length);
 assert.equal(report.validation.evidenceComplete,false);
 assert.deepEqual((await readJson(join(local,'forward-trial.json'))).strategyTags,[]);
});

test('mixed Kronos and Kev totals never pool to qualify a preliminary sample and retain distinct policy cohorts',async()=>{
 const local=await directory(),trial=await beginForwardTrial(local,'demo',[]),at=Date.parse(trial.startedAt),trades=[];
 for(let n=1;n<=30;n++){
  const t=trade(n,at,{profit_abs:'.1'});trades.push(t);await appendEntry(local,t);
 }
 const kev=trade(31,at,{profit_abs:'-.2'});trades.push(kev);await appendEntry(local,kev,kevEntry(31,at));
 const report=await refreshForwardReport(local,{history:async()=>trades});
 assert.equal(report.strategy.closedTrades,31);assert.equal(report.strategy.netRealizedUsdt,'2.8');
 assert.equal(report.validation.evidenceComplete,true);assert.equal(report.validation.status,'mixed_entry_policies');
 assert.equal(report.validation.preliminarySampleAvailable,false);assert.equal(report.validation.remainingClosedTrades,null);
 assert.equal(report.validation.stableProfitabilityValidated,false);assert.equal(report.policyCohorts.pooledSampleEligible,false);
 const cohorts=new Map(report.policyCohorts.cohorts.map(c=>[c.entryPolicyVersion,c]));
 assert.equal(cohorts.get(FORWARD_TRIAL_VERSION).strategy.closedTrades,30);
 assert.equal(cohorts.get(FORWARD_TRIAL_VERSION).validation.preliminarySampleAvailable,true);
 assert.equal(cohorts.get('kev-order-flow-v1').strategy.closedTrades,1);
 assert.equal(cohorts.get('kev-order-flow-v1').validation.preliminarySampleAvailable,false);
 const saved=await readJson(join(local,'forward-trial.json'));
 assert.equal(saved.startedAt,trial.startedAt);assert.equal(saved.strategyTags.length,31);
 await assert.rejects(recordForwardEntry(local,kevEntry(1,at)),/POLICY_CONFLICT/);
});
