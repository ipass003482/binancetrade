import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPublicShadowQuote, resolvePublicShadowQuote, createShadowQuoteResolver, SHADOW_QUOTE_SOURCE } from '../src/shadow-quote-resolver.mjs';

const origin = Date.parse('2026-09-20T10:00:00.000Z');
const iso = ms => new Date(origin + ms).toISOString();
const anchor = { id: 'test-anchor', pair: 'BTC/USDT', anchorAt: iso(0), targetAt: iso(60_000), horizonMs: 60_000, horizonToleranceMs: 5_000 };
const quoteAt = ms => ({ pair: 'BTC/USDT', source: SHADOW_QUOTE_SOURCE, requestStartedAt: iso(ms),
  quote: { bid: '100', ask: '100.01', observedAt: iso(ms) } });

test('public resolver uses only unsigned GET bookTicker and captures actual receipt time', async () => {
  let time = origin, captured;
  const market = await collectPublicShadowQuote('BTC/USDT', { now: () => time, fetchImpl: async (url, options) => {
    captured = { url, options }; time += 120;
    return new Response(JSON.stringify({ symbol: 'BTCUSDT', bidPrice: '100', askPrice: '100.01' }));
  } });
  assert.equal(captured.url, SHADOW_QUOTE_SOURCE + '?symbol=BTCUSDT');
  assert.equal(captured.options.method, 'GET');
  assert.deepEqual(captured.options.headers, { Accept: 'application/json' });
  assert.equal(market.requestStartedAt, iso(0));
  assert.equal(market.quote.observedAt, iso(120));
});

test('public quote resolver rejects unsafe pairs and invalid quotes without any private API fallback', async () => {
  let requests = 0;
  await assert.rejects(collectPublicShadowQuote('../private', { fetchImpl: async () => { requests++; } }), /SHADOW_PUBLIC_PAIR_INVALID/);
  assert.equal(requests, 0);
  for (const [bidPrice, askPrice] of [['-1', '1'], ['101', '100'], [null, '1']]) {
    await assert.rejects(collectPublicShadowQuote('BTC/USDT', { fetchImpl: async () => new Response(JSON.stringify({ symbol: 'BTCUSDT', bidPrice, askPrice })) }), /SHADOW_PUBLIC_QUOTE_INVALID/);
  }
});

for (const elapsed of [60_000, 64_999, 65_000]) {
  test(`resolver accepts only real quote receipts inside inclusive window: ${elapsed}`, async () => {
    const result = await resolvePublicShadowQuote(anchor, { now: () => origin + elapsed, quoteFn: async () => quoteAt(elapsed) });
    assert.equal(result.status, 'observed');
  });
}

for (const elapsed of [59_999, 65_001, 600_000]) {
  test(`early/expired schedule never requests a quote to manufacture a label: ${elapsed}`, async () => {
    let requests = 0;
    const result = await resolvePublicShadowQuote(anchor, { now: () => origin + elapsed, quoteFn: async () => { requests++; return quoteAt(elapsed); } });
    assert.equal(result.status, elapsed < 60_000 ? 'not_due' : 'MARKOUT_HORIZON_EXPIRED');
    assert.equal(requests, 0);
  });
}

test('request finishing beyond deadline is expired even if it began inside the window', async () => {
  let time = 64_000;
  const result = await resolvePublicShadowQuote(anchor, { now: () => origin + time, quoteFn: async () => { time = 65_001; return quoteAt(time); } });
  assert.equal(result.status, 'MARKOUT_HORIZON_EXPIRED');
});

test('resolver rejects stale/foreign quote evidence instead of trusting callback timestamps', async () => {
  for (const market of [quoteAt(59_999), { ...quoteAt(60_000), source: 'https://example.com' }, { ...quoteAt(60_000), pair: 'ETH/USDT' }]) {
    assert.equal((await resolvePublicShadowQuote(anchor, { now: () => origin + 60_000, quoteFn: async () => market })).status, 'MARKOUT_DATA_INVALID');
  }
});

test('resolver timer can finish while an unrelated slow AI promise remains unresolved', async () => {
  let callback, time = origin, modelFinished = false;
  let finishModel;
  const model = new Promise(resolve => { finishModel = resolve; }).then(() => { modelFinished = true; });
  const outcomes = [];
  const resolver = createShadowQuoteResolver({ now: () => time, schedule: (fn, ms) => { assert.equal(ms, 60_000); callback = fn; return 1; }, unschedule: () => {},
    quoteFn: async () => quoteAt(60_000), onOutcome: async (_anchor, result) => outcomes.push(result) });
  resolver.sync([anchor]);
  time += 60_000;
  await callback();
  assert.equal(modelFinished, false);
  assert.equal(outcomes[0].status, 'observed');
  await resolver.drain();
  await resolver.stop();
  finishModel(); await model;
});

test('resolver timer delayed by process sleep records expired without fetching a late quote', async () => {
  let callback, time = origin, requests = 0, outcome;
  const resolver = createShadowQuoteResolver({ now: () => time, schedule: fn => { callback = fn; return 1; }, unschedule: () => {},
    quoteFn: async () => { requests++; return quoteAt(120_000); }, onOutcome: async (_anchor, value) => { outcome = value; } });
  resolver.sync([anchor]); time += 120_000; await callback();
  assert.equal(outcome.status, 'MARKOUT_HORIZON_EXPIRED');
  assert.equal(requests, 0);
  await resolver.stop();
});

test('STOP during drain cancels distant timers without waiting for the observation horizon', async () => {
  const jobs = new Map(); let id = 0, stop = false, requests = 0, outcomes = 0;
  const resolver = createShadowQuoteResolver({ now: () => origin, stopped: async () => stop,
    schedule: (fn, ms) => { jobs.set(++id, { fn, ms }); return id; }, unschedule: key => jobs.delete(key),
    quoteFn: async () => { requests++; return quoteAt(60_000); }, onOutcome: async () => { outcomes++; } });
  resolver.sync([anchor]);
  const draining = resolver.drain();
  await Promise.resolve(); await Promise.resolve();
  const poll = [...jobs.entries()].find(([, job]) => job.ms === 1_000);
  assert.ok(poll);
  stop = true; jobs.delete(poll[0]); await poll[1].fn(); await draining;
  assert.equal(requests, 0);
  assert.equal(outcomes, 0);
  assert.equal(jobs.size, 0);
  await resolver.stop();
});
