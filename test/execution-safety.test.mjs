import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture,engineConfig,trendCandles } from './fixtures.mjs';
import { execute } from '../src/bridge.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { journalRead,readJson,exists } from '../src/io.mjs';
import { runCycle } from '../src/workflow.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'binance-submit-safety-'));
test('active entry rejection is recorded, consumes snapshot, and submits no order',async()=>{
 const f=await fixture(),local=await temp();let posts=0;
 f.snapshot.markets[0].candles=trendCandles(f.now,'short');
 const options={...f,local,now:()=>f.now,getQuote:async()=>f.executionQuote,
  client:{snapshot:async()=>f.account,submit:async()=>{posts++;}}};
 const r=await execute(options);
 assert.equal(r.status,'filtered');assert.ok(r.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));assert.equal(posts,0);
 assert.equal((await journalRead(join(local,'orders.jsonl'))).at(-1).status,'rejected');
 assert.equal((await readJson(join(local,'runs',f.snapshot.id+'.quality.json'))).eligible,false);
 await assert.rejects(execute(options),/ALREADY_CONSUMED/);
});

test('STOP during final identity read prevents the POST and records definite rejection',async()=>{
 const f=await fixture(),local=await temp(),engine=engineConfig(f.policy);let posts=0;
 const client=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{
  if(o.method==='POST')posts++;
  await writeFile(join(local,'STOP'),'operator pause');
  return new Response(JSON.stringify(engine));
 }});
 client.snapshot=async()=>({...f.account,engine});
 await assert.rejects(execute({...f,local,client,now:()=>f.now,getQuote:async()=>f.executionQuote}),/ENTRY_STOPPED_BEFORE_SEND/);
 assert.equal(posts,0);
 assert.deepEqual((await journalRead(join(local,'orders.jsonl'))).map(r=>r.status),['pending','rejected']);
});

test('local trading-disabled marker rejects entry before any quote or order request',async()=>{
 const f=await fixture(),local=await temp();await writeFile(join(local,'TRADING_DISABLED'),'LOCAL_TRADING_DISABLED=1');let quotes=0,posts=0;
 const client={snapshot:async()=>f.account,submit:async()=>{posts++;}};
 await assert.rejects(execute({...f,local,client,now:()=>f.now,getQuote:async()=>{quotes++;return f.executionQuote;}}),/LOCAL_TRADING_DISABLED/);
 assert.equal(quotes,0);assert.equal(posts,0);
 assert.equal((await journalRead(join(local,'orders.jsonl'))).at(-1).reason,'LOCAL_TRADING_DISABLED');
});

test('changed engine exit settings after analysis cannot inherit an earlier entry fingerprint',async()=>{
 const f=await fixture(),local=await temp(),engine={...engineConfig(f.policy),minimal_roi:{'0':0.03}};let posts=0;
 const client=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{
  if(o.method==='POST')posts++;
  return new Response(JSON.stringify({...engine,minimal_roi:{'0':0.01}}));
 }});
 client.snapshot=async()=>({...f.account,engine});
 await assert.rejects(execute({...f,local,client,now:()=>f.now,getQuote:async()=>f.executionQuote}),/STRATEGY_CHANGED_BEFORE_SEND/);
 assert.equal(posts,0);assert.equal((await journalRead(join(local,'orders.jsonl'))).at(-1).status,'rejected');
});

test('deadline is checked after asynchronous beforeSend work',async t=>{
 const f=await fixture();let clock=100,posts=0;
 t.mock.method(Date,'now',()=>clock);
 const client=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{
  if(o.method==='POST')posts++;return new Response(JSON.stringify(engineConfig(f.policy)));
 }});
 await assert.rejects(client.submit(f.proposal,'tag',null,{validUntil:200,beforeSend:async()=>{clock=201;}}),e=>
  e.message==='ORDER_DEADLINE_EXPIRED'&&e.submissionStarted===false);
 assert.equal(posts,0);
});

test('a transmitted request failure remains ambiguous',async()=>{
 const f=await fixture();
 const client=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{
  if(o.method==='POST')throw Error('TRANSPORT_FAILED');return new Response(JSON.stringify(engineConfig(f.policy)));
 }});
 await assert.rejects(client.submit(f.proposal,'tag'),e=>e.message==='TRANSPORT_FAILED'&&e.submissionStarted!==false);
});

test('three filtered strategy entries are completed decisions, not operational failures',async()=>{
 const local=await temp();let submits=0;
 for(let i=0;i<3;i++){
  const f=await fixture();f.snapshot.markets[0].candles=trendCandles(f.now,'short');
  const client={snapshot:async()=>f.account,submit:async()=>{submits++;}};
  const r=await runCycle({local,policy:f.policy,client,collectFn:async()=>f.snapshot,
   analyzeFn:async()=>({proposal:f.proposal}),executeFn:args=>execute({...args,getQuote:async()=>f.executionQuote})});
  assert.equal(r.result.status,'filtered');
 }
 assert.equal(submits,0);assert.equal(await exists(join(local,'STOP')),false);
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,0);
});
