import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJson } from '../src/io.mjs';
import { healthStatus,inspectLocks,recoverLock } from '../src/health.mjs';
import { fixture } from './fixtures.mjs';
const now=Date.parse('2026-09-10T12:00:00.000Z'),iso=age=>new Date(now-age).toISOString();
async function setup(){
 const local=await mkdtemp(join(tmpdir(),'binance-continuous-health-')),f=await fixture();
 const policy={...f.policy,mode:'demo',timeframe:'5m'},client={snapshot:async()=>f.account};
 return {local,policy,client,read:()=>healthStatus(local,client,policy,{now,state:()=> 'alive'})};
}
async function active(local,age=1000){
 await writeJson(join(local,'continuous.json'),{enabled:true,updatedAt:iso(700000)});
 await writeJson(join(local,'watch.lock'),{pid:123,at:iso(700000)});
 await writeJson(join(local,'watch-heartbeat.json'),{pid:123,at:iso(1000)});
 await writeJson(join(local,'health.json'),{stage:'waiting_candle',lastCycleCompletedAt:iso(age)});
}

test('reachable engine does not conceal a missing requested continuous watch',async()=>{
 const f=await setup();
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(700000)});
 await writeJson(join(f.local,'health.json'),{lastSuccessAt:iso(1000)});
 const h=await f.read();
 assert.equal(h.engineAvailable,true);assert.equal(h.watchRunning,false);assert.equal(h.freshCycle,true);
 assert.equal(h.healthy,false);assert.equal(h.entryState,'fault');
 assert.deepEqual(h.problems,['CONTINUOUS_WATCH_NOT_RUNNING']);
});

test('explicit STOP permits missing watch and stale cycle while engine exits remain reachable',async()=>{
 const f=await setup();
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(700000)});
 await writeJson(join(f.local,'STOP'),{reason:'operator pause'});
 const h=await f.read();
 assert.equal(h.healthy,true);assert.equal(h.stopped,true);assert.equal(h.entryState,'paused');
 assert.equal(h.watchRunning,false);assert.equal(h.freshCycle,false);
});

test('fresh heartbeat cannot conceal a cycle older than two 5m candles plus buffer',async()=>{
 const f=await setup();await active(f.local,605001);
 const h=await f.read();
 assert.equal(h.watchRunning,true);assert.equal(h.freshCycle,false);assert.equal(h.healthy,false);
 assert.deepEqual(h.problems,['CYCLE_STALE']);assert.equal(h.freshness.cycleMaxAgeMs,605000);
});
test('minute cadence heartbeat cannot conceal two missed decision cycles',async()=>{
 const f=await setup();await active(f.local,125001);
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(700000),decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000});
 const h=await f.read();
 assert.equal(h.watchRunning,true);assert.equal(h.freshCycle,false);assert.equal(h.freshness.cycleMaxAgeMs,125000);
 assert.deepEqual(h.problems,['CYCLE_STALE']);
});
test('minute startup grace expires after two minutes plus collection buffer',async()=>{
 const f=await setup();await active(f.local,700000);
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(125001),decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000});
 const h=await f.read();assert.equal(h.continuous.cycleStartupGrace,false);assert.ok(h.problems.includes('CYCLE_STALE'));
});

test('waiting risk is a completed healthy cycle with a visible reason',async()=>{
 const f=await setup();await active(f.local);
 await writeJson(join(f.local,'health.json'),{stage:'waiting_candle',lastCycleCompletedAt:iso(1000),
  entryWait:{status:'waiting',reason:'ENTRY_RATE_LIMIT',resetAt:'2026-09-11T00:00:00.000Z'}});
 const h=await f.read();
 assert.equal(h.healthy,true);assert.equal(h.entryState,'waiting_risk');
 assert.equal(h.entryWait.reason,'ENTRY_RATE_LIMIT');assert.equal(h.dailyEntryAllowance.used,0);
});

test('bounded startup grace expires without a watch or first completed cycle',async()=>{
 const f=await setup();
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(10000)});
 let h=await f.read();assert.equal(h.healthy,true);assert.equal(h.continuous.watchStartupGrace,true);
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(45001)});
 h=await f.read();assert.equal(h.healthy,false);assert.ok(h.problems.includes('CONTINUOUS_WATCH_NOT_RUNNING'));
 await active(f.local,700000);
 await writeJson(join(f.local,'continuous.json'),{enabled:true,updatedAt:iso(365001)});
 h=await f.read();assert.equal(h.continuous.cycleStartupGrace,false);assert.ok(h.problems.includes('CYCLE_STALE'));
});

test('failure remains visible when watch advances stage to waiting_candle',async()=>{
 const f=await setup();await active(f.local);
 await writeJson(join(f.local,'health.json'),{stage:'waiting_candle',lastSuccessAt:iso(1000),
  lastError:'UNRESOLVED_SUBMISSION',consecutiveFailures:1});
 const h=await f.read();assert.equal(h.healthy,false);assert.ok(h.problems.includes('UNRESOLVED_SUBMISSION'));
});

test('forward and equity locks are inspected and require strictly proven dead recovery',async()=>{
 const f=await setup();
 for(const name of ['forward','equity'])await writeJson(join(f.local,name+'.lock'),{pid:123});
 const inventory=await inspectLocks(f.local,{state:()=> 'alive'});
 assert.deepEqual(inventory.map(item=>item.name),['forward','equity']);
 await assert.rejects(recoverLock(f.local,'forward',{state:()=> 'unknown',processes:async()=>[]}),/OWNER_NOT_PROVEN_DEAD/);
 await assert.rejects(recoverLock(f.local,'equity',{state:()=> 'dead',processes:async()=>[{pid:124}]}),/PROCESSES_STILL_RUNNING/);
});
