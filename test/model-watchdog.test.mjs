import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, unlink, rm} from 'node:fs/promises';
import {join, dirname, basename, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {SETTINGS, SOURCE_FILES, verifyIdentity, classifyProcesses, validateBudget,
 decideRecovery, recoveryCycle, atomicJson, createRuntime} from '../src/model-watchdog.mjs';

// Synthetic Windows process evidence and injected I/O only. Never launch a worker.
const ROOT = 'C:\\desk';
const NOW = Date.parse('2026-09-14T08:00:00Z');
const PIN = 'a'.repeat(64);
const iso = at => new Date(at).toISOString();
const copy = value => structuredClone(value);
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map((path, index) => [path, String(index + 1).repeat(64)]));
function identityInput() {
 const hashes = sourceHashes();
 return {loaded: {schemaVersion: 1, model: 'kronos-small-pretrained-v1', pretrained: true,
  fineTuned: false, fingerprint: PIN, loadedAt: iso(NOW - 3600000), implementation: {...hashes}},
 execution: {schemaVersion: 1, model: 'kronos-small-pretrained-v1', modelFingerprint: PIN, enabled: true},
 computedFingerprint: PIN, sourceHashes: hashes};
}
function processRow({pid = 101, parentPid = 10, runtime = false, createdAt = NOW - 120000, ...extra} = {}) {
 const executablePath = runtime ? `${ROOT}\\.runtime\\python\\python.exe` : `${ROOT}\\.venv-model\\Scripts\\python.exe`;
 return {pid, parentPid, name: 'python.exe', executablePath,
  commandLine: `"${executablePath}" -u "${ROOT}\\scripts\\kronos-worker.py" watch`,
  createdAt: iso(createdAt), ...extra};
}
function ledger(attempts = []) {
 return {schemaVersion: 1, modelFingerprint: PIN, createdAt: iso(NOW - 7200000), attempts};
}
function attempt(index, ageMs, status = 'failed') {
 return {id: index.toString(16).padStart(64, '0'), at: iso(NOW - ageMs), status};
}
function observation(extra = {}) {
 return {now: NOW, root: ROOT, identity: verifyIdentity(identityInput()), processes: [processRow()],
  status: {pid: 101, at: iso(NOW - 5000), modelFingerprint: PIN, usedForOrders: false,
   states: ['demo', 'demo-futures'].map(mode => ({mode, status: 'awaiting_next_cycle',
    sourceFreshness: {lastSourceBoundary: NOW - 300000, sourceAgeLowerMs: 299000, sourceAgeUpperMs: 300000}}))},
  budget: ledger(), stops: {watchdog: false, model: false, demo: false, 'demo-futures': false}, ...extra};
}
const missing = () => observation({processes: [], status: null});
function harness(observations = [missing(), missing()], hooks = {}) {
 const calls = [], budgets = [], events = [], publications = [];
 let index = 0;
 const io = {
  async observe() { calls.push('observe'); const value = observations[index++]; return typeof value === 'function' ? value() : copy(value); },
  async saveBudget(value) { calls.push(`save:${value.attempts.at(-1)?.status}`); if (hooks.saveBudget) await hooks.saveBudget(value); budgets.push(copy(value)); },
  async archive(id, observed) { calls.push('archive'); assert.equal(budgets.at(-1)?.attempts.at(-1)?.status, 'reserved');
   return hooks.archive ? hooks.archive(id, observed) : 'synthetic-archive'; },
  async launch() { calls.push('launch'); return hooks.launch ? hooks.launch() : {status: 'started', pid: 202}; },
  async event(value) { calls.push('event'); events.push(copy(value)); },
  async publish(value, at) { calls.push('publish'); publications.push({value: copy(value), at}); }
 };
 return {io, calls, budgets, events, publications};
}

test('identity accepts the frozen pretrained pin and all four exact implementation hashes', () => {
 const input = identityInput(), result = verifyIdentity(input);
 assert.equal(result.fingerprint, PIN);
 assert.equal(result.executionEnabled, true);
 assert.deepEqual(result.sourceHashes, input.sourceHashes);
});

test('identity rejects disagreement with recomputed core fingerprint or execution pin', () => {
 for (const mutate of [i => { i.computedFingerprint = 'b'.repeat(64); },
  i => { i.execution.modelFingerprint = 'b'.repeat(64); }, i => { i.loaded.fingerprint = 'not-a-hash'; }]) {
  const input = identityInput(); mutate(input);
  assert.throws(() => verifyIdentity(input), /WATCHDOG_IDENTITY_INVALID/);
 }
});

test('identity rejects changed model semantics and malformed load timestamps', () => {
 for (const mutate of [i => { i.loaded.pretrained = false; }, i => { i.loaded.fineTuned = true; },
  i => { i.loaded.model = 'other-model'; }, i => { i.execution.enabled = 'true'; },
  i => { i.loaded.schemaVersion = 2; }]) {
  const input = identityInput(); mutate(input);
  assert.throws(() => verifyIdentity(input), /WATCHDOG_IDENTITY_INVALID/);
 }
 const input = identityInput(); input.loaded.loadedAt = '2026-09-14 08:00:00';
 assert.throws(() => verifyIdentity(input), /WATCHDOG_TIME_INVALID/);
});

test('identity rejects changed, omitted, extra, or nonhex source hashes', () => {
 for (const mutate of [i => { i.sourceHashes[SOURCE_FILES[0]] = 'b'.repeat(64); },
  i => { delete i.sourceHashes[SOURCE_FILES[1]]; }, i => { i.sourceHashes['extra.py'] = PIN; },
  i => { delete i.loaded.implementation[SOURCE_FILES[0]]; },
  i => { i.loaded.implementation[SOURCE_FILES[0]] = i.sourceHashes[SOURCE_FILES[0]] = 'z'.repeat(64); }]) {
  const input = identityInput(); mutate(input);
  assert.throws(() => verifyIdentity(input), /WATCHDOG_SOURCE_CHANGED/);
 }
});

test('process classification accepts an exact Windows venv launcher and runtime child as one chain', () => {
 const result = classifyProcesses([processRow(), processRow({pid: 102, parentPid: 101, runtime: true})], ROOT);
 assert.equal(result.unambiguous, true); assert.equal(result.alive, true);
 assert.equal(result.leafPid, 102); assert.deepEqual(result.pids, [101, 102]);
});

test('process classification accepts a single worker and ignores unrelated Python', () => {
 const unrelated = processRow({pid: 88, executablePath: 'C:\\other\\python.exe', commandLine: 'python other.py'});
 const result = classifyProcesses([unrelated, processRow()], ROOT);
 assert.equal(result.unambiguous, true); assert.deepEqual(result.pids, [101]); assert.equal(result.leafPid, 101);
 assert.equal(classifyProcesses([], ROOT).alive, false);
});

test('process classification rejects impostor executables and extra command arguments', () => {
 for (const patch of [{executablePath: 'C:\\other\\python.exe'}, {name: 'powershell.exe'},
  {commandLine: `"${ROOT}\\.venv-model\\Scripts\\python.exe" -u "${ROOT}\\scripts\\kronos-worker.py" watch --extra`},
  {commandLine: `"${ROOT}\\.venv-model\\Scripts\\python.exe" -u "${ROOT}\\scripts\\kronos-worker.py" watch; other`},
  {executablePath: `${ROOT}\\.runtime\\python-impostor\\python.exe`}]) {
  const result = classifyProcesses([processRow(patch)], ROOT);
  assert.equal(result.unambiguous, false); assert.equal(result.exact.length, 0);
 }
});

test('process classification blocks multiple chains, duplicate PIDs, and unreadable project commands', () => {
 assert.equal(classifyProcesses([processRow(), processRow({pid: 102})], ROOT).unambiguous, false);
 assert.equal(classifyProcesses([processRow(), processRow({pid: 102, parentPid: 101}),
  processRow({pid: 103, parentPid: 102})], ROOT).unambiguous, false);
 assert.throws(() => classifyProcesses([processRow(), processRow()], ROOT), /WATCHDOG_PROCESS_INVENTORY_INVALID/);
 const unreadable = classifyProcesses([processRow({commandLine: null})], ROOT);
 assert.equal(unreadable.unambiguous, false);
 assert.equal(unreadable.ambiguous[0].reason, 'unreadable_python_identity');
 assert.equal(classifyProcesses([processRow({commandLine: null, executablePath: null})], ROOT).unambiguous, false);
});

test('healthy requires matching live PID, fresh heartbeat, and fresh sources', () => {
 const result = decideRecovery(observation());
 assert.equal(result.status, 'healthy'); assert.equal(result.restart, false);
 assert.equal(result.heartbeat.pidMatches, true); assert.equal(result.source.demo.stale, false);
 assert.equal(result.source.demo.ageLowerMs, 304000); assert.equal(result.source.demo.ageUpperMs, 305000);
 const clockOffset = observation(); clockOffset.status.states[0].sourceFreshness.lastSourceBoundary = NOW + 300000;
 assert.equal(decideRecovery(clockOffset).status, 'healthy', 'producer clock bounds govern source age, not local boundary subtraction');
});

test('confirmed dead or missing worker requests recovery even if an old heartbeat file exists', () => {
 for (const status of [null, observation().status]) {
  const result = decideRecovery(observation({processes: [], status}));
  assert.equal(result.restart, true); assert.equal(result.reason, 'confirmed_no_worker_process');
 }
});

test('alive but missing, stale, or mismatched heartbeat degrades without launching a duplicate', () => {
 for (const status of [null, {...observation().status, at: iso(NOW - SETTINGS.heartbeatStaleMs - 1)},
  {...observation().status, pid: 999}, {...observation().status, at: iso(NOW - 180000)}]) {
  const result = decideRecovery(observation({status}));
  assert.equal(result.status, 'degraded'); assert.equal(result.restart, false);
  assert.equal(result.reason, 'alive_missing_or_stale_model_heartbeat');
 }
});

test('newly created live worker receives startup grace but no second launch', () => {
 const result = decideRecovery(observation({processes: [processRow({createdAt: NOW - 1000})], status: null}));
 assert.equal(result.status, 'starting'); assert.equal(result.restart, false);
});

test('stale or missing source evidence degrades a live worker without restarting it', () => {
 for (const freshness of [{lastSourceBoundary: NOW - SETTINGS.sourceStaleMs - 1,
  sourceAgeLowerMs: SETTINGS.sourceStaleMs, sourceAgeUpperMs: SETTINGS.sourceStaleMs + 1}, {}]) {
  const state = observation(); state.status.states[0].sourceFreshness = freshness;
  const result = decideRecovery(state);
  assert.equal(result.status, 'degraded'); assert.equal(result.reason, 'model_source_stale');
  assert.equal(result.restart, false);
 }
});

test('explicit null source boundary is unavailable evidence, never a healthy timestamp', () => {
 const state = observation(); state.status.states[0].sourceFreshness = {
  lastSourceBoundary: null, sourceAgeLowerMs: null, sourceAgeUpperMs: null};
 const result = decideRecovery(state);
 assert.equal(result.status, 'degraded'); assert.equal(result.reason, 'model_source_stale');
 assert.equal(result.source.demo.lastSourceBoundary, null);
 assert.equal(result.source.demo.ageMs, null); assert.equal(result.restart, false);
});

test('unavailable, stale, or partial producer outcomes are not healthy merely because the heartbeat is fresh', () => {
 for (const patch of [{status: 'unavailable'}, {status: 'stale_source'},
  {status: 'predicted', errors: [{reason: 'MODEL_PROVIDER_CANDLE_REVISED'}]}]) {
  const state = observation(); Object.assign(state.status.states[0], patch);
  const result = decideRecovery(state);
  assert.equal(result.status, 'degraded'); assert.equal(result.reason, 'model_prediction_unavailable_or_partial');
  assert.equal(result.restart, false);
 }
 for (const mutate of [s => { s.status.states.push(copy(s.status.states[0])); },
  s => { s.status.states[0].status = 'unknown'; }]) {
  const state = observation(); mutate(state);
  assert.throws(() => decideRecovery(state), /WATCHDOG_MODEL_STATUS_INVALID/);
 }
});

test('watchdog STOP, model STOP, both mode STOPs, and execution disable pause recovery', () => {
 for (const patch of [{watchdog: true}, {model: true}, {demo: true, 'demo-futures': true}]) {
  const state = missing(); Object.assign(state.stops, patch);
  const result = decideRecovery(state); assert.equal(result.status, 'paused'); assert.equal(result.restart, false);
 }
 const state = missing(); state.identity.executionEnabled = false;
 assert.equal(decideRecovery(state).reason, 'execution_disabled');
});

test('one stopped mode still allows the other mode to recover and ignores stopped-mode stale source', () => {
 for (const mode of ['demo', 'demo-futures']) {
  const absent = missing(); absent.stops[mode] = true;
  assert.equal(decideRecovery(absent).restart, true);
  const alive = observation(); alive.stops[mode] = true;
  alive.status.states.find(state => state.mode === mode).sourceFreshness = {};
  assert.equal(decideRecovery(alive).status, 'healthy');
 }
});

test('ambiguous process inventory prevents recovery even with no accepted worker', () => {
 const result = decideRecovery(observation({processes: [processRow({commandLine: null})], status: null}));
 assert.equal(result.status, 'degraded'); assert.equal(result.reason, 'ambiguous_worker_process');
 assert.equal(result.restart, false);
});

test('persisted attempts enforce backoff, including failed and cancelled attempts', () => {
 for (const status of ['reserved', 'started', 'already_present', 'failed', 'cancelled']) {
  const state = missing(); state.budget.attempts = [attempt(1, SETTINGS.restartBackoffMs - 1, status)];
  const result = decideRecovery(state); assert.equal(result.status, 'backoff'); assert.equal(result.restart, false);
 }
 const state = missing(); state.budget.attempts = [attempt(1, SETTINGS.restartBackoffMs)];
 assert.equal(decideRecovery(state).restart, true);
});

test('restart budget survives watchdog restarts and releases only expired attempts', () => {
 const state = missing(); state.budget.attempts = [attempt(1, 300000), attempt(2, 200000), attempt(3, 100000)];
 const blocked = decideRecovery(copy(state));
 assert.equal(blocked.status, 'blocked'); assert.equal(blocked.reason, 'restart_budget_exhausted');
 state.budget.attempts[0].at = iso(NOW - SETTINGS.restartWindowMs);
 assert.equal(decideRecovery(state).restart, true);
});

test('future or malformed persisted budget fails closed rather than resetting the ledger', () => {
 for (const mutate of [b => { b.createdAt = iso(NOW + 1); }, b => { b.attempts = [attempt(1, -1)]; },
  b => { b.attempts = [attempt(1, 1000), attempt(1, 500)]; },
  b => { b.attempts = [attempt(1, 500), attempt(2, 1000)]; }, b => { b.attempts = [attempt(1, 1000, 'unknown')]; }]) {
  const budget = ledger(); mutate(budget);
  assert.throws(() => validateBudget(budget, NOW), /WATCHDOG_(?:BUDGET_INVALID|BUDGET_CLOCK_REVERSED)/);
 }
 const state = missing(); state.budget.modelFingerprint = 'b'.repeat(64);
 assert.throws(() => decideRecovery(state), /WATCHDOG_PIN_CHANGED/);
});

test('future heartbeat, invalid source timestamps, and order-authority status fail closed', () => {
 for (const mutate of [s => { s.status.at = iso(NOW + 1); },
  s => { s.status.states[0].sourceFreshness.lastSourceBoundary = -1; },
  s => { s.status.states[0].sourceFreshness.lastSourceBoundary = 'not-a-time'; },
  s => { s.status.states[0].sourceFreshness.sourceAgeUpperMs = 0; },
  s => { s.status.states[0].sourceFreshness.sourceAgeLowerMs = null; },
  s => { s.status.usedForOrders = true; }, s => { s.processes[0].createdAt = iso(NOW + 1); }]) {
  const state = observation(); mutate(state);
  assert.throws(() => decideRecovery(state), /WATCHDOG_(?:MODEL_STATUS_FUTURE|MODEL_SOURCE_INVALID|MODEL_STATUS_INVALID|PROCESS_TIME_FUTURE)/);
 }
});

test('healthy recovery cycle only publishes and never reserves, archives, or launches', async () => {
 const h = harness([observation()]); const result = await recoveryCycle(h.io);
 assert.equal(result.status, 'healthy'); assert.deepEqual(h.calls, ['observe', 'publish']);
});

test('recovery durably charges budget before archive, reobserves, then launches and records receipt', async () => {
 const h = harness(); const result = await recoveryCycle(h.io);
 assert.deepEqual(h.calls, ['observe', 'save:reserved', 'archive', 'observe', 'launch', 'save:started', 'event', 'publish']);
 assert.equal(h.budgets[0].attempts.length, 1); assert.equal(h.budgets[1].attempts.length, 1);
 assert.equal(h.budgets[0].attempts[0].id, h.budgets[1].attempts[0].id);
 assert.equal(result.status, 'recovery_requested'); assert.equal(result.restart, false);
 assert.equal(result.reason, 'await_fresh_process_identity_and_heartbeat');
});

test('budget persistence failure prevents archival and launch; archive failure consumes the reservation', async () => {
 const diskError = Object.assign(new Error('disk full'), {code: 'ENOSPC'});
 const unsaved = harness(undefined, {saveBudget: async () => { throw diskError; }});
 await assert.rejects(recoveryCycle(unsaved.io), {code: 'ENOSPC'});
 assert.deepEqual(unsaved.calls, ['observe', 'save:reserved']);
 const archiveFailure = harness(undefined, {archive: async () => { throw diskError; }});
 const result = await recoveryCycle(archiveFailure.io);
 assert.equal(result.status, 'recovery_failed'); assert.equal(result.reason, 'WATCHDOG_IO_ENOSPC');
 assert.equal(archiveFailure.budgets.at(-1).attempts[0].status, 'failed');
 assert.equal(archiveFailure.calls.includes('launch'), false);
});

test('STOP or newly present PID during archive cancels launch and keeps the charged attempt', async () => {
 const stopped = missing(); stopped.stops.model = true;
 for (const fresh of [stopped, observation(), observation({processes: [processRow({pid: 999})], status: null})]) {
  const h = harness([missing(), fresh]); const result = await recoveryCycle(h.io);
  assert.equal(result.status, 'recovery_cancelled'); assert.equal(result.restart, false);
  assert.equal(h.calls.includes('launch'), false);
  assert.equal(h.budgets.at(-1).attempts[0].status, 'cancelled');
 }
});

test('changed model pin or failed source verification on reobserve prevents launch and charges failure', async () => {
 const changed = missing(); changed.identity.fingerprint = 'b'.repeat(64);
 for (const fresh of [changed, () => { throw new Error('WATCHDOG_SOURCE_CHANGED'); }]) {
  const h = harness([missing(), fresh]); const result = await recoveryCycle(h.io);
  assert.equal(result.status, 'recovery_failed'); assert.equal(h.calls.includes('launch'), false);
  assert.match(result.reason, /WATCHDOG_(?:PIN_CHANGED|SOURCE_CHANGED)/);
  assert.equal(h.budgets.at(-1).attempts[0].status, 'failed');
 }
});

test('failed, ambiguous, or STOP-raced launch consumes budget without automatically retrying', async () => {
 for (const launch of [async () => { throw new Error('private transport failure'); },
  async () => { throw new Error('WATCHDOG_STOP_BEFORE_LAUNCH'); },
  async () => null, async () => ({status: 'started'}), async () => ({status: 'already_present', pids: []})]) {
  const h = harness(undefined, {launch}); const result = await recoveryCycle(h.io);
  assert.equal(result.status, 'recovery_failed'); assert.equal(h.calls.filter(call => call === 'launch').length, 1);
  assert.equal(h.budgets.at(-1).attempts[0].status, 'failed');
  assert.equal(JSON.stringify(result).includes('private transport failure'), false);
  const afterRestart = missing(); afterRestart.now += 1000; afterRestart.budget = h.budgets.at(-1);
  assert.equal(decideRecovery(afterRestart).status, 'backoff');
 }
 const already = harness(undefined, {launch: async () => ({status: 'already_present', pids: [202, 203]})});
 assert.equal((await recoveryCycle(already.io)).status, 'recovery_requested');
 assert.equal(already.budgets.at(-1).attempts[0].status, 'already_present');
});

test('atomic JSON retries transient Windows sharing errors using one exclusive temp file', async () => {
 const calls = [], path = `${ROOT}\\local\\watchdog-status.json`; let moves = 0, temp;
 await atomicJson(path, {status: 'healthy'}, {
  makeDir: async () => { calls.push('mkdir'); },
  write: async (name, contents, options) => { calls.push('write'); temp = name;
   assert.notEqual(name, path); assert.deepEqual(JSON.parse(contents), {status: 'healthy'});
   assert.equal(options.flag, 'wx'); assert.equal(options.mode, 0o600); assert.equal(options.flush, true); },
  move: async (from, to) => { calls.push('move'); assert.equal(from, temp); assert.equal(to, path);
   if (moves++ < 3) throw Object.assign(new Error('sharing'), {code: ['EPERM', 'EACCES', 'EBUSY'][moves - 1]}); },
  wait: async ms => { calls.push(ms); }, remove: async () => { calls.push('remove'); }
 });
 assert.deepEqual(calls, ['mkdir', 'write', 'move', 25, 'move', 50, 'move', 100, 'move']);
});

test('atomic JSON does not conceal permanent errors or retry sharing failures indefinitely', async () => {
 for (const code of ['ENOSPC', 'EBUSY']) {
  let moves = 0, writes = 0; const waits = [];
  await assert.rejects(atomicJson(`${ROOT}\\status.json`, {}, {makeDir: async () => {},
   write: async () => { writes++; }, move: async () => { moves++; throw Object.assign(new Error('fail'), {code}); },
   wait: async ms => { waits.push(ms); }, remove: async () => {}}), {code});
  assert.equal(writes, 1); assert.equal(moves, code === 'ENOSPC' ? 1 : 6);
  assert.deepEqual(waits, code === 'ENOSPC' ? [] : [25, 50, 100, 200, 400]);
 }
});

test('startup read failure cannot create a false prior ledger, check is read-only, and a lost established ledger blocks', async t => {
 const temporaryRoot = await mkdtemp(join(tmpdir(), 'binancetrade-watchdog-test-'));
 t.after(async () => {
  const checked = resolve(temporaryRoot);
  assert.equal(dirname(checked), resolve(tmpdir()));
  assert.ok(basename(checked).startsWith('binancetrade-watchdog-test-'));
  await rm(checked, {recursive: true, force: true});
 });
 const input = identityInput();
 for (const path of SOURCE_FILES) {
  const content = `synthetic source for ${path}\n`, target = join(temporaryRoot, path);
  await mkdir(dirname(target), {recursive: true}); await writeFile(target, content);
  input.loaded.implementation[path] = createHash('sha256').update(content).digest('hex');
 }
 const modelDirectory = join(temporaryRoot, 'local', 'model-research');
 await mkdir(modelDirectory, {recursive: true});
 await writeFile(join(modelDirectory, 'loaded-model.json'), JSON.stringify(input.loaded));
 await writeFile(join(temporaryRoot, 'config', 'model-execution.json'), JSON.stringify(input.execution));
 let executions = 0;
 const runtime = createRuntime({root: temporaryRoot, now: () => NOW,
  powershell: async () => [], exec: async (file, args) => {
   assert.ok(file.endsWith('python.exe')); assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']);
   if (++executions === 1) throw new Error('synthetic initial identity read failure');
   return {stdout: JSON.stringify({computedFingerprint: PIN})};
  }});
 const base = join(temporaryRoot, 'local', 'model-watchdog'), budgetPath = join(base, 'budget.json');
 await assert.rejects(runtime.observe(), /synthetic initial identity read failure/);
 await assert.rejects(runtime.publish({status: 'blocked'}, NOW), /WATCHDOG_BUDGET_UNINITIALIZED/);
 await assert.rejects(stat(base), {code: 'ENOENT'});
 assert.equal((await runtime.observe({readOnly: true})).budget.attempts.length, 0);
 await assert.rejects(stat(base), {code: 'ENOENT'});
 await runtime.observe();
 assert.equal(JSON.parse(await readFile(budgetPath, 'utf8')).modelFingerprint, PIN);
 await runtime.publish({status: 'missing', restart: true}, NOW);
 assert.equal(JSON.parse(await readFile(join(base, 'status.json'), 'utf8')).orderAuthority, 'none');
 await unlink(budgetPath);
 await assert.rejects(runtime.observe(), /WATCHDOG_PERSISTED_BUDGET_MISSING/);
 await assert.rejects(stat(budgetPath), {code: 'ENOENT'});
 assert.equal(executions, 2, 'all process invocations are identity-only stubs; no worker launch occurs');
});
