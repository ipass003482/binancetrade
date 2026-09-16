import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPausedEvidenceSampler} from '../src/paused-evidence.mjs';
const at=Date.parse('2026-09-11T00:00:00Z');
const state={mode:'demo',local:'unused',client:{},continuous:true,stopped:true,engineAvailable:true};

test('paused observation requires continuing Demo authorization, a pause and a working engine',async()=>{
 let calls=0;const tick=createPausedEvidenceSampler({forward:async()=>{calls++;},portfolio:async()=>{calls++;}});
 for(const patch of [{continuous:false},{stopped:false},{engineAvailable:false}])assert.equal(await tick({...state,...patch}),null);
 await assert.rejects(tick({...state,mode:'live'}),/DEMO_REQUIRED/);assert.equal(calls,0);
});

test('minute sampling keeps both modes visible and refreshes the shared portfolio once',async()=>{
 let time=at;const seen=[],tick=createPausedEvidenceSampler({now:()=>time,
  forward:async(local)=>{seen.push(local);return {asOf:new Date(time).toISOString(),validation:{evidenceComplete:true}};},
  portfolio:async()=>{seen.push('portfolio');return {asOf:new Date(time).toISOString(),evidenceComplete:true};}});
 const first=await tick({...state,local:'spot'});
 assert.equal(first.forward.evidenceComplete,true);assert.equal(first.portfolio.status,'refreshed');
 await tick({...state,mode:'demo-futures',local:'futures'});assert.deepEqual(seen,['spot','portfolio','futures']);
 time+=15000;assert.deepEqual(await tick({...state,local:'spot'}),first);assert.equal(seen.length,3);
 time=at+60000;await tick({...state,local:'spot'});assert.deepEqual(seen,['spot','portfolio','futures','spot','portfolio']);
});

test('failed forward reads do not suppress portfolio sampling or leak raw errors, and are throttled',async()=>{
 let time=at,reads=0,portfolios=0;const tick=createPausedEvidenceSampler({now:()=>time,
  forward:async()=>{reads++;throw Error('HISTORY_CHANGED: RAW_PRIVATE_TRANSPORT_DETAIL');},
  portfolio:async()=>{portfolios++;return {asOf:new Date(time).toISOString(),evidenceComplete:false};}});
 const first=await tick(state);assert.equal(first.forward.error,'HISTORY_CHANGED');assert.equal(first.portfolio.evidenceComplete,false);
 assert.equal(JSON.stringify(first).includes('RAW_PRIVATE'),false);
 time+=15000;await tick(state);assert.equal(reads,1);assert.equal(portfolios,1);
});

test('read-only sampling leaves the exact user STOP and submission journal untouched',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-paused-evidence-'));
 await writeFile(join(local,'STOP'),'operator pause\n');await writeFile(join(local,'orders.jsonl'),'immutable journal\n');
 const tick=createPausedEvidenceSampler({now:()=>at,forward:async path=>{
  assert.equal(path,local);return {asOf:new Date(at).toISOString(),validation:{evidenceComplete:true}};
 },portfolio:async()=>({asOf:new Date(at).toISOString(),evidenceComplete:true})});
 await tick({...state,local});
 assert.equal(await readFile(join(local,'STOP'),'utf8'),'operator pause\n');
 assert.equal(await readFile(join(local,'orders.jsonl'),'utf8'),'immutable journal\n');
});
