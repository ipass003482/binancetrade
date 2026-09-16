import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expectedEntryWait,dailyEntryAllowance } from '../src/entry-wait.mjs';
import { runCycle } from '../src/workflow.mjs';
import { assess } from '../src/risk.mjs';
import { journalAppend,journalRead,readJson,exists } from '../src/io.mjs';
import { fixture } from './fixtures.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'binance-entry-wait-'));
const options=(f,local)=>({local,policy:f.policy,client:{snapshot:async()=>f.account},
 collectFn:async()=>f.snapshot,analyzeFn:async()=>({proposal:f.proposal})});
async function exhaustedIntents(local,f){
 const records=[];
 for(let n=0;n<f.policy.maxEntriesPerDay;n++){
  const id=(n+1).toString(16).padStart(32,'0'),at=new Date(f.now).toISOString();
  records.push({id,at,status:'pending',action:'buy',purpose:n===0?'execution_probe':'strategy'},
   {id,at,status:n===1?'rejected':'submitted'});
 }
 for(const record of records)await journalAppend(join(local,'orders.jsonl'),record);
 return records;
}

test('three exhausted daily entry decisions stay waiting without stopping the scheduler',async()=>{
 const local=await temp(),first=await fixture(),records=await exhaustedIntents(local,first);
 for(let n=0;n<3;n++){
  const f=await fixture();
  const result=await runCycle({...options(f,local),executeFn:async()=>assess({...f,records})});
  assert.equal(result.status,'waiting');assert.equal(result.result.status,'waiting');
  assert.equal(result.reason,'ENTRY_RATE_LIMIT');
  assert.equal(result.result.dailyEntryAllowance.remaining,0);
  const outcome=await readJson(join(local,'runs',f.snapshot.id+'.outcome.json'));
  assert.equal(outcome.status,'waiting');assert.equal(outcome.reason,'ENTRY_RATE_LIMIT');
  assert.equal(outcome.resetAt,dailyEntryAllowance(records,f.policy).resetAt);
 }
 const health=await readJson(join(local,'health.json'));
 assert.equal(health.consecutiveFailures,0);assert.equal(health.lastError,null);
 assert.equal(health.entryWait.reason,'ENTRY_RATE_LIMIT');
 assert.equal(await exists(join(local,'STOP')),false);
 assert.deepEqual(await journalRead(join(local,'orders.jsonl')),records);
});

test('next UTC day restores daily entry allowance without deleting submission history',async()=>{
 const local=await temp(),f=await fixture(),records=await exhaustedIntents(local,f);
 const today=dailyEntryAllowance(records,f.policy,f.now);
 const tomorrow=Date.parse(today.resetAt)+1000,iso=new Date(tomorrow).toISOString();
 const next=dailyEntryAllowance(records,f.policy,tomorrow);
 assert.equal(next.used,0);assert.equal(next.remaining,f.policy.maxEntriesPerDay);
 f.now=tomorrow;f.snapshot.createdAt=iso;f.snapshot.markets[0].fetchedAt=iso;f.executionQuote.fetchedAt=iso;
 f.account.daily.data=[{date:iso.slice(0,10),abs_profit:0}];
 assert.equal(assess({...f,records,now:tomorrow}).action,'buy');
 assert.equal(records.length,f.policy.maxEntriesPerDay*2);
});

test('daily rate allowance includes probes and rejected pending intents, but excludes exits and HOLD',()=>{
 const at='2026-09-10T12:00:00.000Z',now=Date.parse(at),policy={maxEntriesPerDay:4};
 const records=[{id:'a',at,status:'pending',action:'buy',purpose:'execution_probe'},
  {id:'a',at,status:'rejected'},{id:'b',at,status:'pending',action:'open-short'},
  {id:'b',at,status:'submitted'},{id:'c',at,status:'pending',action:'sell'},
  {id:'d',at,status:'hold',action:'hold'}];
 assert.deepEqual(dailyEntryAllowance(records,policy,now),{date:'2026-09-10',used:2,limit:4,
  remaining:2,unlimited:false,resetAt:'2026-09-11T00:00:00.000Z',includesExecutionProbes:true});
 assert.equal(dailyEntryAllowance(records,{maxEntriesPerDay:0},now).remaining,null);
 assert.throws(()=>dailyEntryAllowance([{status:'pending',action:'buy',at:'invalid'}],policy,now),/INVALID/);
});

test('daily loss waits have a reevaluation date, while a drawdown latch requires review',()=>{
 const now=Date.parse('2026-09-10T23:59:59.000Z');
 for(const code of ['DAILY_LOSS_LIMIT','PORTFOLIO_DAILY_LOSS_LIMIT']){
  assert.equal(expectedEntryWait(Error(code),{now}).resetAt,'2026-09-11T00:00:00.000Z');
 }
 const drawdown=expectedEntryWait(Error('PORTFOLIO_DRAWDOWN_LIMIT'),{now});
 assert.equal(drawdown.resetAt,null);assert.equal(drawdown.reviewRequired,true);
 assert.equal(drawdown.retry,'operator_review_required');
 assert.equal(expectedEntryWait(Error('PORTFOLIO_BUSY'),{now}).retry,'reevaluate_next_cycle');
 for(const code of ['UNRESOLVED_SUBMISSION','PORTFOLIO_UNRESOLVED_SUBMISSION','PORTFOLIO_DATA_STALE',
  'PORTFOLIO_NEW_UNKNOWN_LIMIT','SCHEMA_INVALID','STALE_EXECUTION_QUOTE','ENTRY_RATE_LIMIT: HTTP response']){
  assert.equal(expectedEntryWait(Error(code),{now}),null,code);
 }
 assert.equal(expectedEntryWait(Object.assign(Error('ENTRY_RATE_LIMIT'),{submissionStarted:true})),null);
});

test('three real execution faults still STOP and are never recast as risk waits',async()=>{
 const local=await temp();
 for(let n=0;n<3;n++){
  const f=await fixture();
  await assert.rejects(runCycle({...options(f,local),executeFn:async()=>{throw Error('STALE_EXECUTION_QUOTE');}}),/STALE_EXECUTION_QUOTE/);
 }
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,3);
 assert.equal((await readJson(join(local,'STOP'))).reason,'THREE_CONSECUTIVE_FAILURES');
});

test('a matching risk error cannot clear an ambiguous submission journal',async()=>{
 const local=await temp(),f=await fixture();
 const record={id:'a'.repeat(32),at:new Date(f.now).toISOString(),status:'pending',action:'buy'};
 await journalAppend(join(local,'orders.jsonl'),record);
 await assert.rejects(runCycle({...options(f,local),executeFn:async()=>{throw Error('ENTRY_RATE_LIMIT');}}),/UNRESOLVED_SUBMISSION/);
 assert.deepEqual(await journalRead(join(local,'orders.jsonl')),[record]);
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,1);
});

test('risk-shaped errors outside entry execution remain operational faults',async()=>{
 const local=await temp(),f=await fixture();
 await assert.rejects(runCycle({...options(f,local),analyzeFn:async()=>{throw Error('POSITION_LIMIT');}}),/POSITION_LIMIT/);
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,1);
});
