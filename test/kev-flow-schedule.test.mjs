import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJson} from '../src/io.mjs';
import {watchDecisionSettings} from '../src/cli.mjs';
import {closeBufferMs,nextDecisionBoundary,claimDecisionBoundary,lastDecisionClaim,cycleTimingLimits} from '../src/candle-schedule.mjs';
const B=Date.parse('2026-09-21T06:02:00Z'),M=60000,route={entryPolicyVersion:'kev-order-flow-v1'};
const config={enabled:true,marketData:'order-flow',decisionMode:'autonomous'};

test('enabled Kev order-flow watch advertises its true decision timeframe and keeps legacy metadata intact',()=>{
 for(const [mode,delay] of [['demo',5000],['demo-futures',30000]]){
  const settings=watchDecisionSettings(mode,config);
  assert.equal(settings.timeframe,'order-flow');assert.equal(settings.entryPolicyVersion,'kev-order-flow-v1');
  assert.equal(settings.decisionIntervalMs,M);assert.equal(settings.entryDecisionIntervalMs,M);
  assert.equal(settings.collectionDelayMs,delay);
  for(const changed of [{enabled:false},{decisionMode:'approval'}])
   assert.throws(()=>watchDecisionSettings(mode,{...config,...changed}),/KEV_ORDER_FLOW_ACTIVATION_REQUIRED/);
  assert.deepEqual(watchDecisionSettings(mode,{...config,marketData:'kronos'}),
   {decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:M});
 }
 assert.deepEqual(watchDecisionSettings('dry-run',config),{});
});

test('Kev schedules spot at second 5 and futures at second 30 without changing legacy buffers or minute length',()=>{
 assert.equal(closeBufferMs('demo',route),5000);assert.equal(closeBufferMs('demo-futures',route),30000);
 assert.equal(closeBufferMs('demo'),5000);assert.equal(closeBufferMs('demo-futures'),15000);
 assert.equal(nextDecisionBoundary(B+4999,0,'demo',route),B);
 assert.equal(nextDecisionBoundary(B+5000,0,'demo',route),B+M);
 assert.equal(nextDecisionBoundary(B+15000,0,'demo-futures',route),B);
 assert.equal(nextDecisionBoundary(B+29999,0,'demo-futures',route),B);
 assert.equal(nextDecisionBoundary(B+30000,0,'demo-futures',route),B+M);
 assert.equal(nextDecisionBoundary(B+M+59999,0,'demo-futures',route),B+2*M);
 assert.equal(nextDecisionBoundary(B-2*M,B,'demo-futures',route),B+M);
});

test('Kev stagger claims remain durable, one-use and expired at second 60 across route switches',async()=>{
 const local=await mkdtemp(join(tmpdir(),'kev-minute-stagger-'));
 try{
  assert.equal(await claimDecisionBoundary(local,B,B+29999,'demo-futures',route),false);
  assert.equal(await claimDecisionBoundary(local,B,B+30000,'demo-futures',route),true);
  assert.equal(await lastDecisionClaim(local),B);
  const record=await readJson(join(local,'decision-schedule.json'));
  assert.equal(record.collectionDelayMs,30000);assert.equal(record.entryPolicyVersion,route.entryPolicyVersion);
  assert.equal(await claimDecisionBoundary(local,B,B+30001,'demo-futures',route),false);
  assert.equal(await claimDecisionBoundary(local,B,B+30001,'demo-futures'),false);
  assert.equal(await claimDecisionBoundary(local,B+M,B+2*M,'demo-futures',route),false);
  assert.equal(await claimDecisionBoundary(local,B+M,B+M+59999,'demo-futures',route),true);
 }finally{await rm(local,{recursive:true,force:true});}
});

test('health freshness allows the advertised Kev staggering while entry expiry stays one minute',()=>{
 const continuous=watchDecisionSettings('demo-futures',config);
 assert.deepEqual(cycleTimingLimits('demo-futures',{continuous}),
  {intervalMs:M,cycleMaxAgeMs:150000,startupGraceMs:150000});
 assert.deepEqual(cycleTimingLimits('demo',{continuous:watchDecisionSettings('demo',config)}),
  {intervalMs:M,cycleMaxAgeMs:125000,startupGraceMs:125000});
});
