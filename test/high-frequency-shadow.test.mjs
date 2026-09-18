import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHighFrequencyShadowCycle } from '../src/high-frequency-shadow.mjs';
import { loadHighFrequencyStrategy } from '../src/high-frequency-strategy.mjs';

const market = ({ bid, ask = '100.01' }) => ({
  pair: 'BTC/USDT',
  quote: { bid, ask, spreadBps: 1 },
  cost: { estimatedRoundTripCostBps: 10 },
  orderBook: { imbalanceTop5: 0.2 },
  takerFlow: { buyShare: 0.6 },
  microMomentum: { return1mBps: 1, return5mBps: 2, return15mBps: 2 }
});

test('shadow observer keeps AI bounded and records a later cost-adjusted markout', async () => {
  const local = await mkdtemp(join(tmpdir(), 'binancetrade-high-frequency-shadow-'));
  let cycle = 0;
  const calls = [];
  const cycleFn = async options => {
    calls.push({ cycle, reused: typeof options.analyzeFn === 'function' });
    const at = cycle++ === 0 ? '2026-09-18T07:00:00.000Z' : '2026-09-18T07:01:00.000Z';
    const snapshot = { id: `00000000-0000-4000-8000-00000000000${cycle}`, mode: 'dry-run', createdAt: at, completedAt: at,
      markets: [market({ bid: cycle === 1 ? '100' : '100.21' })], evidence: [
        { id: 'hf:book:BTC/USDT', pair: 'BTC/USDT' }, { id: 'hf:flow:BTC/USDT', pair: 'BTC/USDT' },
        { id: 'hf:momentum:BTC/USDT', pair: 'BTC/USDT' }, { id: 'cost:BTC/USDT', pair: 'BTC/USDT' }
      ] };
    const selected = { action: 'buy', pair: 'BTC/USDT', profile: 'breakout', regime: 'breakout-up' };
    return { mode: 'dry-run', tradeEnabled: false, snapshot,
      strategy: { aiControl: cycle === 1 ? { decision: 'use', profile: 'breakout', sensitivity: 'balanced', evidenceIds: snapshot.evidence.map(e => e.id), reason: 'bounded' } : undefined,
        applied: cycle === 1 ? selected : undefined, selected } };
  };
  const first = await runHighFrequencyShadowCycle({ local, cycleFn, aiEveryCycles: 5, horizonMs: 60_000 });
  const second = await runHighFrequencyShadowCycle({ local, cycleFn, aiEveryCycles: 5, horizonMs: 60_000 });
  assert.equal(first.tradeEnabled, false);
  assert.equal(second.completedMarkouts, 1);
  assert.equal(second.meanCostAdjustedMarkoutBps, 9.998);
  assert.equal(second.positiveCostAdjustedRate, 1);
  assert.equal(second.selected.pair, 'BTC/USDT');
  assert.equal(calls[0].reused, false);
  assert.equal(calls[1].reused, true);
  const report = JSON.parse(await readFile(join(local, 'shadow-report.json'), 'utf8'));
  assert.equal(report.evidence.orderAuthority, 'none');
  assert.equal(report.evidence.performanceEvidence, false);
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
  await runHighFrequencyShadowCycle({ local, strategyConfig: config, policy: { mode: 'dry-run' }, collectFn, analyzeFn });
  const second = await runHighFrequencyShadowCycle({ local, strategyConfig: config, policy: { mode: 'dry-run' }, collectFn, analyzeFn });
  assert.equal(modelCalls, 1);
  assert.equal(second.result.strategy.aiControl.reason, 'SHADOW_REUSE_LAST_AI_POLICY');
  assert.equal(second.result.proposal.action, 'hold');
  assert.equal(second.result.proposal.pair, 'BTC/USDT');
});
