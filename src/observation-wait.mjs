// Only failures of read-only observation calls may defer a cycle. These codes
// do not relax validation or reuse a rejected observation. The watcher keeps
// its durable slot claim and collects everything again at its next normal slot.
const READ_STAGES = new Set(['account', 'costs', 'market']);
const TRANSPORT_CODES = new Set([
 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const HTTP_CODES = new Set(['HTTP_408', 'HTTP_425', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);

export function expectedObservationWait(error, { stage, executionStarted = false } = {}) {
 if (!READ_STAGES.has(stage) || executionStarted || error?.submissionStarted === true) return null;
 const code = error?.code ?? error?.message;
 let reason = null;
 if (stage === 'market' && code === 'CLOCK_RTT_REJECTED') reason = code;
 else if (stage === 'costs' && code === 'COST_PREFETCH_SLOT_EXPIRED') reason = code;
 else if (HTTP_CODES.has(code) || TRANSPORT_CODES.has(code)) reason = code;
 else if (error?.name === 'TimeoutError') reason = 'OBSERVATION_TIMEOUT';
 // Node fetch exposes transport failures as a TypeError with a structured
 // cause. Do not classify generic TypeErrors, arbitrary messages or aborts.
 else if (error instanceof TypeError && TRANSPORT_CODES.has(error.cause?.code)) reason = error.cause.code;
 if (!reason) return null;
 return { status: 'waiting', waitType: 'observation', reason, sourceStage: stage,
  retry: 'collect_fresh_next_cycle', entriesAllowed: false };
}
