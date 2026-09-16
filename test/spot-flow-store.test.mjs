import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createSpotFlowStore} from '../src/spot-flow-store.mjs';
import {createSpotFlowObserverState} from '../src/spot-flow-observer.mjs';
import {FLOW_VERSION} from '../src/order-flow.mjs';

const B=Date.parse('2026-09-15T06:00:00Z');
function sample(at=B,{mode='demo',bid=100,ask=100.02}={}){
 const pair='ETH/USDT';
 const proof={version:FLOW_VERSION,mode,pair,source:'https://demo-api.binance.com',startTime:at-61500,endTime:at-1500,
  books:[-20000,-10000,0].map((offset,i)=>({at:at+offset,updateId:i+1,
   bids:Array.from({length:5},(_,k)=>[String(bid-(2-i)*.001-k*.001),'3']),
   asks:Array.from({length:5},(_,k)=>[String(ask-(2-i)*.001+k*.001),'1'])})),
  trades:[0,1,2].map(i=>({a:i+1,T:at-55000+i*25000,p:'100',q:'1',m:false}))};
 return {mode,collectorVersion:'test-only',markets:{[pair]:proof}};
}
async function fixture(t){
 const local=await mkdtemp(join(tmpdir(),'binance-spot-flow-store-test-'));
 t.after(async()=>{
  assert.ok(resolve(local).startsWith(resolve(tmpdir())+sep));
  assert.match(basename(local),/^binance-spot-flow-store-test-/);
  await rm(local,{recursive:true,force:true});
 });
 const directory=join(local,'spot-flow-research');
 return {local,directory,statePath:join(directory,'state.json'),logPath:join(directory,'observations-2026-09-15.jsonl'),statusPath:join(directory,'status.json')};
}
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const records=async path=>(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));

test('store persists prospective anchors and markouts; normal restart/replay never duplicates records',async t=>{
 const f=await fixture(t);let record=createSpotFlowStore(f.local);
 const first=await record(sample(),B);
 assert.equal(first.status,'observing');assert.equal(first.usedForEntries,false);assert.equal(first.totalRecords,1);
 assert.equal((await json(f.statePath)).observer.pending.length,3);
 const same=await record(sample(),B);assert.equal(same.recordsThisSample,0);assert.equal(same.diagnostics.duplicateObservations,1);
 record=createSpotFlowStore(f.local);
 assert.equal((await record(sample(),B)).totalRecords,1);
 const forward=await record(sample(B+60000,{bid:101,ask:101.02}),B+60000);
 assert.equal(forward.totalRecords,3);assert.equal(forward.recordsThisSample,2);
 const before=await readFile(f.logPath,'utf8');
 record=createSpotFlowStore(f.local);
 assert.equal((await record(sample(B+60000,{bid:101,ask:101.02}),B+60000)).recordsThisSample,0);
 assert.equal(await readFile(f.logPath,'utf8'),before);
 const rows=await records(f.logPath);
 assert.equal(new Set(rows.map(row=>row.recordId)).size,rows.length);
 const mark=rows.find(row=>row.kind==='hypotheticalQuoteMarkout');
 assert.equal(mark.status,'observed');assert.equal(mark.additionalCostBps,null);assert.equal(mark.afterAdditionalCostBps,null);
 assert.equal('pnl' in mark,false);assert.equal((await json(f.statusPath)).totalRecords,3);
});

test('persisted pending horizons expire as missing after downtime and are never recreated by restart',async t=>{
 const f=await fixture(t);await createSpotFlowStore(f.local)(sample(),B);
 const afterRestart=await createSpotFlowStore(f.local)({mode:'demo',markets:{}},B+1000000);
 assert.equal(afterRestart.totalRecords,4);assert.equal(afterRestart.recordsThisSample,3);
 const rows=await records(f.logPath),marks=rows.filter(row=>row.kind==='hypotheticalQuoteMarkout');
 assert.equal(marks.length,3);assert.ok(marks.every(row=>row.status==='missing'&&row.rawQuoteMarkoutBps===null&&row.observationProofSha256===null));
 const before=await readFile(f.logPath,'utf8');
 assert.equal((await createSpotFlowStore(f.local)({mode:'demo',markets:{}},B+1000001)).recordsThisSample,0);
 assert.equal(await readFile(f.logPath,'utf8'),before);assert.equal((await json(f.statePath)).observer.pending.length,0);
});

test('first startup does not backfill anchors from a still-fresh pre-start proof',async t=>{
 const f=await fixture(t),record=createSpotFlowStore(f.local);
 const start=await record(sample(B),B+10000);
 assert.equal(start.totalRecords,0);assert.equal(start.diagnostics.preStartObservations,1);
 assert.equal((await json(f.statePath)).observer.startedAt,B+10000);
 const next=await record(sample(B+10001),B+10001);
 assert.equal(next.totalRecords,1);assert.equal((await records(f.logPath))[0].sampledAt,B+10001);
});

test('non-demo modes are rejected without creating research files',async t=>{
 const f=await fixture(t),record=createSpotFlowStore(f.local);
 for(const mode of ['demo-futures','dry-run','live',undefined])await assert.rejects(record({mode,markets:{}},B),/SPOT_OBSERVER_MODE/);
 assert.deepEqual(await readdir(f.local),[]);
});

test('invalid persisted envelope is surfaced on every attempt and never silently repaired',async t=>{
 for(const corrupt of [s=>s.schemaVersion=2,s=>s.totalRecords=-1,s=>s.totalRecords=0.5]){
  const f=await fixture(t);await mkdir(f.directory,{recursive:true});
  const state={schemaVersion:1,observer:createSpotFlowObserverState({startedAt:B}),totalRecords:0};corrupt(state);
  const before=JSON.stringify(state);await writeFile(f.statePath,before,'utf8');const record=createSpotFlowStore(f.local);
  for(let i=0;i<2;i++)await assert.rejects(record({mode:'demo',markets:{}},B),/SPOT_OBSERVER_STATE/);
  assert.equal(await readFile(f.statePath,'utf8'),before);assert.deepEqual(await readdir(f.directory),['state.json']);
 }
});

test('corrupt JSON and invalid nested observer state surface instead of resetting or appending records',async t=>{
 const corruptJson=await fixture(t);await mkdir(corruptJson.directory,{recursive:true});
 await writeFile(corruptJson.statePath,'{"schemaVersion":','utf8');
 await assert.rejects(createSpotFlowStore(corruptJson.local)({mode:'demo',markets:{}},B));
 assert.equal(await readFile(corruptJson.statePath,'utf8'),'{"schemaVersion":');
 const f=await fixture(t);await createSpotFlowStore(f.local)(sample(),B);
 const state=await json(f.statePath);state.observer.pending[0].horizonMs=1;
 const before=JSON.stringify(state);await writeFile(f.statePath,before,'utf8');const logBefore=await readFile(f.logPath,'utf8');
 const record=createSpotFlowStore(f.local);
 for(let i=0;i<2;i++)await assert.rejects(record({mode:'demo',markets:{}},B+1000000),/OBSERVER_STATE.*INVALID/);
 assert.equal(await readFile(f.statePath,'utf8'),before);assert.equal(await readFile(f.logPath,'utf8'),logBefore);
});

test('an incomplete journal tail blocks appends after restart without modifying evidence, state or prior status',async t=>{
 const f=await fixture(t);await createSpotFlowStore(f.local)(sample(),B);
 const tail=(await readFile(f.logPath,'utf8'))+'{"recordId":"interrupted';
 await writeFile(f.logPath,tail,'utf8');
 const stateBefore=await readFile(f.statePath,'utf8'),statusBefore=await readFile(f.statusPath,'utf8');
 const record=createSpotFlowStore(f.local);
 for(let i=0;i<2;i++)await assert.rejects(record(sample(B+60000,{bid:101,ask:101.02}),B+60000),/OBSERVER_JOURNAL_INCOMPLETE/);
 assert.equal(await readFile(f.logPath,'utf8'),tail);
 assert.equal(await readFile(f.statePath,'utf8'),stateBefore);
 assert.equal(await readFile(f.statusPath,'utf8'),statusBefore);
});

test('a first tick with zero new records still rejects a torn journal and cannot publish healthy state',async t=>{
 const f=await fixture(t);await mkdir(f.directory,{recursive:true});
 const tail='{"recordId":"interrupted-before-state-save';await writeFile(f.logPath,tail,'utf8');
 const record=createSpotFlowStore(f.local);
 for(let i=0;i<2;i++)await assert.rejects(record({mode:'demo',markets:{}},B),/OBSERVER_JOURNAL_INCOMPLETE/);
 await assert.rejects(createSpotFlowStore(f.local)({mode:'demo',markets:{}},B),/OBSERVER_JOURNAL_INCOMPLETE/);
 assert.equal(await readFile(f.logPath,'utf8'),tail);
 assert.deepEqual(await readdir(f.directory),['observations-2026-09-15.jsonl']);
});
