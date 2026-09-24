// Public market data only. This module has no account or order dependencies.
import { jsonFetch } from './http.mjs';

export const SHADOW_QUOTE_SOURCE = 'https://data-api.binance.vision/api/v3/ticker/bookTicker';
export const SHADOW_RESOLVER_VERSION = 'post-decision-public-quote-v1';
export const SHADOW_QUOTE_TOLERANCE_MS = 5_000;

const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const amount = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

export async function collectPublicShadowQuote(pair, { fetchImpl = fetch, now = Date.now, timeoutMs = 3_000 } = {}) {
  if (typeof pair !== 'string' || !/^[A-Z0-9]+\/USDT$/.test(pair)) throw Error('SHADOW_PUBLIC_PAIR_INVALID');
  const started = now(), symbol = pair.replace('/', '');
  const book = await jsonFetch(SHADOW_QUOTE_SOURCE + '?symbol=' + symbol, { fetchImpl, timeoutMs });
  const received = now(), bid = amount(book.bidPrice), ask = amount(book.askPrice);
  if (book.symbol !== symbol || !(bid > 0) || !(ask >= bid) || !Number.isSafeInteger(started)
    || !Number.isSafeInteger(received) || received < started) throw Error('SHADOW_PUBLIC_QUOTE_INVALID');
  return { pair, source: SHADOW_QUOTE_SOURCE, requestStartedAt: new Date(started).toISOString(),
    quote: { bid: String(book.bidPrice), ask: String(book.askPrice), observedAt: new Date(received).toISOString() } };
}

export function shadowAnchorWindow(anchor) {
  const start = stamp(anchor?.anchorAt), target = stamp(anchor?.targetAt);
  if (start === null || target === null || !Number.isSafeInteger(anchor?.horizonMs)
    || anchor.horizonMs < 15_000 || anchor.horizonMs > 3_600_000 || target !== start + anchor.horizonMs
    || anchor.horizonToleranceMs !== SHADOW_QUOTE_TOLERANCE_MS) return null;
  return { start, target, deadline: target + SHADOW_QUOTE_TOLERANCE_MS };
}

export async function resolvePublicShadowQuote(anchor, { quoteFn = collectPublicShadowQuote, fetchImpl, now = Date.now } = {}) {
  const window = shadowAnchorWindow(anchor), at = now();
  const result = (status, market = null) => ({ status, market, recordedAt: new Date(now()).toISOString() });
  if (!window || at < window.start) return result('MARKOUT_ANCHOR_INVALID');
  if (at > window.deadline) return result('MARKOUT_HORIZON_EXPIRED');
  if (at < window.target) return result('not_due');
  try {
    const market = await quoteFn(anchor.pair, { fetchImpl, now, timeoutMs: Math.max(1, Math.min(3_000, window.deadline - at)) });
    if (now() > window.deadline) return result('MARKOUT_HORIZON_EXPIRED', market);
    const received = stamp(market?.quote?.observedAt), requested = stamp(market?.requestStartedAt);
    if (market?.source !== SHADOW_QUOTE_SOURCE || market?.pair !== anchor.pair || received === null || requested === null
      || requested < window.target || received < requested || received > now()
      || received < window.target || received > window.deadline) return result('MARKOUT_DATA_INVALID', market);
    return result('observed', market);
  } catch {
    return result(now() > window.deadline ? 'MARKOUT_HORIZON_EXPIRED' : 'MARKOUT_QUOTE_UNAVAILABLE');
  }
}

// Timers run independently of the strategy/LLM promise. The caller supplies a
// serialized onOutcome writer; no timer may independently overwrite state.
export function createShadowQuoteResolver({ onOutcome, now = Date.now, schedule = setTimeout, unschedule = clearTimeout,
  stopped = async () => false, ...options } = {}) {
  if (typeof onOutcome !== 'function') throw Error('SHADOW_RESOLVER_WRITER_REQUIRED');
  const tasks = new Map();
  let closed = false, failure = null;
  function register(anchor) {
    if (closed || tasks.has(anchor.id)) return;
    let finish;
    const task = { started: false, timer: null, done: new Promise(resolve => { finish = resolve; }) };
    tasks.set(anchor.id, task);
    const run = async () => {
      task.started = true;
      try {
        if (closed || await stopped()) return;
        const outcome = await resolvePublicShadowQuote(anchor, { ...options, now });
        if (outcome.status === 'not_due') {
          task.started = false;
          task.timer = schedule(run, Math.max(1, shadowAnchorWindow(anchor).target - now()));
          return;
        }
        await onOutcome(anchor, outcome);
      } catch (error) { failure ??= error; }
      finally {
        if (task.started) { tasks.delete(anchor.id); finish(); }
      }
    };
    task.timer = schedule(run, Math.max(0, (shadowAnchorWindow(anchor)?.target ?? now()) - now()));
    task.finish = finish;
  }
  async function stopAll() {
    closed = true;
    const active = [];
    for (const [id, task] of tasks) {
      if (task.started) active.push(task.done);
      else { unschedule(task.timer); tasks.delete(id); task.finish(); }
    }
    await Promise.all(active);
  }
  return {
    sync(anchors) { for (const anchor of anchors) register(anchor); },
    assertHealthy() { if (failure) throw failure; },
    async drain() {
      if (tasks.size === 0) { if (failure) throw failure; return; }
      let timer, finished = false;
      const checkStop = async () => {
        if (finished) return;
        try { if (await stopped()) { await stopAll(); return; } }
        catch (error) { failure ??= error; await stopAll(); return; }
        if (!finished) timer = schedule(checkStop, 1_000);
      };
      try { await checkStop(); await Promise.all([...tasks.values()].map(task => task.done)); }
      finally { finished = true; unschedule(timer); }
      if (failure) throw failure;
    },
    stop: stopAll
  };
}
