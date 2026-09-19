// Controlled Demo reporting reset. It changes the reporting scope and goal only;
// it never deletes exchange history, journals, native protection evidence, or
// engine state. Entry watchers must already be paused and the accounts flat.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { ROOT } from '../src/paths.mjs';
import { modeLocal } from '../src/mode.mjs';
import { loadPolicy } from '../src/config.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { readJson, writeJson, exists } from '../src/io.mjs';
import { validateDemoSession } from '../src/demo-session.mjs';

const MODES = ['demo', 'demo-futures'];
const resetAt = new Date().toISOString();
const session = validateDemoSession({
  schemaVersion: 1,
  id: randomUUID(),
  startedAt: resetAt,
  modes: MODES,
});
const goalId = `2026-09-18-demo-100-reset-${resetAt.replace(/[-:TZ.]/g, '').slice(0, 14)}`;
const goalPath = `local/trade-goals/${goalId}/goal.json`;
const archiveDir = join(ROOT, 'local', 'demo-reset-2026-09-18', goalId);
const deadline = new Date(Date.parse(resetAt) + 24 * 60 * 60 * 1000).toISOString();

const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const compactHistory = history => history.map(t => ({
  trade_id: t.trade_id,
  pair: t.pair,
  is_open: t.is_open,
  is_short: t.is_short === true,
  open_timestamp: t.open_timestamp,
  close_timestamp: t.close_timestamp ?? null,
  profit_abs: t.profit_abs ?? null,
  enter_tag: t.enter_tag ?? null,
}));
const hashFile = async path => {
  try {
    const raw = await readFile(path);
    const info = await stat(path);
    return { path: relative(ROOT, path).replaceAll('\\', '/'), bytes: info.size, sha256: sha256(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: relative(ROOT, path).replaceAll('\\', '/'), present: false };
    throw error;
  }
};

for (const role of MODES) assert.equal(await exists(join(ROOT, 'local', role, 'STOP')), true, 'ENTRIES_NOT_PAUSED');
assert.equal(await exists(join(ROOT, 'local', 'supervisor', 'STOP')), true, 'SUPERVISOR_NOT_PAUSED');
for (const lock of [
  join(ROOT, 'local', 'demo', 'watch.lock'),
  join(ROOT, 'local', 'demo-futures', 'watch.lock'),
  join(ROOT, 'local', 'supervisor', 'supervisor.lock'),
]) assert.equal(await exists(lock), false, `WRITER_LOCK_PRESENT:${relative(ROOT, lock)}`);

const previousSession = await readJson(join(ROOT, 'local', 'demo-session.json'));
const previousActive = await readJson(join(ROOT, 'local', 'trade-goals', 'active.json'));
let previousGoal = null;
try { previousGoal = await readJson(resolve(ROOT, previousActive.goalPath)); } catch { /* archive the pointer even if its old goal is unavailable */ }
const histories = {};
const modeFacts = {};
for (const mode of MODES) {
  const local = modeLocal(mode);
  const client = new FreqtradeClient(await loadPolicy(mode), await readJson(join(local, 'api-auth.json')));
  const history = await client.history();
  assert.equal(history.filter(t => t.is_open === true).length, 0, `OPEN_POSITION:${mode}`);
  histories[mode] = history;
  const realized = history.reduce((sum, t) => {
    try { return sum.plus(new Decimal(t.profit_abs ?? 0)); } catch { return sum; }
  }, new Decimal(0));
  modeFacts[mode] = {
    historyCount: history.length,
    openCount: 0,
    excludedTradeIds: history.map(t => t.trade_id).sort((a, b) => a - b),
    priorAllHistoryRealizedUsdt: realized.toFixed(),
  };
}

const logNames = [
  'orders.jsonl', 'events.jsonl', 'equity.jsonl', 'equity-summary.json',
  'forward-report.json', 'forward-trial.json', 'native-orders.jsonl',
  'profit-observations.jsonl', 'order-flow.json', 'protection-readiness.json',
  'health.json', 'continuous.json', 'decision-schedule.json', 'candle-schedule.json',
];
const logManifest = {};
for (const mode of MODES) {
  logManifest[mode] = [];
  for (const name of logNames) logManifest[mode].push(await hashFile(join(modeLocal(mode), name)));
}

const oldSummary = {
  observedAt: resetAt,
  previousSession,
  previousActive,
  previousGoal,
  modeFacts,
  history: Object.fromEntries(MODES.map(mode => [mode, compactHistory(histories[mode])])),
  logManifest,
  preservation: 'Raw exchange/journal/evidence files remain at their original paths; this archive is the before-reset fingerprint and history snapshot.',
};
await writeJson(join(archiveDir, 'pre-reset.json'), oldSummary);

const goal = {
  schemaVersion: 2,
  id: goalId,
  source: 'freqtrade-demo',
  sessionId: session.id,
  startedAt: session.startedAt,
  deadline,
  timezone: 'Asia/Taipei',
  ruleVersion: 'kronos-direction-v12',
  entryPolicyVersion: 'order-flow-only-v1',
  modelFingerprint: null,
  modelAssist: {
    version: 'futures-kronos-flow-v1',
    mode: 'demo-futures',
    role: 'advisory direction veto',
    model: 'kronos-small-pretrained-v1',
    modelFingerprint: (await readJson(join(ROOT, 'config', 'model-execution.json'))).modelFingerprint,
    usedForEntryDecision: true,
    note: 'Only futures entries in this goal use the pinned forecast as a direction veto. Spot remains order-flow-only; native flow, cost, risk and protection remain authoritative.'
  },
  target: { scope: 'combined', count: 100 },
  modes: Object.fromEntries(MODES.map(mode => [mode, {
    excludedTradeIds: modeFacts[mode].excludedTradeIds,
    baselineTradeCount: modeFacts[mode].excludedTradeIds.length,
  }])),
  reset: {
    type: 'reporting-scope-reset',
    archive: `local/demo-reset-2026-09-18/${goalId}/pre-reset.json`,
    oldRecordsDeleted: false,
    newEntriesOnly: true,
    countDefinition: 'Actual strategy entry fills after startedAt; one trade_id counts once.',
  },
};
await writeJson(join(ROOT, goalPath), goal);
await writeJson(join(ROOT, 'local', 'trade-goals', 'active.json'), {
  sessionId: session.id,
  goalId,
  goalPath,
});
await writeJson(join(archiveDir, 'session.json'), session);
await writeJson(join(archiveDir, 'goal.json'), goal);
await writeJson(join(archiveDir, 'reset-status.json'), {
  schemaVersion: 1,
  state: 'reporting_scope_reset',
  phase: 'entries_paused',
  observedAt: new Date().toISOString(),
  session,
  goalPath,
  target: goal.target,
  modeFacts,
  flatVerified: true,
  nativeProtectionUntouched: true,
  rawLogsPreserved: true,
});
console.log(JSON.stringify({
  reset: true,
  session,
  goal: { id: goal.id, path: goalPath, target: goal.target, deadline: goal.deadline },
  modes: modeFacts,
  archive: relative(ROOT, join(archiveDir, 'pre-reset.json')).replaceAll('\\', '/'),
  rawLogsPreserved: true,
}, null, 2));
