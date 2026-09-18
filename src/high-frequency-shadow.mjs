// AI-assisted high-frequency shadow research.  This module never submits an
// order: it records the candidate selected by the bounded observer and later
// measures public quote markouts after the observed round-trip cost scenario.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCAL } from './paths.mjs';
import { loadPolicy } from './config.mjs';
import { exists, readJson, writeJson } from './io.mjs';
import { loadHighFrequencyStrategy } from './high-frequency-strategy.mjs';
import { runHighFrequencyCycle } from './ai-high-frequency.mjs';

export const HIGH_FREQUENCY_SHADOW_VERSION = 'ai-high-frequency-shadow-v1';
const DEFAULT_HORIZON_MS = 60_000;
const MAX_COMPLETED = 2_000;
const MAX_PENDING = 256;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const numeric = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const isoMs = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const round = value => Number(Number(value).toFixed(6));

function initialState() {
  return {
    version: HIGH_FREQUENCY_SHADOW_VERSION,
    mode: 'dry-run',
    tradeEnabled: false,
    cycles: 0,
    aiReviews: 0,
    profile: 'auto',
    sensitivity: 'balanced',
    control: null,
    lastPair: null,
    pending: [],
    completed: [],
    unavailable: [],
    lastCycleAt: null,
    lastAiReviewAt: null
  };
}

function normalizeState(value) {
  const base = initialState();
  if (!value || value.version !== HIGH_FREQUENCY_SHADOW_VERSION || value.mode !== 'dry-run' || value.tradeEnabled !== false)
    return base;
  return {
    ...base,
    ...value,
    pending: Array.isArray(value.pending) ? value.pending : [],
    completed: Array.isArray(value.completed) ? value.completed.slice(-MAX_COMPLETED) : [],
    unavailable: Array.isArray(value.unavailable) ? value.unavailable.slice(-MAX_COMPLETED) : []
  };
}

function marketMap(snapshot) {
  return new Map((Array.isArray(snapshot?.markets) ? snapshot.markets : []).map(market => [market.pair, market]));
}

function markout(anchor, market, observedAt) {
  const futureBid = numeric(market?.quote?.bid);
  const anchorAsk = numeric(anchor.anchorAsk);
  const costBps = numeric(anchor.costBps);
  if (!(futureBid > 0) || !(anchorAsk > 0) || !(costBps >= 0)) return null;
  const rawBps = (futureBid / anchorAsk - 1) * 10_000;
  return {
    anchorId: anchor.id,
    pair: anchor.pair,
    profile: anchor.profile,
    sensitivity: anchor.sensitivity,
    snapshotId: anchor.snapshotId,
    anchorAt: anchor.anchorAt,
    observedAt,
    horizonMs: anchor.horizonMs,
    anchorAsk: String(anchor.anchorAsk),
    futureBid: String(market.quote.bid),
    costBps: String(anchor.costBps),
    rawMarkoutBps: round(rawBps),
    costAdjustedMarkoutBps: round(rawBps - costBps),
    status: 'complete',
    evidenceOnly: true,
    performanceEvidence: false
  };
}

function summarize(state, asOf) {
  const completed = state.completed.filter(row => row.status === 'complete' && finite(Number(row.costAdjustedMarkoutBps)));
  const mean = completed.length ? completed.reduce((sum, row) => sum + Number(row.costAdjustedMarkoutBps), 0) / completed.length : null;
  const positive = completed.filter(row => Number(row.costAdjustedMarkoutBps) > 0).length;
  const byProfile = {};
  for (const row of completed) {
    const key = row.profile ?? 'unknown';
    const group = byProfile[key] ?? { samples: 0, positive: 0, sumCostAdjustedMarkoutBps: 0 };
    group.samples += 1;
    group.positive += Number(row.costAdjustedMarkoutBps) > 0 ? 1 : 0;
    group.sumCostAdjustedMarkoutBps += Number(row.costAdjustedMarkoutBps);
    byProfile[key] = group;
  }
  for (const group of Object.values(byProfile)) {
    group.meanCostAdjustedMarkoutBps = round(group.sumCostAdjustedMarkoutBps / group.samples);
    group.positiveRate = round(group.positive / group.samples);
    delete group.sumCostAdjustedMarkoutBps;
  }
  return {
    version: HIGH_FREQUENCY_SHADOW_VERSION,
    mode: 'dry-run',
    tradeEnabled: false,
    asOf,
    cycles: state.cycles,
    aiReviews: state.aiReviews,
    activePending: state.pending.length,
    completedMarkouts: completed.length,
    unavailableMarkouts: state.unavailable.length,
    meanCostAdjustedMarkoutBps: mean === null ? null : round(mean),
    positiveCostAdjustedRate: completed.length ? round(positive / completed.length) : null,
    byProfile,
    evidence: {
      source: 'Binance public market data',
      costMeaning: 'Scenario estimate only; account commission is not read by this observer.',
      correlatedSamples: true,
      performanceEvidence: false,
      orderAuthority: 'none'
    }
  };
}

function reuseAnalysis(state) {
  return async snapshot => {
    // ProposalSchema still requires a pair for a hold proposal. Reusing the
    // last observed pair keeps the no-model cycle schema-valid without giving
    // the observer any order authority.
    const pair = typeof state.lastPair === 'string' ? state.lastPair : 'BTC/USDT';
    const control = {
      decision: 'hold',
      profile: state.profile,
      sensitivity: state.sensitivity,
      evidenceIds: [],
      reason: 'SHADOW_REUSE_LAST_AI_POLICY'
    };
    return {
      proposal: {
        action: 'hold',
        pair,
        stakeUsdt: '0',
        snapshotId: snapshot.id,
        evidenceIds: [],
        reason: control.reason,
        strategyControl: control
      },
      metadata: { purpose: 'high-frequency-cli', requestedModel: 'shadow-policy-reuse' },
      runDir: 'shadow-policy-reuse'
    };
  };
}

async function loadState(file) {
  try { return normalizeState(await readJson(file)); }
  catch (error) { if (error.code === 'ENOENT') return initialState(); throw error; }
}

export async function runHighFrequencyShadowCycle(options = {}) {
  const local = options.local ?? join(LOCAL, 'ai-high-frequency');
  await mkdir(local, { recursive: true });
  const statePath = join(local, 'shadow-state.json');
  const reportPath = join(local, 'shadow-report.json');
  const eventsPath = join(local, 'shadow-events.jsonl');
  const state = await loadState(statePath);
  const config = options.strategyConfig ?? await loadHighFrequencyStrategy();
  const aiEveryCycles = options.aiEveryCycles ?? config.shadow?.aiReviewEveryCycles ?? 5;
  if (!Number.isInteger(aiEveryCycles) || aiEveryCycles < 1 || aiEveryCycles > 100) throw new Error('HIGH_FREQUENCY_AI_CADENCE_INVALID');
  const horizonMs = options.horizonMs ?? (config.shadow?.horizonSeconds?.[0] ?? 60) * 1000;
  if (!Number.isInteger(horizonMs) || horizonMs < 15_000 || horizonMs > 3_600_000) throw new Error('HIGH_FREQUENCY_HORIZON_INVALID');
  const due = state.cycles === 0 || state.cycles % aiEveryCycles === 0;
  const cycleFn = options.cycleFn ?? runHighFrequencyCycle;
  const now = options.now ?? Date.now;
  const result = await cycleFn({
    local,
    policy: options.policy ?? await loadPolicy('dry-run'),
    strategyConfig: config,
    strategyProfile: state.profile,
    sensitivity: state.sensitivity,
    analyzeFn: due ? options.analyzeFn : reuseAnalysis(state),
    fetchImpl: options.fetchImpl,
    now,
    signal: options.signal,
    includeSnapshot: true
  });
  const snapshot = result.snapshot;
  if (!snapshot || result.tradeEnabled !== false || result.mode !== 'dry-run') throw new Error('HIGH_FREQUENCY_SHADOW_RESULT_INVALID');
  const asOf = snapshot.completedAt ?? new Date(now()).toISOString();
  const markets = marketMap(snapshot);
  const next = normalizeState(state);
  next.cycles += 1;
  next.lastCycleAt = asOf;
  if (due) {
    next.aiReviews += 1;
    next.lastAiReviewAt = asOf;
    const control = result.strategy?.aiControl;
    if (control?.decision === 'use' && ['auto', 'momentum', 'mean-reversion', 'breakout'].includes(control.profile)
      && ['conservative', 'balanced', 'aggressive'].includes(control.sensitivity)) {
      next.profile = control.profile;
      next.sensitivity = control.sensitivity;
      next.control = { decision: 'use', profile: control.profile, sensitivity: control.sensitivity, evidenceIds: control.evidenceIds ?? [], reason: control.reason ?? '' };
    } else {
      next.profile = 'auto';
      next.sensitivity = 'balanced';
      next.control = { decision: 'hold', profile: 'auto', sensitivity: 'balanced', reason: control?.reason ?? 'AI_CONTROL_HOLD' };
    }
  }

  const remaining = [];
  for (const anchor of next.pending) {
    const anchorAt = isoMs(anchor.anchorAt), elapsed = anchorAt === null ? null : Date.parse(asOf) - anchorAt;
    const market = markets.get(anchor.pair);
    if (elapsed !== null && elapsed >= anchor.horizonMs && market) {
      const outcome = markout(anchor, market, asOf);
      if (outcome) next.completed.push(outcome); else next.unavailable.push({ ...anchor, status: 'MARKOUT_DATA_INVALID', observedAt: asOf, evidenceOnly: true });
    } else if (elapsed !== null && elapsed >= anchor.horizonMs * 5) {
      next.unavailable.push({ ...anchor, status: 'MARKOUT_UNAVAILABLE', observedAt: asOf, evidenceOnly: true });
    } else remaining.push(anchor);
  }
  next.pending = remaining.slice(-MAX_PENDING);
  const selected = result.strategy?.applied ?? (next.control?.decision === 'use' ? result.strategy?.selected : null);
  if (selected?.pair && typeof selected.pair === 'string') next.lastPair = selected.pair;
  if (selected?.action === 'buy' && typeof selected.pair === 'string' && next.pending.length < (config.shadow?.maxPending ?? MAX_PENDING)) {
    const market = markets.get(selected.pair), anchorAsk = numeric(market?.quote?.ask), costBps = numeric(market?.cost?.estimatedRoundTripCostBps);
    if (market && anchorAsk > 0 && costBps >= 0) next.pending.push({
      id: `${snapshot.id}:${selected.pair}:${horizonMs}`,
      pair: selected.pair,
      profile: selected.profile,
      sensitivity: next.sensitivity,
      snapshotId: snapshot.id,
      anchorAt: snapshot.createdAt,
      anchorAsk: String(market.quote.ask),
      costBps: String(market.cost.estimatedRoundTripCostBps),
      horizonMs,
      evidenceIds: snapshot.evidence.filter(e => e.pair === selected.pair).map(e => e.id),
      evidenceOnly: true
    });
  }
  next.completed = next.completed.slice(-MAX_COMPLETED);
  next.unavailable = next.unavailable.slice(-MAX_COMPLETED);
  const report = summarize(next, asOf);
  await appendFile(eventsPath, JSON.stringify({ at: asOf, cycle: next.cycles, aiReview: due, selected: selected?.pair ?? null, completed: report.completedMarkouts, meanCostAdjustedMarkoutBps: report.meanCostAdjustedMarkoutBps }) + '\n');
  await writeJson(statePath, next);
  await writeJson(reportPath, report);
  return { ...report, snapshotId: snapshot.id, selected: selected ? { pair: selected.pair, profile: selected.profile, regime: selected.regime } : null, result };
}

export async function runHighFrequencyShadow({ cycles = 1, intervalSeconds = 60, aiEveryCycles, ...options } = {}) {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1_000_000) throw new Error('HIGH_FREQUENCY_SHADOW_CYCLES_INVALID');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 3_600) throw new Error('HIGH_FREQUENCY_SHADOW_INTERVAL_INVALID');
  const local = options.local ?? join(LOCAL, 'ai-high-frequency');
  const stopFile = options.stopFile ?? join(local, 'STOP');
  const workerFile = join(local, 'worker.json');
  await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid, status: 'running', startedAt: new Date().toISOString(), tradeEnabled: false });
  const results = [];
  try {
    for (let index = 0; index < cycles; index++) {
      if (await exists(stopFile)) break;
      results.push(await runHighFrequencyShadowCycle({ ...options, local, aiEveryCycles }));
      if (index + 1 < cycles) await delay(intervalSeconds * 1000);
    }
    await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid, status: 'stopped', stoppedAt: new Date().toISOString(), cycles: results.length, tradeEnabled: false });
    return { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', tradeEnabled: false, cycles: results };
  } catch (error) {
    await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid, status: 'error', stoppedAt: new Date().toISOString(), cycles: results.length, error: String(error.message ?? error), tradeEnabled: false });
    throw error;
  }
}
