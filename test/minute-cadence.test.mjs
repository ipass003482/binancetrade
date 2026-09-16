import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nextDecisionBoundary,lastDecisionClaim,claimDecisionBoundary,verifyScheduledDecision,cycleTimingLimits} from '../src/candle-schedule.mjs';
import {clockDecisionBoundary,decisionTiming,verifyEntryTiming} from '../src/entry-timing.mjs';
import {clockFixture,trendCandles} from './fixtures.mjs';
const B=Date.parse('2026-09-16T05:00:00Z'),M=60000;
function snapshot(minute=0,mode='demo'){
 const at=B+minute*M+20000,clock=clockFixture(at,mode),pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT';
 return {mode,timeframe:'5m',createdAt:new Date(at).toISOString(),clock,candleBoundary:B,
  decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:M,decisionBoundary:B+minute*M,
  markets:[{pair,candles:trendCandles(at,'long','5m')}]};
}
test('each fresh minute is independently usable with unchanged fully closed5m candles',()=>{
 for(const mode of ['demo','demo-futures'])for(let i=0;i<5;i++){
  const s=snapshot(i,mode),now=Date.parse(s.createdAt);
  const checked=verifyEntryTiming({snapshot:s,pair:s.markets[0].pair,mode,clock:s.clock,now});
  assert.equal(checked.boundary,B);assert.equal(checked.decisionBoundary,B+i*M);
  assert.equal(checked.decisionDeadline,B+(i+1)*M);
  verifyScheduledDecision(s,B+i*M,now);
 }
});
test('minute signals expire even while their5m ATR candle is still current',()=>{
 const s=snapshot(),mode=s.mode,pair=s.markets[0].pair;
 assert.throws(()=>verifyEntryTiming({snapshot:s,pair,mode,clock:clockFixture(B+M,mode),now:B+M}),/SIGNAL_DECISION_SUPERSEDED/);
 assert.throws(()=>verifyScheduledDecision(s,B,B+M),/SCHEDULED_DECISION_NOT_READY/);
 assert.throws(()=>verifyScheduledDecision(s,B+M,B+20000),/SCHEDULED_DECISION_NOT_READY/);
});
test('minute timing contracts reject partial fields and cannot widen signal lifetime',()=>{
 const s=snapshot();
 for(const change of [{decisionCadenceVersion:'unknown'},{decisionIntervalMs:300000},{decisionBoundary:B+1},
  {decisionBoundary:B+300000},{decisionBoundary:B-60000},{timeframe:'15m'},{mode:'dry-run'}])
  assert.throws(()=>decisionTiming({...s,...change}),/DECISION_TIMING_INVALID/);
 const partial={...s};delete partial.decisionBoundary;
 assert.throws(()=>decisionTiming(partial),/DECISION_TIMING_INVALID/);
 assert.equal(decisionTiming({mode:'demo',candleBoundary:B}),null);
 // A mutated same-candle minute cannot make an older snapshot eligible.
 const forged={...s,decisionBoundary:B+M};
 assert.throws(()=>verifyEntryTiming({snapshot:forged,pair:s.markets[0].pair,mode:s.mode,
  clock:clockFixture(B+M+20000,s.mode),now:B+M+20000}),/SIGNAL_DECISION_SUPERSEDED/);
});
test('exchange-clock uncertainty across a minute blocks orders before local rollover',()=>{
 const now=B+M-20,c={...clockFixture(now,'demo'),requestStartedAt:now-100,serverTime:now-50};
 assert.throws(()=>clockDecisionBoundary(c,'demo',now),/CLOCK_DECISION_BOUNDARY_UNCERTAIN/);
});
test('minute scheduler preserves close buffers and skips elapsed slots without catchup',()=>{
 assert.equal(nextDecisionBoundary(B+4000,0,'demo'),B);
 assert.equal(nextDecisionBoundary(B+5000,0,'demo'),B+M);
 assert.equal(nextDecisionBoundary(B+10000,0,'demo-futures'),B);
 assert.equal(nextDecisionBoundary(B+15000,0,'demo-futures'),B+M);
 assert.equal(nextDecisionBoundary(B+3*M+30000,0,'demo'),B+4*M);
 assert.equal(nextDecisionBoundary(B-2*M,B,'demo'),B+M);
});
test('persisted claims prevent minute resubmission after failure/restart; no late grace',async()=>{
 for(const mode of ['demo','demo-futures']){
  const local=await mkdtemp(join(tmpdir(),'flow-minute-')),buffer=mode==='demo'?5000:15000;
  assert.equal(await claimDecisionBoundary(local,B,B+buffer-1,mode),false);
  assert.equal(await claimDecisionBoundary(local,B,B+buffer,mode),true);
  assert.equal(await lastDecisionClaim(local),B);
  assert.equal(await claimDecisionBoundary(local,B,B+buffer+1,mode),false);
  assert.equal(await claimDecisionBoundary(local,B+M,B+2*M,mode),false);
  assert.equal(await claimDecisionBoundary(local,B+M,B+M+buffer,mode),true);
 }
});
test('supervisor and health share minute freshness limits while legacy clocks stay explicit',()=>{
 assert.deepEqual(cycleTimingLimits('demo',{health:{stage:'waiting_decision'}}),{intervalMs:60000,cycleMaxAgeMs:125000,startupGraceMs:125000});
 assert.deepEqual(cycleTimingLimits('demo-futures',{continuous:{decisionCadenceVersion:'flow-minute-v1'}}),{intervalMs:60000,cycleMaxAgeMs:135000,startupGraceMs:135000});
 assert.equal(cycleTimingLimits('demo',{health:{stage:'waiting_candle'}}).cycleMaxAgeMs,605000);
 assert.equal(cycleTimingLimits('dry-run',{health:{stage:'waiting_decision'}}).intervalMs,900000);
});
