// AI-assisted high-frequency shadow research.  This module never submits an
// order: it records the candidate selected by the bounded observer and later
// measures executable public quote markouts and a separate extra-slippage
// scenario. Account commissions are unknown, so neither is net trading PnL.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCAL } from './paths.mjs';
import { loadPolicy } from './config.mjs';
import { exists, writeJson, lock } from './io.mjs';
import { loadHighFrequencyStrategy } from './high-frequency-strategy.mjs';
import { runHighFrequencyCycle } from './ai-high-frequency.mjs';
import { collectPublicShadowQuote, resolvePublicShadowQuote, createShadowQuoteResolver, shadowAnchorWindow,
  SHADOW_QUOTE_SOURCE, SHADOW_RESOLVER_VERSION, SHADOW_QUOTE_TOLERANCE_MS } from './shadow-quote-resolver.mjs';

export const HIGH_FREQUENCY_SHADOW_VERSION = 'ai-high-frequency-shadow-v2';
export const SHADOW_LABEL_VERSION = 'executable-quote-markout-v2';
export const SHADOW_HORIZON_TOLERANCE_MS = SHADOW_QUOTE_TOLERANCE_MS;
const LEGACY_VERSION = 'ai-high-frequency-shadow-v1';
const MAX_COMPLETED = 2_000;
const MAX_PENDING = 256;
const MAX_RECENT_CYCLES = 32;
const writers = new Map();

const finite = value => typeof value === 'number' && Number.isFinite(value);
const numeric = value => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const isoMs = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const round = value => Number(Number(value).toFixed(6));
const quote = market => {
  const bid = numeric(market?.quote?.bid), ask = numeric(market?.quote?.ask), at = isoMs(market?.quote?.observedAt);
  return bid > 0 && ask >= bid && at !== null ? { bid, ask, at } : null;
};

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
    legacyCohorts: [],
    lastCycleAt: null,
    lastAiReviewAt: null
  };
}

function normalizeState(value) {
  const base = initialState();
  if (!value || value.version !== HIGH_FREQUENCY_SHADOW_VERSION || value.mode !== 'dry-run' || value.tradeEnabled !== false
    || !Number.isSafeInteger(value.cycles) || value.cycles < 0 || !Number.isSafeInteger(value.aiReviews) || value.aiReviews < 0
    || !['pending', 'completed', 'unavailable', 'legacyCohorts'].every(key => Array.isArray(value[key])))
    throw new Error('HIGH_FREQUENCY_SHADOW_STATE_INVALID');
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

function markout(anchor, market, recordedAt) {
  const future = quote(market);
  const anchorAsk = numeric(anchor.anchorAsk);
  const slippageBps = numeric(anchor.additionalSlippageBps), anchorAt = isoMs(anchor.anchorAt);
  const elapsed = future && anchorAt !== null ? future.at - anchorAt : null;
  if (anchor.labelVersion !== SHADOW_LABEL_VERSION || anchor.observationMethod !== SHADOW_RESOLVER_VERSION
    || !future || !(anchorAsk > 0) || slippageBps === null || slippageBps < 0 || elapsed === null || elapsed < anchor.horizonMs
    || elapsed > anchor.horizonMs + SHADOW_HORIZON_TOLERANCE_MS || future.at > isoMs(recordedAt)) return null;
  const rawBps = (future.bid / anchorAsk - 1) * 10_000;
  if (!Number.isFinite(rawBps)) return null;
  return {
    labelVersion: SHADOW_LABEL_VERSION,
    observationMethod: anchor.observationMethod ?? null,
    anchorId: anchor.id,
    pair: anchor.pair,
    profile: anchor.profile,
    sensitivity: anchor.sensitivity,
    snapshotId: anchor.snapshotId,
    anchorAt: anchor.anchorAt,
    decisionAt: anchor.decisionAt ?? null,
    sourceSnapshotAt: anchor.sourceSnapshotAt ?? null,
    observedAt: new Date(future.at).toISOString(),
    recordedAt,
    horizonMs: anchor.horizonMs,
    horizonToleranceMs: SHADOW_HORIZON_TOLERANCE_MS,
    actualElapsedMs: elapsed,
    anchorAsk: String(anchor.anchorAsk),
    futureBid: String(market.quote.bid),
    additionalSlippageBps: String(slippageBps),
    executableQuoteMarkoutBps: round(rawBps),
    slippageAdjustedMarkoutBps: round(rawBps - slippageBps),
    feeStatus: 'unavailable',
    roundTripFeeBps: null,
    netMarkoutBps: null,
    status: 'complete',
    evidenceOnly: true,
    performanceEvidence: false
  };
}

function summarize(state, asOf) {
  const completed = state.completed.filter(row => row.labelVersion === SHADOW_LABEL_VERSION && row.status === 'complete'
    && row.observationMethod === SHADOW_RESOLVER_VERSION && finite(row.slippageAdjustedMarkoutBps) && finite(row.executableQuoteMarkoutBps));
  const mean = key => completed.length ? round(completed.reduce((sum, row) => sum + row[key], 0) / completed.length) : null;
  const positive = completed.filter(row => row.slippageAdjustedMarkoutBps > 0).length;
  const byProfile = {};
  for (const row of completed) {
    const key = row.profile ?? 'unknown';
    const group = byProfile[key] ?? { samples: 0, positive: 0, sumSlippageAdjustedMarkoutBps: 0 };
    group.samples += 1;
    group.positive += row.slippageAdjustedMarkoutBps > 0 ? 1 : 0;
    group.sumSlippageAdjustedMarkoutBps += row.slippageAdjustedMarkoutBps;
    byProfile[key] = group;
  }
  for (const group of Object.values(byProfile)) {
    group.meanSlippageAdjustedMarkoutBps = round(group.sumSlippageAdjustedMarkoutBps / group.samples);
    group.positiveRate = round(group.positive / group.samples);
    delete group.sumSlippageAdjustedMarkoutBps;
  }
  return {
    version: HIGH_FREQUENCY_SHADOW_VERSION,
    labelVersion: SHADOW_LABEL_VERSION,
    observationMethod: SHADOW_RESOLVER_VERSION,
    horizonToleranceMs: SHADOW_HORIZON_TOLERANCE_MS,
    mode: 'dry-run',
    tradeEnabled: false,
    asOf,
    cycles: state.cycles,
    aiReviews: state.aiReviews,
    activePending: state.pending.length,
    completedMarkouts: completed.length,
    excludedOtherObservationMarkouts: state.completed.length - completed.length,
    unavailableMarkouts: state.unavailable.length,
    meanExecutableQuoteMarkoutBps: mean('executableQuoteMarkoutBps'),
    meanSlippageAdjustedMarkoutBps: mean('slippageAdjustedMarkoutBps'),
    positiveSlippageAdjustedRate: completed.length ? round(positive / completed.length) : null,
    meanNetMarkoutBps: null,
    feeStatus: 'unavailable',
    legacyCohorts: state.legacyCohorts,
    byProfile,
    evidence: {
      source: 'Binance public market data',
      costMeaning: 'Ask-to-bid quote markout already includes spread. Only additional two-sided slippage is deducted in the scenario. Account commissions remain unknown; net markout is unavailable.',
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

async function archiveOnce(file, raw) {
  try { await writeFile(file, raw, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!raw.equals(await readFile(file))) throw new Error('HIGH_FREQUENCY_LEGACY_ARCHIVE_CONFLICT');
  }
}

async function loadState(file, reportFile) {
  let raw;
  try { raw = await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return initialState(); throw error; }
  const value = JSON.parse(raw.toString('utf8'));
  if (value?.version !== LEGACY_VERSION) return normalizeState(value);
  if (value.mode !== 'dry-run' || value.tradeEnabled !== false || !['pending', 'completed', 'unavailable'].every(key => Array.isArray(value[key])))
    throw new Error('HIGH_FREQUENCY_SHADOW_STATE_INVALID');
  const stateArchive = file.replace(/\.json$/, '.v1.json'), reportArchive = reportFile.replace(/\.json$/, '.v1.json');
  // Preserve exact bytes before replacing either active v1 file. Old pending
  // observations cannot acquire a v2 cost/time contract retrospectively.
  await archiveOnce(stateArchive, raw);
  let archivedReport = false;
  try {
    const reportRaw = await readFile(reportFile);
    if (JSON.parse(reportRaw.toString('utf8'))?.version !== LEGACY_VERSION) throw new Error('HIGH_FREQUENCY_LEGACY_REPORT_INVALID');
    await archiveOnce(reportArchive, reportRaw);
    archivedReport = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...initialState(), legacyCohorts: [{
    version: LEGACY_VERSION,
    stateArchive: 'shadow-state.v1.json',
    reportArchive: archivedReport ? 'shadow-report.v1.json' : null,
    completedMarkouts: value.completed.length,
    pendingMarkouts: value.pending.length,
    unavailableMarkouts: value.unavailable.length,
    includedInCurrentStatistics: false,
    note: 'Preserved unchanged. Legacy spread deduction and unbounded horizon labels are not comparable with v2; pending legacy observations are not relabeled.'
  }] };
}

function serializedState(local, callback) {
  const previous = writers.get(local) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => lock(join(local, 'shadow-state.lock'), async () =>
    callback(await loadState(join(local, 'shadow-state.json'), join(local, 'shadow-report.json')))));
  writers.set(local, operation);
  operation.finally(() => { if (writers.get(local) === operation) writers.delete(local); }).catch(() => {});
  return operation;
}

async function publishState(local, state, asOf, event = {}) {
  state.completed = state.completed.slice(-MAX_COMPLETED);
  state.unavailable = state.unavailable.slice(-MAX_COMPLETED);
  const report = summarize(state, asOf);
  await appendFile(join(local, 'shadow-events.jsonl'), JSON.stringify({ version: HIGH_FREQUENCY_SHADOW_VERSION,
    labelVersion: SHADOW_LABEL_VERSION, at: asOf, cycle: state.cycles, ...event,
    completed: report.completedMarkouts, meanSlippageAdjustedMarkoutBps: report.meanSlippageAdjustedMarkoutBps, meanNetMarkoutBps: null }) + '\n');
  await writeJson(join(local, 'shadow-state.json'), state);
  await writeJson(join(local, 'shadow-report.json'), report);
  return report;
}

async function saveResolvedOutcome(local, anchor, resolution) {
  return serializedState(local, async state => {
    const current = state.pending.find(item => item.id === anchor.id);
    if (!current) return summarize(state, resolution.recordedAt);
    if (JSON.stringify(current) !== JSON.stringify(anchor)) throw Error('SHADOW_ANCHOR_CHANGED');
    const outcome = resolution.status === 'observed' ? markout(anchor, resolution.market, resolution.recordedAt) : null;
    if (outcome) state.completed.push(outcome);
    else state.unavailable.push({ ...anchor, status: resolution.status === 'observed' ? 'MARKOUT_DATA_INVALID' : resolution.status,
      recordedAt: resolution.recordedAt, actualElapsedMs: quote(resolution.market) ? quote(resolution.market).at - isoMs(anchor.anchorAt) : null,
      resolutionElapsedMs: isoMs(resolution.recordedAt) - isoMs(anchor.anchorAt), evidenceOnly: true, performanceEvidence: false });
    state.pending = state.pending.filter(item => item.id !== anchor.id);
    return publishState(local, state, resolution.recordedAt, { event: 'label_resolved', anchorId: anchor.id });
  });
}

async function resolveDueOnce(local, anchors, options) {
  for (const anchor of anchors) {
    if (shadowAnchorWindow(anchor)?.target > options.now()) continue;
    const resolution = await resolvePublicShadowQuote(anchor, options);
    if (resolution.status !== 'not_due') await saveResolvedOutcome(local, anchor, resolution);
  }
}

export async function runHighFrequencyShadowCycle(options = {}) {
  const local = options.local ?? join(LOCAL, 'ai-high-frequency');
  await mkdir(local, { recursive: true });
  const state = await serializedState(local, value => value);
  const config = options.strategyConfig ?? await loadHighFrequencyStrategy();
  const aiEveryCycles = options.aiEveryCycles ?? config.shadow?.aiReviewEveryCycles ?? 5;
  if (!Number.isInteger(aiEveryCycles) || aiEveryCycles < 1 || aiEveryCycles > 100) throw new Error('HIGH_FREQUENCY_AI_CADENCE_INVALID');
  const horizonMs = options.horizonMs ?? (config.shadow?.horizonSeconds?.[0] ?? 60) * 1000;
  if (!Number.isInteger(horizonMs) || horizonMs < 15_000 || horizonMs > 3_600_000) throw new Error('HIGH_FREQUENCY_HORIZON_INVALID');
  const due = options.aiEnabled !== false && (state.cycles === 0 || state.cycles % aiEveryCycles === 0);
  const cycleFn = options.cycleFn ?? runHighFrequencyCycle;
  const now = options.now ?? Date.now;
  const result = await cycleFn({
    local,
    policy: options.policy ?? await loadPolicy('dry-run'),
    strategyConfig: config,
    strategyProfile: state.profile,
    sensitivity: state.sensitivity,
    analyzeFn: due ? options.analyzeFn : reuseAnalysis(options.aiEnabled === false ? initialState() : state),
    collectFn: options.collectFn,
    fetchImpl: options.fetchImpl,
    now,
    signal: options.signal,
    includeSnapshot: true
  });
  const snapshot = result.snapshot;
  if (!snapshot || result.tradeEnabled !== false || result.mode !== 'dry-run') throw new Error('HIGH_FREQUENCY_SHADOW_RESULT_INVALID');
  const decisionAt = new Date(now()).toISOString(), quoteFn = options.quoteFn ?? collectPublicShadowQuote;
  if (options.resolver) options.resolver.assertHealthy();
  else await resolveDueOnce(local, state.pending, { quoteFn, fetchImpl: options.fetchImpl, now });
  const control = result.strategy?.aiControl;
  const approvedControl = control?.decision === 'use' && ['auto', 'momentum', 'mean-reversion', 'breakout'].includes(control.profile)
    && ['conservative', 'balanced', 'aggressive'].includes(control.sensitivity)
    && result.proposal?.action === 'buy' && result.strategy?.applied?.action === 'buy'
    && result.proposal.pair === result.strategy.applied.pair;
  const stopFile = options.stopFile ?? join(local, 'STOP');
  const approved = options.aiEnabled !== false && !await exists(stopFile) && (due ? approvedControl : state.control?.decision === 'use');
  // A new AI result can only create an observation after it has returned. It
  // cannot retroactively "buy" the snapshot quote it was shown minutes ago.
  const selected = approved ? (due ? result.strategy.applied : result.strategy?.selected) : null;
  let anchor = null, anchorFailure = null;
  if (selected?.action === 'buy' && typeof selected.pair === 'string') {
    const market = marketMap(snapshot).get(selected.pair), slippage = numeric(market?.cost?.additionalSlippageBps);
    try {
      if (market?.cost?.version !== 'quote-cost-scenario-v2' || slippage === null || slippage < 0) throw Error('SHADOW_ANCHOR_COST_INVALID');
      const fresh = await quoteFn(selected.pair, { fetchImpl: options.fetchImpl, now, timeoutMs: 3_000 }), observed = quote(fresh);
      if (!observed || fresh.source !== SHADOW_QUOTE_SOURCE || fresh.pair !== selected.pair
        || isoMs(fresh.requestStartedAt) === null || isoMs(fresh.requestStartedAt) < isoMs(decisionAt)
        || observed.at < isoMs(fresh.requestStartedAt) || observed.at > now()) throw Error('SHADOW_ANCHOR_QUOTE_INVALID');
      anchor = { labelVersion: SHADOW_LABEL_VERSION, observationMethod: SHADOW_RESOLVER_VERSION,
        id: `${snapshot.id}:${selected.pair}:${horizonMs}`, pair: selected.pair, profile: selected.profile,
        sensitivity: approvedControl ? control.sensitivity : state.sensitivity, snapshotId: snapshot.id,
        sourceSnapshotAt: snapshot.createdAt, decisionAt, anchorRequestedAt: fresh.requestStartedAt,
        anchorAt: new Date(observed.at).toISOString(), targetAt: new Date(observed.at + horizonMs).toISOString(),
        anchorAsk: String(fresh.quote.ask), additionalSlippageBps: String(slippage), feeStatus: 'unavailable',
        horizonMs, horizonToleranceMs: SHADOW_HORIZON_TOLERANCE_MS,
        evidenceIds: snapshot.evidence.filter(e => e.pair === selected.pair).map(e => e.id), evidenceOnly: true };
    } catch { anchorFailure = 'SHADOW_FRESH_ANCHOR_UNAVAILABLE'; }
  }
  if (await exists(stopFile)) { anchor = null; if (selected) anchorFailure = 'SHADOW_STOPPED_BEFORE_ANCHOR'; }
  const asOf = new Date(now()).toISOString();
  const report = await serializedState(local, async next => {
    next.cycles += 1;
    next.lastCycleAt = asOf;
    if (due) {
      next.aiReviews += 1;
      next.lastAiReviewAt = decisionAt;
      next.profile = approvedControl ? control.profile : 'auto';
      next.sensitivity = approvedControl ? control.sensitivity : 'balanced';
      next.control = approvedControl ? { decision: 'use', profile: control.profile, sensitivity: control.sensitivity,
        evidenceIds: control.evidenceIds ?? [], reason: control.reason ?? '', acceptedAt: decisionAt }
        : { decision: 'hold', profile: 'auto', sensitivity: 'balanced', reason: control?.reason ?? 'AI_CONTROL_HOLD' };
    }
    if (selected?.pair) next.lastPair = selected.pair;
    if (anchor && next.pending.length < Math.min(MAX_PENDING, config.shadow?.maxPending ?? MAX_PENDING)) next.pending.push(anchor);
    const value = await publishState(local, next, asOf, { event: 'strategy_cycle', aiReview: due, selected: selected?.pair ?? null, anchorFailure });
    options.resolver?.sync(next.pending);
    return value;
  });
  return { ...report, snapshotId: snapshot.id, anchorFailure,
    selected: selected ? { pair: selected.pair, profile: selected.profile, regime: selected.regime } : null, result };
}

export function nextShadowCadence(scheduledAt, intervalMs, finishedAt) {
  const intended = scheduledAt + intervalMs, skipped = Math.max(0, Math.ceil((finishedAt - intended) / intervalMs));
  return { nextAt: intended + skipped * intervalMs, skipped };
}

export async function runHighFrequencyShadow({ cycles = 1, intervalSeconds = 60, aiEveryCycles, ...options } = {}) {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1_000_000) throw new Error('HIGH_FREQUENCY_SHADOW_CYCLES_INVALID');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 3_600) throw new Error('HIGH_FREQUENCY_SHADOW_INTERVAL_INVALID');
  const local = options.local ?? join(LOCAL, 'ai-high-frequency');
  const stopFile = options.stopFile ?? join(local, 'STOP');
  const workerFile = join(local, 'worker.json');
  const now = options.now ?? Date.now, wait = options.wait ?? delay;
  await mkdir(local, { recursive: true });
  return lock(join(local, 'shadow-worker.lock'), async () => {
    const resolver = createShadowQuoteResolver({ quoteFn: options.quoteFn, fetchImpl: options.fetchImpl, now,
      schedule: options.schedule, unschedule: options.unschedule, stopped: () => exists(stopFile),
      onOutcome: (anchor, resolution) => saveResolvedOutcome(local, anchor, resolution) });
    const results = [];
    let scheduledAt = now(), skippedCycles = 0, executedCycles = 0, interrupted = false;
    try {
      await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid,
        status: 'running', startedAt: new Date(now()).toISOString(), tradeEnabled: false,
        cadence: 'fixed-skip-missed-v1', labelResolver: SHADOW_RESOLVER_VERSION });
      const state = await serializedState(local, value => value);
      resolver.sync(state.pending);
      for (let index = 0; index < cycles; index++) {
        if (await exists(stopFile)) { interrupted = true; break; }
        resolver.assertHealthy();
        const cycle = await runHighFrequencyShadowCycle({ ...options, local, aiEveryCycles, resolver });
        executedCycles++;
        results.push({ snapshotId: cycle.snapshotId, asOf: cycle.asOf, selected: cycle.selected, anchorFailure: cycle.anchorFailure,
          activePending: cycle.activePending, completedMarkouts: cycle.completedMarkouts, unavailableMarkouts: cycle.unavailableMarkouts,
          marketCount: cycle.result.marketCount ?? cycle.result.snapshot?.markets?.length ?? null,
          aiReviews: cycle.aiReviews, meanSlippageAdjustedMarkoutBps: cycle.meanSlippageAdjustedMarkoutBps, meanNetMarkoutBps: null });
        if (results.length > MAX_RECENT_CYCLES) results.shift();
        resolver.assertHealthy();
        if (index + 1 < cycles) {
          const cadence = nextShadowCadence(scheduledAt, intervalSeconds * 1000, now());
          scheduledAt = cadence.nextAt;
          skippedCycles += cadence.skipped;
          while (now() < scheduledAt) {
            if (await exists(stopFile)) { interrupted = true; break; }
            await wait(Math.min(1_000, scheduledAt - now()));
          }
          if (interrupted) break;
        }
      }
      // Finite runs finish their already-created observations. No timer is left
      // behind. STOP retains pending records for explicit restart reconciliation.
      if (!interrupted && !await exists(stopFile)) await resolver.drain();
      await resolver.stop();
      const report = await serializedState(local, state => summarize(state, new Date(now()).toISOString()));
      await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid,
        status: 'stopped', stoppedAt: new Date(now()).toISOString(), cycles: executedCycles, skippedCycles, tradeEnabled: false });
      return { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', tradeEnabled: false, executedCycles,
        retainedCycleLimit: MAX_RECENT_CYCLES, skippedCycles, report, cycles: results };
    } catch (error) {
      await resolver.stop();
      await writeJson(workerFile, { version: HIGH_FREQUENCY_SHADOW_VERSION, mode: 'dry-run', pid: process.pid,
        status: 'error', stoppedAt: new Date(now()).toISOString(), cycles: executedCycles, skippedCycles,
        error: String(error.message ?? error), tradeEnabled: false });
      throw error;
    }
  });
}
