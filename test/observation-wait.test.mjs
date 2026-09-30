import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expectedObservationWait } from '../src/observation-wait.mjs';
import { runCycle } from '../src/workflow.mjs';
import { recordFailure } from '../src/health.mjs';
import { claimDecisionBoundary } from '../src/candle-schedule.mjs';
import { writeJson,readJson,exists,journalAppend,journalRead } from '../src/io.mjs';
import { fixture } from './fixtures.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'binance-observation-wait-'));
const options=(f,local)=>({local,policy:f.policy,client:{snapshot:async()=>f.account},
 collectFn:async()=>f.snapshot,analyzeFn:async()=>({proposal:{...f.proposal,action:'hold',stakeUsdt:'0'}}),
 executeFn:async()=>({status:'hold'})});

test('an expired fee slot defers only the read-only costs stage; misuse and other stages remain faults',()=>{
 const expired=Error('COST_PREFETCH_SLOT_EXPIRED');
 assert.deepEqual(expectedObservationWait(expired,{stage:'costs'}),{status:'waiting',waitType:'observation',
  reason:'COST_PREFETCH_SLOT_EXPIRED',sourceStage:'costs',retry:'collect_fresh_next_cycle',entriesAllowed:false});
 for(const stage of [undefined,'account','market','analyzing','executing','persisting'])
  assert.equal(expectedObservationWait(expired,{stage}),null);
 assert.equal(expectedObservationWait(expired,{stage:'costs',executionStarted:true}),null);
 assert.equal(expectedObservationWait(Object.assign(Error(expired.message),{submissionStarted:true}),{stage:'costs'}),null);
 for(const code of ['COST_PREFETCH_CLOSED','COST_PREFETCH_ALREADY_CONSUMED','COST_PREFETCH_CONSUMPTION_IN_PROGRESS',
  'COST_PREFETCH_INVALID','COST_PREFETCH_SLOT_INVALID','COST_PREFETCH_SLOT_NOT_READY','COST_PREFETCH_SLOT_EXPIRED_EXTRA'])
  for(const stage of ['costs','account','market','executing'])assert.equal(expectedObservationWait(Error(code),{stage}),null);
});

test('transient observation failures require an exact read stage and an allowlisted cause',()=>{
 for(const stage of ['account','costs','market']){
  for(const error of [Error('HTTP_429'),Error('HTTP_503'),Object.assign(Error('socket reset'),{code:'ECONNRESET'}),
   new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}),new DOMException('request timeout','TimeoutError')]){
   const wait=expectedObservationWait(error,{stage});
   assert.equal(wait.status,'waiting');assert.equal(wait.entriesAllowed,false);
   assert.equal(wait.retry,'collect_fresh_next_cycle');assert.equal(wait.sourceStage,stage);
   assert.equal(expectedObservationWait(error,{stage,executionStarted:true}),null);
   assert.equal(expectedObservationWait(Object.assign(error,{submissionStarted:true}),{stage}),null);
  }
 }
 assert.equal(expectedObservationWait(Error('CLOCK_RTT_REJECTED'),{stage:'market'}).reason,'CLOCK_RTT_REJECTED');
 assert.equal(expectedObservationWait(Error('CLOCK_RTT_REJECTED'),{stage:'account'}),null);
 for(const stage of [undefined,'analyzing','executing','persisting'])
  assert.equal(expectedObservationWait(Error('HTTP_503'),{stage}),null);
 for(const error of [Error('CLOCK_SKEW_REJECTED'),Error('CLOCK_JUMP_DETECTED'),Error('CLOCK_INVALID'),
  Error('CLOCK_STALE'),Error('HTTP_401'),Error('HTTP_403'),Error('HTTP_429 sensitive details'),
  Error('SCHEMA_INVALID'),Error('UNRESOLVED_SUBMISSION'),new TypeError('fetch failed'),new DOMException('abort','AbortError')])
  assert.equal(expectedObservationWait(error,{stage:'market'}),null,error.message);
});

test('three slow clock observations defer without stopping, preserve intent evidence, and require a fresh cycle',async()=>{
 const local=await temp(),f=await fixture(),opts=options(f,local);
 const originalSuccess='2026-09-27T00:00:00.000Z';
 await writeJson(join(local,'health.json'),{lastSuccessAt:originalSuccess,lastCycleCompletedAt:originalSuccess,consecutiveFailures:0});
 const pending={id:'a'.repeat(32),at:new Date(f.now).toISOString(),status:'unknown',action:'buy'};
 await journalAppend(join(local,'orders.jsonl'),pending);
 let reads=0,analyses=0,executions=0;
 for(let n=0;n<3;n++){
  const boundary=Date.parse('2026-09-28T00:00:00Z')+n*60000;
  assert.equal(await claimDecisionBoundary(local,boundary,boundary+5000,'demo'),true);
  const result=await runCycle({...opts,scheduledDecisionBoundary:boundary,
   collectFn:async()=>{reads++;throw Error('CLOCK_RTT_REJECTED');},
   analyzeFn:async()=>{analyses++;throw Error('MUST_NOT_ANALYZE');},
   executeFn:async()=>{executions++;throw Error('MUST_NOT_EXECUTE');}});
  assert.equal(result.status,'waiting');assert.equal(result.waitType,'observation');
  assert.equal(result.reason,'CLOCK_RTT_REJECTED');assert.equal(result.entriesAllowed,false);
  assert.equal(await claimDecisionBoundary(local,boundary,boundary+6000,'demo'),false);
 }
 assert.equal(reads,3);assert.equal(analyses,0);assert.equal(executions,0);
 assert.equal(await exists(join(local,'STOP')),false);
 const waiting=await readJson(join(local,'health.json'));
 assert.equal(waiting.stage,'waiting_data');assert.equal(waiting.observationWait.reason,'CLOCK_RTT_REJECTED');
 assert.equal(waiting.consecutiveFailures,0);assert.equal(waiting.lastSuccessAt,originalSuccess);
 assert.equal(waiting.lastCycleCompletedAt,originalSuccess);
 assert.deepEqual(await journalRead(join(local,'orders.jsonl')),[pending]);
 const outcomes=await Promise.all((await readdir(join(local,'runs'))).filter(p=>p.endsWith('.outcome.json')).map(p=>readJson(join(local,'runs',p))));
 assert.equal(outcomes.length,3);assert.ok(outcomes.every(o=>o.status==='waiting'&&o.snapshotId===null&&o.entriesAllowed===false));
 // A clean observation must run collection again. This synthetic HOLD bypasses
 // no real bridge: unresolved journals remain untouched and block real entries.
 await runCycle({...opts,collectFn:async()=>{reads++;return f.snapshot;}});
 assert.equal(reads,4);
 const recovered=await readJson(join(local,'health.json'));
 assert.equal(recovered.observationWait,null);assert.equal(recovered.lastObservationError,null);
 assert.equal(recovered.lastDecisionStatus,'hold');assert.notEqual(recovered.lastSuccessAt,originalSuccess);
 assert.deepEqual(await journalRead(join(local,'orders.jsonl')),[pending]);
});

test('account and cost reads defer, while prior operational failures are never cleared by a deferred observation',async()=>{
 const local=await temp(),f=await fixture(),opts=options(f,local);
 await recordFailure(local,Error('UNRESOLVED_SUBMISSION'));
 for(const patch of [
  {client:{snapshot:async()=>{throw Error('HTTP_503');}}},
  {costsFn:async()=>{throw Object.assign(Error('reset'),{code:'ECONNRESET'});}},
 ])assert.equal((await runCycle({...opts,...patch})).status,'waiting');
 const h=await readJson(join(local,'health.json'));
 assert.equal(h.consecutiveFailures,1);assert.equal(h.lastError,'UNRESOLVED_SUBMISSION');
 assert.equal(await exists(join(local,'STOP')),false);
});

test('clock failures outside collection and repeated malformed clocks retain the persistent fault breaker',async()=>{
 for(const phase of ['execute','analyze','invalid_clock']){
  const local=await temp(),f=await fixture(),opts=options(f,local);
  const code=phase==='invalid_clock'?'CLOCK_INVALID':'CLOCK_RTT_REJECTED';
  const key=phase==='execute'?'executeFn':phase==='analyze'?'analyzeFn':'collectFn';
  for(let n=0;n<3;n++)await assert.rejects(runCycle({...opts,[key]:async()=>{throw Error(code);}}),new RegExp(code));
  assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,3);
  assert.equal((await readJson(join(local,'STOP'))).reason,'THREE_CONSECUTIVE_FAILURES');
 }
});

test('manual STOP and an aborted slow-clock cycle cannot turn into recoverable observation waits',async()=>{
 const local=await temp(),f=await fixture(),opts=options(f,local),stop={reason:'operator_pause'};
 await writeJson(join(local,'STOP'),stop);
 assert.equal((await runCycle({...opts,collectFn:async()=>{throw Error('MUST_NOT_READ');}})).status,'stopped');
 assert.deepEqual(await readJson(join(local,'STOP')),stop);
 const other=await temp(),abort=new AbortController();abort.abort();
 await assert.rejects(runCycle({...options(f,other),signal:abort.signal,collectFn:async()=>{throw Error('CLOCK_RTT_REJECTED');}}),/CLOCK_RTT_REJECTED/);
 assert.equal((await readJson(join(other,'health.json'))).stage,'aborted');
 assert.equal(await exists(join(other,'STOP')),false);
});
