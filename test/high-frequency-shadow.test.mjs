import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHighFrequencyShadowCycle, runHighFrequencyShadow, nextShadowCadence, HIGH_FREQUENCY_SHADOW_VERSION, SHADOW_LABEL_VERSION, SHADOW_HORIZON_TOLERANCE_MS } from '../src/high-frequency-shadow.mjs';
import { SHADOW_QUOTE_SOURCE } from '../src/shadow-quote-resolver.mjs';
import { loadHighFrequencyStrategy } from '../src/high-frequency-strategy.mjs';

const market = ({ bid, ask = String(Number(bid) + .01), observedAt = '2026-09-18T07:00:00.000Z', slippage = 10 }) => ({
  pair: 'BTC/USDT',
  quote: { bid, ask, spreadBps: 1, observedAt },
  cost: { version: 'quote-cost-scenario-v2', feeStatus: 'unavailable', additionalSlippageBps: slippage, estimatedRoundTripCostBps: 1 + slippage },
  orderBook: { imbalanceTop5: 0.2 },
  takerFlow: { buyShare: 0.6 },
  microMomentum: { return1mBps: 1, return5mBps: 2, return15mBps: 2 }
});

test('shadow observer keeps AI bounded and records quote and extra-slippage markouts', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binancetrade-high-frequency-shadow-'));
  let cycle = 0;
  let mockNow = Date.parse('2026-09-18T07:00:00.000Z'), currentMarket;
  const calls = [];
  const cycleFn = async options => {
    calls.push({ cycle, reused: typeof options.analyzeFn === 'function' });
    const at = cycle++ === 0 ? '2026-09-18T07:00:00.000Z' : '2026-09-18T07:01:00.000Z';
    mockNow = Date.parse(at);
    currentMarket = market({ bid: cycle === 1 ? '100' : '100.21', observedAt: at });
    const snapshot = { id: `00000000-0000-4000-8000-00000000000${cycle}`, mode: 'dry-run', createdAt: at, completedAt: at,
      markets: [market({ bid: cycle === 1 ? '100' : '100.21', observedAt: at })], evidence: [
        { id: 'hf:book:BTC/USDT', pair: 'BTC/USDT' }, { id: 'hf:flow:BTC/USDT', pair: 'BTC/USDT' },
        { id: 'hf:momentum:BTC/USDT', pair: 'BTC/USDT' }, { id: 'cost:BTC/USDT', pair: 'BTC/USDT' }
      ] };
    const selected = { action: 'buy', pair: 'BTC/USDT', profile: 'breakout', regime: 'breakout-up' };
    return { mode: 'dry-run', tradeEnabled: false, snapshot, proposal: { action: 'buy', pair: 'BTC/USDT' },
      strategy: { aiControl: cycle === 1 ? { decision: 'use', profile: 'breakout', sensitivity: 'balanced', evidenceIds: snapshot.evidence.map(e => e.id), reason: 'bounded' } : undefined,
        applied: cycle === 1 ? selected : undefined, selected } };
  };
  const quoteFn = async pair => ({ ...currentMarket, pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: new Date(mockNow).toISOString() });
  const first = await runHighFrequencyShadowCycle({ local, cycleFn, quoteFn, now: () => mockNow, aiEveryCycles: 5, horizonMs: 60_000 });
  const second = await runHighFrequencyShadowCycle({ local, cycleFn, quoteFn, now: () => mockNow, aiEveryCycles: 5, horizonMs: 60_000 });
  assert.equal(first.tradeEnabled, false);
  assert.equal(second.completedMarkouts, 1);
  assert.equal(second.meanExecutableQuoteMarkoutBps, 19.998);
  assert.equal(second.meanSlippageAdjustedMarkoutBps, 9.998);
  assert.equal(second.positiveSlippageAdjustedRate, 1);
  assert.equal(second.meanNetMarkoutBps, null);
  assert.equal(second.feeStatus, 'unavailable');
  assert.equal(second.selected.pair, 'BTC/USDT');
  assert.equal(calls[0].reused, false);
  assert.equal(calls[1].reused, true);
  const report = JSON.parse(await readFile(join(local, 'shadow-report.json'), 'utf8'));
  assert.equal(report.evidence.orderAuthority, 'none');
  assert.equal(report.evidence.performanceEvidence, false);
  const state = JSON.parse(await readFile(join(local, 'shadow-state.json'), 'utf8'));
  assert.equal(state.completed[0].actualElapsedMs, 60_000);
  assert.equal(state.completed[0].labelVersion, SHADOW_LABEL_VERSION);
  assert.equal(state.completed[0].netMarkoutBps, null);
  assert.equal(state.completed[0].roundTripFeeBps, null);
});

test('real high-frequency cycle keeps the reused HOLD proposal schema-valid', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binancetrade-high-frequency-shadow-schema-'));
  const config = await loadHighFrequencyStrategy();
  let collected = 0, modelCalls = 0;
  const collectFn = async () => {
    const at = collected++ === 0 ? '2026-09-18T07:00:00.000Z' : '2026-09-18T07:01:00.000Z';
    return { id: randomUUID(), mode: 'dry-run', timeframe: '1m', createdAt: at, completedAt: at,
      horizonSeconds: [15, 60], markets: [], evidence: [], errors: [], researchCoverage: [] };
  };
  const analyzeFn = async snapshot => {
    modelCalls += 1;
    return { proposal: { action: 'hold', pair: 'BTC/USDT', stakeUsdt: '0', snapshotId: snapshot.id,
      evidenceIds: [], reason: 'test hold', strategyControl: { decision: 'hold', profile: 'auto', sensitivity: 'balanced', evidenceIds: [], reason: 'test hold' } },
      metadata: { purpose: 'high-frequency-cli', requestedModel: 'test' }, runDir: 'test' };
  };
  const fetchImpl = async () => { throw Error('TEST_MUST_NOT_FETCH'); };
  await runHighFrequencyShadowCycle({ local, strategyConfig: config, policy: { mode: 'dry-run' }, collectFn, analyzeFn, fetchImpl });
  const second = await runHighFrequencyShadowCycle({ local, strategyConfig: config, policy: { mode: 'dry-run' }, collectFn, analyzeFn, fetchImpl });
  assert.equal(collected, 2);
  assert.equal(modelCalls, 1);
  assert.equal(second.result.strategy.aiControl.reason, 'SHADOW_REUSE_LAST_AI_POLICY');
  assert.equal(second.result.proposal.action, 'hold');
  assert.equal(second.result.proposal.pair, 'BTC/USDT');
});

const startMs = Date.parse('2026-09-18T07:00:00.000Z');
const iso = elapsed => new Date(startMs + elapsed).toISOString();
const readState = async local => JSON.parse(await readFile(join(local, 'shadow-state.json'), 'utf8'));
async function shadowStep(local, elapsed, { select = false, quoteElapsed = elapsed, missing = false, bid = '100', ask = '100.01', slippage = 0 } = {}) {
  const at = iso(elapsed), candidate = { action: 'buy', pair: 'BTC/USDT', profile: 'momentum', regime: 'trend-up' };
  return runHighFrequencyShadowCycle({ local, horizonMs: 60_000, strategyConfig: { shadow: { aiReviewEveryCycles: 5 } }, policy: { mode: 'dry-run' },
    now: () => startMs + elapsed,
    quoteFn: async pair => {
      if (missing) throw Error('SYNTHETIC_QUOTE_UNAVAILABLE');
      return { ...market({ bid, ask, slippage, observedAt: iso(quoteElapsed) }), pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: at };
    },
    cycleFn: async () => ({ mode: 'dry-run', tradeEnabled: false, proposal: { action: select ? 'buy' : 'hold', pair: 'BTC/USDT' },
      snapshot: { id: randomUUID(), mode: 'dry-run', createdAt: at, completedAt: at,
        markets: missing ? [] : [market({ bid, ask, slippage, observedAt: iso(quoteElapsed) })], evidence: [] },
      strategy: { aiControl: { decision: select ? 'use' : 'hold', profile: 'auto', sensitivity: 'balanced' }, applied: select ? candidate : null } }) });
}

test('unchanged executable quotes pay spread once, with unknown commission never converted to net zero', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-spread-'));
  await shadowStep(local, 0, { select: true, bid: '99', ask: '101' });
  const report = await shadowStep(local, 60_000, { bid: '99', ask: '101' });
  const expected = Number(((99 / 101 - 1) * 10000).toFixed(6));
  assert.equal(report.meanExecutableQuoteMarkoutBps, expected);
  assert.equal(report.meanSlippageAdjustedMarkoutBps, expected);
  assert.equal(report.meanNetMarkoutBps, null);
  assert.equal(report.feeStatus, 'unavailable');
  assert.equal(Object.hasOwn(report, 'meanCostAdjustedMarkoutBps'), false);
  assert.equal((await readState(local)).completed[0].additionalSlippageBps, '0');
});

for (const elapsed of [60_000, 60_000 + SHADOW_HORIZON_TOLERANCE_MS]) {
  test(`horizon accepts inclusive observed boundary ${elapsed}ms and records actual elapsed`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-on-time-'));
    await shadowStep(local, 0, { select: true });
    const report = await shadowStep(local, elapsed);
    assert.equal(report.completedMarkouts, 1);
    assert.equal((await readState(local)).completed[0].actualElapsedMs, elapsed);
  });
}

for (const elapsed of [65_001, 300_000, 3_600_000]) {
  test(`horizon rejects late or post-outage quote ${elapsed}ms even when market is available`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-late-'));
    await shadowStep(local, 0, { select: true });
    const report = await shadowStep(local, elapsed, { bid: '110', ask: '110.01' });
    assert.equal(report.completedMarkouts, 0);
    assert.equal(report.activePending, 0);
    assert.equal(report.meanSlippageAdjustedMarkoutBps, null);
    const state = await readState(local);
    assert.equal(state.unavailable[0].status, 'MARKOUT_HORIZON_EXPIRED');
    assert.equal(state.unavailable[0].actualElapsedMs, null);
    assert.equal(state.unavailable[0].resolutionElapsedMs, elapsed);
  });
}

test('early quote stays pending, while absent quote expires without a fabricated outcome', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-missing-'));
  await shadowStep(local, 0, { select: true });
  assert.equal((await shadowStep(local, 59_999)).activePending, 1);
  assert.equal((await shadowStep(local, 65_000, { missing: true })).activePending, 0);
  const report = await shadowStep(local, 65_001, { missing: true });
  assert.equal(report.completedMarkouts, 0);
  assert.equal(report.activePending, 0);
  assert.equal((await readState(local)).unavailable[0].actualElapsedMs, null);
});

for (const invalid of [
  { bid: '-1' }, { bid: '0' }, { bid: 'NaN' }, { bid: '101', ask: '100' },
  { bid: null }, { bid: true }, { ask: '' }, { quoteElapsed: 59_999 }, { quoteElapsed: 60_001 }
]) {
  test(`invalid or mis-timed exit quote is unknown: ${JSON.stringify(invalid)}`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-invalid-'));
    await shadowStep(local, 0, { select: true });
    const report = await shadowStep(local, 60_000, invalid);
    assert.equal(report.completedMarkouts, 0);
    assert.equal((await readState(local)).unavailable[0].status, 'MARKOUT_DATA_INVALID');
  });
}

for (const invalid of [{ bid: '-1' }, { bid: '101', ask: '100' }, { slippage: -1 }, { slippage: null }, { slippage: false }]) {
  test(`invalid entry quote/cost never creates an anchor: ${JSON.stringify(invalid)}`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-invalid-anchor-'));
    assert.equal((await shadowStep(local, 0, { select: true, ...invalid })).activePending, 0);
  });
}

test('v1 state and report are archived byte-for-byte and legacy samples never enter v2 statistics', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-migrate-'));
  const legacy = { version: 'ai-high-frequency-shadow-v1', mode: 'dry-run', tradeEnabled: false, cycles: 85, aiReviews: 17,
    pending: [{ id: 'legacy-pending', pair: 'BTC/USDT', anchorAt: iso(0), horizonMs: 60_000, anchorAsk: '100', costBps: '10' }],
    completed: [{ status: 'complete', costAdjustedMarkoutBps: 999 }], unavailable: [] };
  const raw = JSON.stringify(legacy, null, 2) + '\n', oldReport = JSON.stringify({ version: legacy.version, completedMarkouts: 1, meanCostAdjustedMarkoutBps: 999 }) + '\n';
  await writeFile(join(local, 'shadow-state.json'), raw);
  await writeFile(join(local, 'shadow-report.json'), oldReport);
  await writeFile(join(local, 'shadow-events.jsonl'), '{"legacy":true}\n');
  const first = await shadowStep(local, 0, { select: true });
  assert.equal(first.version, HIGH_FREQUENCY_SHADOW_VERSION);
  assert.equal(first.completedMarkouts, 0);
  assert.equal(first.legacyCohorts[0].pendingMarkouts, 1);
  assert.equal(first.legacyCohorts[0].includedInCurrentStatistics, false);
  assert.equal(await readFile(join(local, 'shadow-state.v1.json'), 'utf8'), raw);
  assert.equal(await readFile(join(local, 'shadow-report.v1.json'), 'utf8'), oldReport);
  const second = await shadowStep(local, 60_000);
  assert.equal(second.completedMarkouts, 1);
  assert.equal(second.legacyCohorts.length, 1);
  assert.ok(second.meanSlippageAdjustedMarkoutBps < 0);
  assert.equal(await readFile(join(local, 'shadow-state.v1.json'), 'utf8'), raw);
  assert.match(await readFile(join(local, 'shadow-events.jsonl'), 'utf8'), /^\{"legacy":true\}\n/);
});

test('unknown state version is rejected without silently erasing historical data', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-unknown-version-'));
  const raw = JSON.stringify({ version: 'future-version', completed: [{ pnl: 12 }] });
  await writeFile(join(local, 'shadow-state.json'), raw);
  await assert.rejects(shadowStep(local, 0), /HIGH_FREQUENCY_SHADOW_STATE_INVALID/);
  assert.equal(await readFile(join(local, 'shadow-state.json'), 'utf8'), raw);
});

function fakeClock(initial = startMs) {
  let time = initial, id = 0;
  const jobs = new Map();
  const now = () => time;
  const schedule = (fn, ms) => { jobs.set(++id, { at: time + ms, fn }); return id; };
  const unschedule = key => jobs.delete(key);
  const advance = async ms => {
    const end = time + ms;
    while (true) {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      jobs.delete(next[0]); time = Math.max(time, next[1].at); await next[1].fn();
    }
    time = Math.max(time, end);
  };
  return { now, schedule, unschedule, advance, pendingTimers: () => jobs.size };
}

function syntheticCycle(at, select = false) {
  const candidate = { action: 'buy', pair: 'BTC/USDT', profile: 'momentum', regime: 'trend-up' };
  return { mode: 'dry-run', tradeEnabled: false, proposal: { action: select ? 'buy' : 'hold', pair: 'BTC/USDT' },
    snapshot: { id: randomUUID(), mode: 'dry-run', createdAt: at, completedAt: at,
      markets: [market({ bid: '100', ask: '100.01', slippage: 0, observedAt: at })], evidence: [] },
    strategy: { aiControl: { decision: select ? 'use' : 'hold', profile: 'momentum', sensitivity: 'balanced' },
      applied: select ? candidate : null, selected: select ? candidate : null } };
}

test('fresh anchor starts after slow AI, and independent resolver writes its label during the next slow AI cycle', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-slow-ai-')), clock = fakeClock(), starts = [], quotes = [];
  let count = 0;
  const result = await runHighFrequencyShadow({ local, cycles: 2, intervalSeconds: 60, aiEveryCycles: 1,
    strategyConfig: {}, policy: { mode: 'dry-run' }, ...clock, wait: clock.advance,
    cycleFn: async () => {
      const at = new Date(clock.now()).toISOString(); starts.push(clock.now() - startMs);
      await clock.advance(count === 0 ? 30_000 : 45_000);
      return syntheticCycle(at, count++ === 0);
    },
    quoteFn: async pair => {
      const at = new Date(clock.now()).toISOString(); quotes.push(clock.now() - startMs);
      return { pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: at,
        quote: { bid: quotes.length === 1 ? '100.99' : '102', ask: quotes.length === 1 ? '101' : '102.01', observedAt: at } };
    } });
  assert.deepEqual(starts, [0, 60_000]);
  assert.deepEqual(quotes, [30_000, 90_000]);
  assert.equal(result.executedCycles, 2);
  assert.equal(result.report.completedMarkouts, 1);
  const state = await readState(local), outcome = state.completed[0];
  assert.equal(state.cycles, 2);
  assert.equal(outcome.sourceSnapshotAt, iso(0));
  assert.equal(outcome.decisionAt, iso(30_000));
  assert.equal(outcome.anchorAt, iso(30_000));
  assert.equal(outcome.anchorAsk, '101');
  assert.equal(outcome.actualElapsedMs, 60_000);
  assert.equal(clock.pendingTimers(), 0);
});

test('fixed cadence skips missed slots without replaying cycles or retaining full snapshots', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-cadence-')), clock = fakeClock(), starts = [];
  const result = await runHighFrequencyShadow({ local, cycles: 2, intervalSeconds: 60, aiEnabled: false,
    strategyConfig: {}, policy: { mode: 'dry-run' }, ...clock, wait: clock.advance,
    cycleFn: async () => {
      starts.push(clock.now() - startMs);
      const at = new Date(clock.now()).toISOString(); if (starts.length === 1) await clock.advance(125_000);
      return syntheticCycle(at);
    } });
  assert.deepEqual(starts, [0, 180_000]);
  assert.equal(result.skippedCycles, 2);
  assert.equal(Object.hasOwn(result.cycles[0], 'result'), false);
  assert.deepEqual(nextShadowCadence(0, 60_000, 60_000), { nextAt: 60_000, skipped: 0 });
  assert.deepEqual(nextShadowCadence(0, 60_000, 120_000), { nextAt: 120_000, skipped: 1 });
});

test('long-running worker retains at most 32 compact cycle summaries and accurate executed count', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-bounded-')), clock = fakeClock();
  const result = await runHighFrequencyShadow({ local, cycles: 35, intervalSeconds: 60, aiEnabled: false,
    strategyConfig: {}, policy: { mode: 'dry-run' }, ...clock, wait: clock.advance,
    cycleFn: async () => syntheticCycle(new Date(clock.now()).toISOString()) });
  assert.equal(result.executedCycles, 35);
  assert.equal(result.cycles.length, 32);
  assert.equal(result.cycles[0].asOf, iso(180_000));
  assert.equal(JSON.parse(await readFile(join(local, 'worker.json'), 'utf8')).cycles, 35);
});

for (const restartAt of [62_000, 66_000]) {
  test(`restart reconciles persisted pending at ${restartAt}ms without relabeling a late quote`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-restart-'));
    await shadowStep(local, 0, { select: true });
    const clock = fakeClock(startMs + restartAt); let requests = 0;
    const result = await runHighFrequencyShadow({ local, cycles: 1, aiEnabled: false,
      strategyConfig: {}, policy: { mode: 'dry-run' }, ...clock, wait: clock.advance,
      cycleFn: async () => { await clock.advance(0); return syntheticCycle(iso(restartAt)); },
      quoteFn: async pair => { requests++; return { pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: iso(restartAt),
        quote: { bid: '100', ask: '100.01', observedAt: iso(restartAt) } }; } });
    assert.equal(result.report.completedMarkouts, restartAt === 62_000 ? 1 : 0);
    assert.equal(result.report.unavailableMarkouts, restartAt === 62_000 ? 0 : 1);
    assert.equal(requests, restartAt === 62_000 ? 1 : 0);
    assert.equal(result.report.activePending, 0);
    assert.equal(clock.pendingTimers(), 0);
  });
}

for (const invalid of ['no-controlled-candidate', 'hold-evidence-rejected', 'pair-mismatch']) {
  test(`AI result rejected by controlled proposal cannot fabricate an anchor: ${invalid}`, async () => {
    const local = await mkdtemp(join(tmpdir(), 'binance-shadow-hold-')); let requests = 0;
    const result = syntheticCycle(iso(0), true);
    if (invalid === 'no-controlled-candidate') result.strategy.applied = null;
    if (invalid === 'hold-evidence-rejected') result.proposal.action = 'hold';
    if (invalid === 'pair-mismatch') result.proposal.pair = 'ETH/USDT';
    const report = await runHighFrequencyShadowCycle({ local, now: () => startMs, strategyConfig: {}, policy: { mode: 'dry-run' },
      cycleFn: async () => result, quoteFn: async () => { requests++; throw Error('MUST_NOT_CAPTURE'); } });
    assert.equal(report.activePending, 0);
    assert.equal(requests, 0);
    assert.equal((await readState(local)).control.decision, 'hold');
  });
}

test('STOP arriving while AI runs prevents fresh quote request and new anchor', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-stop-after-ai-')); let requests = 0;
  const report = await runHighFrequencyShadowCycle({ local, now: () => startMs, strategyConfig: {}, policy: { mode: 'dry-run' },
    cycleFn: async () => { await writeFile(join(local, 'STOP'), 'test'); return syntheticCycle(iso(0), true); },
    quoteFn: async () => { requests++; throw Error('MUST_NOT_CAPTURE'); } });
  assert.equal(report.activePending, 0);
  assert.equal(requests, 0);
});

test('STOP arriving during the fresh anchor request prevents persisting a new observation', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-stop-fresh-'));
  const report = await runHighFrequencyShadowCycle({ local, now: () => startMs, strategyConfig: {}, policy: { mode: 'dry-run' },
    cycleFn: async () => syntheticCycle(iso(0), true), quoteFn: async pair => {
      await writeFile(join(local, 'STOP'), 'test');
      return { pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: iso(0), quote: { bid: '100', ask: '100.01', observedAt: iso(0) } };
    } });
  assert.equal(report.activePending, 0);
  assert.equal(report.anchorFailure, 'SHADOW_STOPPED_BEFORE_ANCHOR');
});

test('no-AI mode performs only public observation without invoking a model or inventing an entry', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binance-shadow-no-ai-'));
  let modelCalls = 0, quoteCalls = 0;
  const report = await runHighFrequencyShadowCycle({ local, aiEnabled: false, now: () => startMs, policy: { mode: 'dry-run' },
    collectFn: async () => ({ ...syntheticCycle(iso(0), true).snapshot, errors: [], timeframe: '1m' }),
    analyzeFn: async () => { modelCalls++; throw Error('MUST_NOT_CALL_AI'); },
    quoteFn: async () => { quoteCalls++; throw Error('MUST_NOT_CAPTURE'); } });
  assert.equal(report.activePending, 0);
  assert.equal(report.aiReviews, 0);
  assert.equal(report.selected, null);
  assert.equal(modelCalls, 0);
  assert.equal(quoteCalls, 0);
});
