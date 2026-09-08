import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../src/bridge.mjs';
import { journalRead } from '../src/io.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { fixture,engineConfig } from './fixtures.mjs';
async function context() {
 const f=await fixture();let calls=0;
 const local=await mkdtemp(join(tmpdir(),'binance-trade-test-'));
 const client={snapshot:async()=>f.account,submit:async(p,tag)=>{calls++;return {trade_id:1,pair:p.pair,enter_tag:tag};}};
 return {...f,now:()=>f.now,local,client,getQuote:async()=>f.executionQuote,get calls(){return calls;}};
}
test('successful request is persisted and same snapshot cannot be replayed',async()=>{
 const f=await context();assert.equal((await execute(f)).status,'submitted');
 await assert.rejects(execute(f),/ALREADY_CONSUMED/);assert.equal(f.calls,1);
 const r=await journalRead(join(f.local,'orders.jsonl'));assert.deepEqual(r.map(x=>x.status),['pending','submitted']);
});
test('timeout is unknown, blocks retries AND later snapshots',async()=>{
 const f=await context();f.client.submit=async()=>{throw new Error('Timeout');};
 await assert.rejects(execute(f),/Timeout/);
 f.snapshot.id=crypto.randomUUID();f.proposal.snapshotId=f.snapshot.id;
 await assert.rejects(execute(f),/UNRESOLVED/);
 assert.equal((await journalRead(join(f.local,'orders.jsonl'))).at(-1).status,'unknown');
});
test('parallel submissions cannot both enter',async()=>{
 const f=await context();
 const r=await Promise.allSettled([execute(f),execute(f)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls,1);
});
test('corrupt journal stops all submissions',async()=>{
 const f=await context();await writeFile(join(f.local,'orders.jsonl'),'{"partial":');
 await assert.rejects(execute(f),/JOURNAL_INCOMPLETE/);assert.equal(f.calls,0);
});
test('a STOP arriving while reading account prevents the request',async()=>{
 const f=await context();f.client.snapshot=async()=>{await writeFile(join(f.local,'STOP'),'stop');return f.account;};
 await assert.rejects(execute(f),/ENTRY_STOPPED/);assert.equal(f.calls,0);
});
test('invalid success body is unknown, never blindly accepted',async()=>{
 const f=await context();f.client.submit=async()=>({status:'maybe'});
 await assert.rejects(execute(f),/UNEXPECTED/);
 assert.equal((await journalRead(join(f.local,'orders.jsonl'))).at(-1).status,'unknown');
});
for(const field of ['dry_run','bot_name','strategy','runmode','exchange','stoploss','position_adjustment_enable']){
 test('engine identity rejects '+field,async()=>{
  const f=await fixture(),c=engineConfig(f.policy);
  c[field]=field==='dry_run'?false:field==='stoploss'?-0.8:field==='position_adjustment_enable'?true:'wrong';
  let writes=0;
  const client=new FreqtradeClient(f.policy,{username:'test',password:'test'},{fetchImpl:async(u,o)=>{
   if(o.method==='POST')writes++;return new Response(JSON.stringify(c),{status:200});
  }});
  await assert.rejects(client.submit(f.proposal,'test'),/ENGINE_IDENTITY/);assert.equal(writes,0);
 });
}
