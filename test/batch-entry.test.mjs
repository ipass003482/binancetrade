import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runEntryBatch,waitForNativeEntryProtection} from '../src/batch-entry.mjs';
import {entryId,entryArtifactStem,recordedEntryId,BATCH_EXECUTION_VERSION as V} from '../src/entry-identity.mjs';
import {decisionRows} from '../src/report.mjs';
const id='00000000-0000-4000-8000-000000000001',pairs=['BTC/USDT','ETH/USDT','SOL/USDT'];
const proposal=pair=>({snapshotId:id,pair,action:'buy',stakeUsdt:'10'});
function fixture(){
 const events=[],saved=new Map(),snapshot={id},policy={mode:'demo',pairs};
 let count=0;
 return {events,saved,snapshot,policy,local:'unused',reference:{proposal:proposal(pairs[0])},
  save:async(p,v)=>saved.set(p,structuredClone(v)),
  waitForProtection:async({account})=>account,
  client:{snapshot:async()=>{events.push('account');return {count:++count};}},
  executeFn:async a=>{events.push(a.proposal.pair);assert.equal(a.executionPolicyVersion,V);assert.equal(a.snapshot,snapshot);return {status:'submitted'};},
  select:(s,p,a,m,{excludedPairs})=>{assert.equal(a.count,excludedPairs.length);return {proposal:proposal(pairs.find(p=>!excludedPairs.includes(p))??pairs[0])};}};
}
test('pair identities are stable, distinct, legacy compatible and fail closed',()=>{
 assert.equal(entryId(id,pairs[0]),createHash('sha256').update(id).digest('hex').slice(0,32));
 assert.equal(entryId(id,pairs[0],V),createHash('sha256').update(JSON.stringify([V,id,pairs[0]])).digest('hex').slice(0,32));
 assert.notEqual(entryId(id,pairs[0],V),entryId(id,pairs[1],V));
 assert.equal(entryArtifactStem(id,pairs[0]),id);
 assert.throws(()=>entryId(id,pairs[0],'unknown'));assert.throws(()=>entryId('../bad',pairs[0],V));
 assert.throws(()=>entryId(id,'../../bad',V));assert.equal(recordedEntryId({snapshotId:id,pair:pairs[0],executionPolicyVersion:'bad'}),null);
});
test('batch serializes distinct pairs, refreshes account and saves separate artifacts',async()=>{
 const f=fixture(),r=await runEntryBatch(f);assert.equal(r.submittedCount,3);
 assert.deepEqual(f.events,[pairs[0],'account',pairs[1],'account',pairs[2],'account']);
 assert.equal([...f.saved.keys()].filter(p=>p.endsWith('.proposal.json')).length,2);
 assert.equal([...f.saved.values()].find(v=>v.version===V).status,'completed');
});
test('capacity exhaustion after confirmed first response prevents a second attempt',async()=>{
 const f=fixture();f.select=()=>({proposal:{action:'hold'}});
 const r=await runEntryBatch(f);assert.equal(r.submittedCount,1);assert.deepEqual(f.events,[pairs[0],'account']);
});
test('normal quote rejection allows another eligible pair without claiming rejection was submitted',async()=>{
 const f=fixture();let n=0;f.executeFn=async()=>({status:n++?'submitted':'filtered',reasons:n===1?['COST_SHORTFALL']:[]});
 const r=await runEntryBatch(f);assert.equal(r.submittedCount,2);assert.deepEqual(r.reasons,['COST_SHORTFALL']);
});
test('ambiguous response stops batch and preserves previous confirmed submission',async()=>{
 const f=fixture();let n=0;f.executeFn=async()=>{if(n++)throw Error('UNRESOLVED_SUBMISSION');return {status:'submitted'};};
 await assert.rejects(runEntryBatch(f),/UNRESOLVED_SUBMISSION/);assert.equal(n,2);
 const v=[...f.saved.values()].find(v=>v.version===V);assert.equal(v.status,'interrupted');assert.equal(v.attempts[0].status,'submitted');
});
test('unknown result and duplicate pair fail closed; abort sends nothing',async()=>{
 const f=fixture();f.executeFn=async()=>({status:'unknown'});await assert.rejects(runEntryBatch(f),/BATCH_UNEXPECTED_OUTCOME/);assert.deepEqual(f.events,[]);
 const d=fixture();d.select=()=>d.reference;await assert.rejects(runEntryBatch(d),/BATCH_DUPLICATE_PAIR/);
 const a=fixture();a.signal={aborted:true};await assert.rejects(runEntryBatch(a),/CYCLE_ABORTED/);assert.deepEqual(a.events,[]);
});
test('decision report associates two pair tags from the same snapshot independently',()=>{
 const records=pairs.slice(0,2).flatMap((pair,i)=>{const x=entryId(id,pair,V);return [{id:x,tag:'codex-'+x,snapshotId:id,pair,executionPolicyVersion:V,status:'pending'},{id:x,status:'submitted',tradeId:i+1}];});
 const trades=pairs.slice(0,2).map((pair,i)=>({pair,enter_tag:'codex-'+entryId(id,pair,V),trade_id:i+1,is_open:true}));
 assert.deepEqual(decisionRows(pairs.slice(0,2).map(proposal),records,trades).map(r=>r.tradeIds),[[1],[2]]);
});

test('freshly filled entry waits for verified native protection and refreshes account',async()=>{
 let elapsed=0,calls=0,reads=0;
 const result=await waitForNativeEntryProtection({account:{generation:0},client:{snapshot:async()=>({generation:++reads})},policy:{mode:'demo'},
  check:async()=>{if(++calls<3)throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');},
  now:()=>elapsed,pause:async ms=>{elapsed+=ms;}});
 assert.equal(calls,3);assert.equal(reads,2);assert.equal(result.generation,2);assert.equal(elapsed,1000);
});

test('unprotected timeout retries reconciliation but invalid protection never approves more orders',async()=>{
 let elapsed=0;
 await assert.rejects(waitForNativeEntryProtection({account:{},client:{snapshot:async()=>({})},policy:{mode:'demo'},
  check:async()=>{throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');},now:()=>elapsed,pause:async ms=>{elapsed+=ms;}}),/NATIVE_ENTRY_PROTECTION_TIMEOUT/);
 assert.equal(elapsed,10000);
 let transientElapsed=0,transientCalls=0;
 const transient=await waitForNativeEntryProtection({account:{generation:0},client:{snapshot:async()=>({generation:++transientCalls})},policy:{mode:'demo'},
  check:async()=>{if(++transientCalls<3)throw Error('NATIVE_PROTECTION_RECONCILIATION_REQUIRED');},now:()=>transientElapsed,pause:async ms=>{transientElapsed+=ms;}});
 assert.equal(transient.generation,2);
 for(const reason of ['NATIVE_PROTECTION_ACTIVE_PROOF_INVALID','NATIVE_PROTECTION_READINESS_STALE']){
  await assert.rejects(waitForNativeEntryProtection({account:{},policy:{mode:'demo'},check:async()=>{throw Error(reason);},pause:async()=>assert.fail('must not retry')}),new RegExp(reason));
 }
 const f=fixture();f.waitForProtection=async()=>{throw Error('NATIVE_ENTRY_PROTECTION_TIMEOUT');};
 await assert.rejects(runEntryBatch(f),/NATIVE_ENTRY_PROTECTION_TIMEOUT/);
 assert.deepEqual(f.events,[pairs[0],'account']);
 const saved=[...f.saved.values()].find(v=>v.version===V);assert.equal(saved.status,'interrupted');assert.equal(saved.attempts[0].status,'submitted');
});

test('abort during protection wait cannot start another account read or submission',async()=>{
 const signal={aborted:false};let reads=0;
 await assert.rejects(waitForNativeEntryProtection({account:{},client:{snapshot:async()=>{reads++;}},policy:{mode:'demo'},signal,
  check:async()=>{throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');},pause:async()=>{signal.aborted=true;}}),/CYCLE_ABORTED/);
 assert.equal(reads,0);
});

test('next selection starts only after protection; filtered entries do not wait',async()=>{
 const f=fixture();let waits=0;
 f.waitForProtection=async({account})=>{f.events.push('protected');waits++;return account;};
 await runEntryBatch(f);
 assert.equal(waits,3);assert.deepEqual(f.events,pairs.flatMap(p=>[p,'account','protected']));
 const rejected=fixture();rejected.executeFn=async()=>({status:'filtered'});rejected.waitForProtection=async()=>assert.fail('no filled entry');
 await runEntryBatch(rejected);
});

test('a later batch entry cannot reintroduce a Kev-vetoed pair or obtain a new review',async()=>{
 const f=fixture();f.kevReview={enabled:true,approvedPairs:[pairs[0],pairs[2]]};
 f.select=(s,p,a,m,{excludedPairs})=>({proposal:excludedPairs.includes(pairs[2])?{action:'hold'}:proposal(pairs[2])});
 const execute=f.executeFn;
 f.executeFn=async args=>{assert.equal(args.kevReview,f.kevReview);return execute(args);};
 const result=await runEntryBatch(f);
 assert.equal(result.submittedCount,2);assert.deepEqual(f.events,[pairs[0],'account',pairs[2],'account']);
});
