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
test('Kev HOLD journals its reason, qualified count, freshness and selection audit without submitting',async()=>{
 const f=await context();f.snapshot.entryPolicyVersion='kev-order-flow-v1';
 f.proposal={...f.proposal,action:'hold',stakeUsdt:'0',reason:'KEV_NO_ELIGIBLE_ENTRY'};
 const decisionDiagnostics={version:'kev-decision-audit-v1',decisionStyle:'balanced',
  qualifiedCandidateCount:0,presentedCandidateCount:0,kevChoice:null,selectedPair:null,selectedAction:null,
  kevSelectedQualified:false,holdReason:'KEV_NO_ELIGIBLE_ENTRY',dataFreshness:[],candidatePool:{eligibleBeforeKev:0,blockers:[{reason:'FLOW_TAPE_BOOK_MISMATCH',count:2}]}};
 const result=await execute({...f,kevReview:{reason:'KEV_NO_ELIGIBLE_ENTRY',decisionDiagnostics}});
 assert.equal(result.status,'hold');assert.equal(f.calls,0);
 const [row]=await journalRead(join(f.local,'orders.jsonl'));
 assert.equal(row.status,'hold');assert.equal(row.kevReviewReason,'KEV_NO_ELIGIBLE_ENTRY');
 assert.equal(row.kevDecisionDiagnostics.qualifiedCandidateCount,0);
 assert.equal(row.kevDecisionDiagnostics.holdReason,'KEV_NO_ELIGIBLE_ENTRY');
 assert.equal(row.kevDecisionDiagnostics.candidatePool.blockers[0].reason,'FLOW_TAPE_BOOK_MISMATCH');
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
