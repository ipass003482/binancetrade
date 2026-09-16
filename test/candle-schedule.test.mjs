import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextBoundary,claimBoundary,lastClaim,verifyScheduledCandles,slotReady,CANDLE_MS,closeBufferMs } from '../src/candle-schedule.mjs';
import { runCycle } from '../src/workflow.mjs';
import { fixture } from './fixtures.mjs';
const t=Date.parse('2026-09-09T06:00:00Z');
test('futures collects at 15 seconds, spot keeps 5 seconds and late claim window is never extended',()=>{
 assert.equal(closeBufferMs('demo'),5000);assert.equal(closeBufferMs('demo-futures'),15000);
 assert.equal(slotReady(t+14999,t,'demo-futures'),false);assert.equal(slotReady(t+15000,t,'demo-futures'),true);
 assert.equal(slotReady(t+65001,t,'demo-futures'),false);
 assert.equal(nextBoundary(t+10000,0,'5m','demo-futures'),t);assert.equal(nextBoundary(t+15000,0,'5m','demo-futures'),t+300000);
 assert.equal(nextBoundary(t+10000,0,'5m','demo'),t+300000);
});
test('delayed futures claim remains one-use across restart and cannot claim early',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'futures-close-delay-'));
 assert.equal(await claimBoundary(dir,t,t+5000,'5m','demo-futures'),false);
 assert.equal(await claimBoundary(dir,t,t+15000,'5m','demo-futures'),true);
 assert.equal(await claimBoundary(dir,t,t+16000,'5m','demo-futures'),false);
 assert.equal(await lastClaim(dir),t);
});
test('schedule remains aligned despite research duration; no catchup bursts',()=>{
 assert.equal(nextBoundary(t-1),t);assert.equal(nextBoundary(t+4000),t);
 assert.equal(nextBoundary(t+35000),t+CANDLE_MS);
 assert.equal(nextBoundary(t+CANDLE_MS+70000),t+2*CANDLE_MS);
 assert.equal(nextBoundary(t-2*CANDLE_MS,t),t+CANDLE_MS);
 assert.equal(slotReady(t+4999,t),false);assert.equal(slotReady(t+5000,t),true);
 assert.equal(slotReady(t+65001,t),false);
});
test('persisted claim prevents re-running the same candle after restart or failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'candle-schedule-'));
 assert.equal(await claimBoundary(dir,t,t+5000),true);assert.equal(await lastClaim(dir),t);
 assert.equal(await claimBoundary(dir,t,t+6000),false);
 assert.equal(await claimBoundary(dir,t+CANDLE_MS,t+CANDLE_MS+70000),false);
 assert.equal(await claimBoundary(dir,t+CANDLE_MS,t+CANDLE_MS+5000),true);
});
test('scheduled data must contain exactly the newly completed candle for every market',()=>{
 const s={markets:[{candles:[{openTime:t-CANDLE_MS,closeTime:t-1}]}]};
 verifyScheduledCandles(s,t,t+5000);
 assert.throws(()=>verifyScheduledCandles(s,t+CANDLE_MS,t+CANDLE_MS+5000),/NOT_READY/);
 assert.throws(()=>verifyScheduledCandles(s,t,t+CANDLE_MS),/NOT_READY/);
 assert.throws(()=>verifyScheduledCandles({markets:[]},t,t+5000),/NOT_READY/);
});
test('stale scheduled candles never reach the analyst or execution',async()=>{
 const f=await fixture(),local=await mkdtemp(join(tmpdir(),'candle-cycle-'));
 for(const candle of f.snapshot.markets[0].candles){candle.openTime-=CANDLE_MS;candle.closeTime-=CANDLE_MS;}
 await assert.rejects(runCycle({local,policy:f.policy,client:{snapshot:async()=>f.account},
  scheduledCandleBoundary:Math.floor(Date.now()/CANDLE_MS)*CANDLE_MS,collectFn:async()=>f.snapshot,
  analyzeFn:()=>assert.fail('stale data reached analyst'),executeFn:()=>assert.fail('must not submit')}),/NOT_READY/);
});
