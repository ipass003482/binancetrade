import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDecisionCostPrefetch,DECISION_COST_PREFETCH_LEAD_MS} from '../src/decision-cost-prefetch.mjs';
import {entryCost} from '../src/trading-costs.mjs';
import {closeBufferMs} from '../src/candle-schedule.mjs';
import {runCycle} from '../src/workflow.mjs';
import {RULE_ENGINE_VERSION} from '../src/decision.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson,writeJson,exists} from '../src/io.mjs';
import {fixture} from './fixtures.mjs';

const B=Date.parse('2026-09-28T06:00:00Z'),M=60000,route={entryPolicyVersion:'kev-order-flow-v1'};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const slot=(mode='demo-futures',boundary=B)=>({policy:{mode,pairs:['BTC/USDT'],risk:{max:10}},boundary,
 collectionAt:boundary+closeBufferMs(mode,route)});
const facts=(mode,observedAt)=>({schemaVersion:1,mode,kind:'costs',source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
 readOnly:true,observedAt:new Date(observedAt).toISOString(),rates:[{pair:'BTC/USDT',status:'ok',buyRate:'0.001',sellRate:'0.001'}]});

test('each existing 05/30 phase starts one read in the 10 s lead and consumes its original facts once',async()=>{
 assert.equal(DECISION_COST_PREFETCH_LEAD_MS,10000);
 for(const mode of ['demo','demo-futures']){
  const input=slot(mode),value=facts(mode,input.collectionAt-5000),calls=[];
  let at=input.collectionAt-10001;
  const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async policy=>{calls.push(policy);return value;}});
  assert.equal(prefetch.prepare(input),false);
  at++;assert.equal(prefetch.prepare(input),true);assert.equal(prefetch.prepare(input),false);
  await turn();at=input.collectionAt-1;assert.equal(prefetch.prepare(input),false);
  assert.deepEqual(calls,[input.policy]);at=input.collectionAt;
  assert.equal(prefetch.prepare(input),false);
  assert.equal(await prefetch.consume(input),value);assert.equal(calls.length,1);
  assert.equal(value.observedAt,new Date(input.collectionAt-5000).toISOString());
  await assert.rejects(prefetch.consume(input),/COST_PREFETCH_ALREADY_CONSUMED/);
  await prefetch.drain();
 }
});

test('policy is captured synchronously and equivalent key ordering does not duplicate a read',async()=>{
 const input=slot(),original=structuredClone(input.policy),calls=[];
 let at=input.collectionAt-10000;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async policy=>{calls.push(policy);return {read:1};}});
 assert.equal(prefetch.prepare(input),true);
 input.policy.mode='demo';input.policy.risk.max=999;input.policy.pairs.push('ETH/USDT');
 await turn();assert.deepEqual(calls,[original]);at=input.collectionAt;
 const reordered={risk:{max:10},pairs:['BTC/USDT'],mode:'demo-futures'};
 assert.deepEqual(await prefetch.consume({...input,policy:reordered}),{read:1});assert.equal(calls.length,1);
 await prefetch.drain();
});

test('startup inside a slot falls back to exactly one fresh costs read',async()=>{
 const input=slot(),value=facts(input.policy.mode,input.collectionAt);let calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>input.collectionAt,readCosts:async()=>{calls++;return value;}});
 assert.equal(await prefetch.consume(input),value);assert.equal(calls,1);
 await assert.rejects(prefetch.consume(input),/COST_PREFETCH_ALREADY_CONSUMED/);
 await prefetch.drain();
});

test('a different mode, full policy, boundary or collection phase drains old work and reads fresh',async()=>{
 for(const change of [
  input=>({...input,policy:{...input.policy,mode:'demo'}}),
  input=>({...input,policy:{...input.policy,risk:{max:9}}}),
  input=>({...input,policy:{...input.policy,pairs:['ETH/USDT']}}),
  input=>slot(input.policy.mode,B+M),
  input=>({...input,collectionAt:input.collectionAt+1000}),
 ]){
  const input=slot(),next=change(structuredClone(input)),old=deferred(),calls=[];
  let at=input.collectionAt-10000,active=0,peak=0;
  const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async policy=>{
   calls.push(policy);active++;peak=Math.max(peak,active);
   try{return calls.length===1?await old.promise:{fresh:true,mode:policy.mode};}finally{active--;}
  }});
  assert.equal(prefetch.prepare(input),true);await turn();at=next.collectionAt;
  const consuming=prefetch.consume(next);await turn();assert.equal(calls.length,1);
  old.resolve({old:true});assert.deepEqual(await consuming,{fresh:true,mode:next.policy.mode});
  assert.deepEqual(calls,[input.policy,next.policy]);assert.equal(peak,1);
  await prefetch.drain();
 }
});

test('a missed decision cannot consume old facts, and the next decision gets a new read',async()=>{
 const input=slot(),next=slot('demo-futures',B+M);let at=input.collectionAt-10000,calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>({read:++calls})});
 prefetch.prepare(input);await turn();at=B+M;
 await assert.rejects(prefetch.consume(input),/COST_PREFETCH_SLOT_EXPIRED/);assert.equal(calls,1);
 at=next.collectionAt-10000;assert.equal(prefetch.prepare(next),true);await turn();at=next.collectionAt;
 assert.deepEqual(await prefetch.consume(next),{read:2});assert.equal(calls,2);await prefetch.drain();
});

test('a pending matched result that arrives after the minute deadline is rejected',async()=>{
 const input=slot(),pending=deferred();let at=input.collectionAt-10000,calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:()=>{calls++;return pending.promise;}});
 prefetch.prepare(input);await turn();at=input.collectionAt;
 const consuming=prefetch.consume(input),rejection=assert.rejects(consuming,/COST_PREFETCH_SLOT_EXPIRED/);
 at=B+M;pending.resolve({late:true});await rejection;assert.equal(calls,1);
 await prefetch.drain();
});

test('an obsolete pending read cannot trigger a fresh read after its replacement slot has expired',async()=>{
 const input=slot(),next=slot('demo-futures',B+M),pending=deferred();let at=input.collectionAt-10000,calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:()=>{calls++;return pending.promise;}});
 prefetch.prepare(input);await turn();at=next.collectionAt;
 const consuming=prefetch.consume(next),rejection=assert.rejects(consuming,/COST_PREFETCH_SLOT_EXPIRED/);
 at=B+2*M;pending.resolve({old:true});await rejection;assert.equal(calls,1);await prefetch.drain();
});

test('concurrent changed-slot consumption cannot overlap fee reads or replace the in-use job',async()=>{
 const input=slot(),next=slot('demo-futures',B+M),pending=deferred();let at=input.collectionAt-10000,calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>++calls===1?await pending.promise:{read:calls}});
 prefetch.prepare(input);await turn();at=next.collectionAt;
 const consuming=prefetch.consume(next);
 await assert.rejects(prefetch.consume({...next,policy:{...next.policy,risk:{max:9}}}),/COST_PREFETCH_CONSUMPTION_IN_PROGRESS/);
 assert.equal(prefetch.prepare(slot('demo',B+2*M)),false);
 pending.resolve({old:true});assert.deepEqual(await consuming,{read:2});assert.equal(calls,2);await prefetch.drain();
});

test('failed speculative reads are handled immediately and surface the original error only when consumed',async()=>{
 const input=slot(),failure=Object.assign(Error('reset'),{code:'ECONNRESET'}),unhandled=[];
 let at=input.collectionAt-10000;
 const listener=error=>unhandled.push(error);process.on('unhandledRejection',listener);
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>{throw failure;}});
 try{
  assert.equal(prefetch.prepare(input),true);await turn();await turn();assert.deepEqual(unhandled,[]);
  at=input.collectionAt;await assert.rejects(prefetch.consume(input),error=>error===failure);
  await prefetch.drain();assert.deepEqual(unhandled,[]);
 }finally{process.removeListener('unhandledRejection',listener);}
});

test('STOP drains failed read-only work and never starts a fallback or permits later consumption',async()=>{
 const input=slot(),pending=deferred();let at=input.collectionAt-10000,calls=0,drained=false;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:()=>{calls++;return pending.promise;}});
 prefetch.prepare(input);await turn();const draining=prefetch.drain().then(()=>{drained=true;});
 await turn();assert.equal(drained,false);at=input.collectionAt;
 await assert.rejects(prefetch.consume(input),/COST_PREFETCH_CLOSED/);assert.equal(prefetch.prepare(input),false);
 pending.reject(Error('HTTP_503'));await draining;assert.equal(drained,true);assert.equal(calls,1);
});

test('STOP during consumption waits for the read but suppresses its result',async()=>{
 const input=slot(),pending=deferred();let at=input.collectionAt-10000;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:()=>pending.promise});
 prefetch.prepare(input);await turn();at=input.collectionAt;
 const consuming=prefetch.consume(input),rejection=assert.rejects(consuming,/COST_PREFETCH_CLOSED/),draining=prefetch.drain();
 pending.resolve({costs:true});await Promise.all([rejection,draining]);
});

test('original fact age and unavailability are preserved for the existing cost validation',async()=>{
 const input=slot(),costConfig={maxAgeSeconds:300,slippageBpsPerSide:1,priceSpaceBufferBps:5,fundingReserveEvents:1};
 let at=input.collectionAt-10000;
 const original=facts(input.policy.mode,input.collectionAt-301000),before=structuredClone(original);
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>original});
 prefetch.prepare(input);await turn();at=input.collectionAt;const result=await prefetch.consume(input);
 assert.deepEqual(original,before);assert.equal(result,original);
 assert.deepEqual(entryCost(result,{pair:'BTC/USDT',spreadBps:1,fundingRate:'0'},input.policy.mode,costConfig,at),
  {status:'unavailable',reason:'COST_SAMPLE_STALE'});await prefetch.drain();
 const unavailable={mode:input.policy.mode,status:'unavailable',reason:'HTTP_503'};
 const other=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>unavailable});
 assert.equal(await other.consume(input),unavailable);await other.drain();
});

test('unsupported modes, invalid boundaries, early consumption and invalid clocks fail closed',async()=>{
 const input=slot();let at=input.collectionAt-10000,calls=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>{calls++;return {};}});
 for(const invalid of [
  {...input,policy:{mode:'dry-run'}},{...input,policy:{mode:'live'}},{...input,boundary:B+1},
  {...input,boundary:0},{...input,collectionAt:B-1},{...input,collectionAt:B+M},
 ])assert.throws(()=>prefetch.prepare(invalid),/COST_PREFETCH_SLOT_INVALID/);
 await assert.rejects(prefetch.consume(input),/COST_PREFETCH_SLOT_NOT_READY/);
 at=NaN;assert.equal(prefetch.prepare(input),false);await assert.rejects(prefetch.consume(input),/COST_PREFETCH_SLOT_NOT_READY/);
 assert.equal(calls,0);await prefetch.drain();
});

test('a prefetched transport failure is reported at the workflow costs stage without review, execution or STOP',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-cost-prefetch-')),f=await fixture(),policy=await loadPolicy('demo');
 const input={...slot('demo'),policy},failure=Object.assign(Error('reset'),{code:'ECONNRESET'});let at=input.collectionAt-10000;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>{throw failure;}});
 try{
  prefetch.prepare(input);await turn();at=input.collectionAt;
  let downstream=0;
  const forbidden=async()=>{downstream++;throw Error('MUST_NOT_PROCEED');};
  const result=await runCycle({local,policy,client:{snapshot:async()=>({...f.account,engine:{strategy_version:RULE_ENGINE_VERSION}})},
   costsFn:actualPolicy=>prefetch.consume({...input,policy:actualPolicy}),kevConfigFn:async()=>({enabled:false}),
   collectFn:forbidden,analyzeFn:forbidden,kevReviewFn:forbidden,executeFn:forbidden});
  assert.equal(result.status,'waiting');assert.equal(result.waitType,'observation');assert.equal(result.entriesAllowed,false);
  assert.equal((await readJson(join(local,'health.json'))).observationWait.sourceStage,'costs');
  assert.equal(downstream,0);assert.equal(await exists(join(local,'STOP')),false);
 }finally{await prefetch.drain();await rm(local,{recursive:true,force:true});}
});

test('three slow fee reads discard expired results without a persistent STOP, then recollect at the next normal slot',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-cost-expiry-')),f=await fixture(),policy=await loadPolicy('demo');
 const originalSuccess='2026-09-27T00:00:00.000Z';let at=B,pending,reads=0,marketReads=0,downstream=0;
 const prefetch=createDecisionCostPrefetch({now:()=>at,readCosts:async()=>{reads++;return pending.promise;}});
 const forbidden=async()=>{downstream++;throw Error('MUST_NOT_PROCEED');};
 try{
  await writeJson(join(local,'health.json'),{lastSuccessAt:originalSuccess,lastCycleCompletedAt:originalSuccess,consecutiveFailures:0});
  for(let n=0;n<4;n++){
   const input={...slot('demo',B+n*M),policy};pending=deferred();at=input.collectionAt-10000;
   assert.equal(prefetch.prepare(input),true);await turn();at=input.collectionAt;
   const result=await runCycle({local,policy,client:{snapshot:async()=>({...f.account,engine:{strategy_version:RULE_ENGINE_VERSION}})},
    kevConfigFn:async()=>({enabled:false}),costsFn:actualPolicy=>{
     const consuming=prefetch.consume({...input,policy:actualPolicy});
     if(n<3)at=input.boundary+M;
     pending.resolve(facts('demo',input.collectionAt-5000));return consuming;
    },collectFn:async()=>{marketReads++;throw Error('CLOCK_RTT_REJECTED');},
    analyzeFn:forbidden,kevReviewFn:forbidden,executeFn:forbidden});
   assert.equal(result.status,'waiting');assert.equal(result.entriesAllowed,false);
   assert.equal(result.reason,n<3?'COST_PREFETCH_SLOT_EXPIRED':'CLOCK_RTT_REJECTED');
  }
  const health=await readJson(join(local,'health.json'));
  assert.equal(reads,4);assert.equal(marketReads,1);assert.equal(downstream,0);
  assert.equal(health.consecutiveFailures,0);assert.equal(health.lastSuccessAt,originalSuccess);
  assert.equal(health.lastCycleCompletedAt,originalSuccess);assert.equal(await exists(join(local,'STOP')),false);
 }finally{await prefetch.drain();await rm(local,{recursive:true,force:true});}
});
