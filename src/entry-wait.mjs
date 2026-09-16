import { isEntry } from './mode.mjs';

// Only these deterministic, pre-submission risk decisions are expected waits.
// Do not pattern-match arbitrary PORTFOLIO_* errors: unavailable evidence and
// ambiguous submissions must remain operational failures.
export const EXPECTED_ENTRY_WAIT_CODES = Object.freeze([
 'ENTRY_RATE_LIMIT', 'DAILY_LOSS_LIMIT', 'POSITION_ALREADY_EXISTS',
 'POSITION_LIMIT', 'EXPOSURE_LIMIT', 'INSUFFICIENT_BALANCE', 'NOTIONAL_LIMIT',
 'PORTFOLIO_EXPOSURE_LIMIT', 'PORTFOLIO_NOTIONAL_LIMIT', 'PORTFOLIO_POSITION_LIMIT',
 'PORTFOLIO_DAILY_LOSS_LIMIT', 'PORTFOLIO_ENTRY_RATE_LIMIT',
 'PORTFOLIO_DIRECTION_CONFLICT', 'PORTFOLIO_GROSS_EXPOSURE_LIMIT',
 'PORTFOLIO_OPEN_RISK_LIMIT', 'PORTFOLIO_CAPITAL_LIMIT',
 'PORTFOLIO_OPPOSITE_POSITION', 'PORTFOLIO_DUPLICATE_POSITION', 'PORTFOLIO_DRAWDOWN_LIMIT', 'PORTFOLIO_BUSY',
]);
const dailyCodes = new Set(['ENTRY_RATE_LIMIT', 'DAILY_LOSS_LIMIT',
 'PORTFOLIO_DAILY_LOSS_LIMIT', 'PORTFOLIO_ENTRY_RATE_LIMIT']);
export function nextUtcDay(now = Date.now()) {
 if (!Number.isFinite(now)) throw Error('INVALID_WAIT_TIME');
 const date = new Date(now);
 if (!Number.isFinite(date.getTime())) throw Error('INVALID_WAIT_TIME');
 return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}
export function expectedEntryWait(error, { now = Date.now() } = {}) {
 const reason = error?.code ?? error?.message;
 if (error?.submissionStarted === true || !EXPECTED_ENTRY_WAIT_CODES.includes(reason)) return null;
 if (reason === 'PORTFOLIO_DRAWDOWN_LIMIT') return {
  status: 'waiting', reason, resetAt: null, retry: 'operator_review_required', reviewRequired: true,
 };
 return { status: 'waiting', reason, resetAt: dailyCodes.has(reason) ? nextUtcDay(now) : null,
  retry: dailyCodes.has(reason) ? 'reevaluate_each_cycle_and_after_utc_reset' : 'reevaluate_next_cycle' };
}
export function dailyEntryAllowance(records, policy, now = Date.now()) {
 const resetAt = nextUtcDay(now), date = new Date(now).toISOString().slice(0, 10);
 const limit = policy?.maxEntriesPerDay;
 if (!Array.isArray(records) || !Number.isInteger(limit) || limit < 0) throw Error('ENTRY_ALLOWANCE_STATE_INVALID');
 let used = 0;
 for (const record of records) {
  if (record?.status !== 'pending' || !isEntry(record.action)) continue;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) throw Error('ENTRY_ALLOWANCE_STATE_INVALID');
  // Count every persisted submission intent, including execution probes and
  // intents later rejected or reconciled. This deliberately preserves the
  // existing conservative rate limit rather than refunding attempts.
  if (new Date(record.at).toISOString().slice(0, 10) === date) used++;
 }
 return { date, used, limit, remaining: limit === 0 ? null : Math.max(0, limit - used),
  unlimited: limit === 0, resetAt, includesExecutionProbes: true };
}
