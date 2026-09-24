import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clockFixture } from './fixtures.mjs';
import { timeMonitor } from '../src/time-monitor.mjs';
import { writeJson } from '../src/io.mjs';
import { timingView } from '../ui/timing.mjs';
const B=Date.parse('2026-09-10T00:00:00Z'),NOW=B+5000;
test('Kev monitoring uses minute and fresh depth identities without a candle countdown',async()=>{
 const local=await mkdtemp(join(tmpdir(),'kev-time-monitor-')),at=B+80000;
 await writeJson(join(local,'continuous.json'),{entryPolicyVersion:'kev-order-flow-v1'});
 await writeJson(join(local,'watch.lock'),{pid:10});await writeJson(join(local,'watch-heartbeat.json'),{pid:10,at:new Date(at).toISOString()});
 const r=await timeMonitor(local,'demo',{now:()=>at,state:()=> 'alive',getClock:async()=>clockFixture(at,'demo')});
 assert.equal(r.timeframe,'order-flow');assert.equal(r.candleMs,null);assert.equal(r.nextCandleCloseAt,null);
 assert.equal(r.entryPolicyVersion,'kev-order-flow-v1');assert.equal(r.decisionIntervalMs,60000);
 const args={data:{timing:r},market:{timeframe:'order-flow',orderFlow:{books:[{at:at-1000}]}}};
 const view=timingView(args);assert.equal(view.tone,'ok');assert.match(view.status,/Kev 訂單流決策/);
 assert.equal(view.nextCandle,'不使用 K 線');assert.match(view.delay,/訂單簿 1 秒前/);
 assert.match(timingView({...args,elapsedMs:31000}).delay,/訂單簿已過期/);
 assert.equal(timingView({...args,elapsedMs:46000}).tone,'warning');
 const future=await timeMonitor(local,'demo-futures',{now:()=>B+10000,state:()=> 'alive',getClock:async()=>clockFixture(B+10000,'demo-futures')});
 assert.equal(future.nextCandleCloseAt,null);
});
test('minute decision countdown remains separate from next5m candle',async()=>{
 const local=await mkdtemp(join(tmpdir(),'minute-time-monitor-')),at=B+80000;
 await writeJson(join(local,'watch.lock'),{pid:10});await writeJson(join(local,'watch-heartbeat.json'),{pid:10,at:new Date(at).toISOString()});
 const r=await timeMonitor(local,'demo',{now:()=>at,state:()=> 'alive',getClock:async()=>clockFixture(at,'demo')});
 assert.equal(r.decisionIntervalMs,60000);assert.equal(r.candleMs,300000);
 assert.equal(Date.parse(r.nextResearchAt),B+125000);assert.equal(Date.parse(r.nextCandleCloseAt),B+300000);
 const view=timingView({data:{timing:r},market:{timeframe:'5m',candles:[{closeTime:B-1}]}});
 assert.match(view.status,/每 1 分鐘判斷/);assert.match(view.status,/5m K 線/);
});
test('futures timing fallback advertises the actual delayed start with the same exchange offset',async()=>{
 const local=await mkdtemp(join(tmpdir(),'futures-delay-time-')),at=B+10000;
 await writeJson(join(local,'watch.lock'),{pid:10});await writeJson(join(local,'watch-heartbeat.json'),{pid:10,at:new Date(at).toISOString()});
 const r=await timeMonitor(local,'demo-futures',{now:()=>at,state:()=> 'alive',getClock:async()=>clockFixture(at,'demo-futures')});
 assert.equal(Date.parse(r.nextResearchAt),B+15000);assert.equal(r.scheduleStatus,'running');
});
test('paused or stopped scheduler never advertises another research run, while candles continue',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-time-monitor-')),args={now:()=>NOW,getClock:async()=>clockFixture(NOW,'demo'),state:()=> 'alive'};
 let r=await timeMonitor(local,'demo',args);assert.equal(r.nextResearchAt,null);assert.equal(r.scheduleStatus,'not_running');assert.ok(r.nextCandleCloseAt);
 await writeJson(join(local,'watch.lock'),{pid:10});await writeJson(join(local,'watch-heartbeat.json'),{pid:10,at:new Date(NOW).toISOString()});
 await writeJson(join(local,'health.json'),{stage:'waiting_candle',nextResearchAt:new Date(B+905000).toISOString()});
 r=await timeMonitor(local,'demo',args);assert.ok(r.nextResearchAt);assert.equal(r.scheduleStatus,'running');
 const shifted=await timeMonitor(local,'demo',{...args,getClock:async()=>({...clockFixture(NOW,'demo'),serverTime:NOW-1200})});
 assert.equal(Date.parse(shifted.nextResearchAt),B+905000-1200);
 await writeJson(join(local,'STOP'),{});r=await timeMonitor(local,'demo',args);assert.equal(r.nextResearchAt,null);assert.equal(r.scheduleStatus,'paused');
});
test('clock failure stays explicit and cannot advertise a next run',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-clock-offline-'));
 const r=await timeMonitor(local,'demo',{getClock:async()=>{throw Error('CLOCK_SKEW_REJECTED');}});
 assert.equal(r.clockError,'CLOCK_SKEW_REJECTED');assert.equal(r.serverNow,null);assert.equal(r.nextResearchAt,null);
});
test('timing UI distinguishes candle lag, stale responses, expired/consumed signals and preview',()=>{
 const args={data:{timing:{clock:clockFixture(NOW,'demo'),serverNow:NOW,watchRunning:true,stopped:false,stage:'waiting_candle',
  nextResearchAt:new Date(B+905000).toISOString(),latestResearch:{signalExpiresAt:new Date(B+600000).toISOString()}}},
  market:{candles:[{closeTime:B-1}]},elapsedMs:0};
 let r=timingView(args);assert.equal(r.tone,'ok');assert.match(r.delay,/無缺 K/);assert.match(r.expiry,/剩/);
 r=timingView({...args,elapsedMs:46000});assert.equal(r.tone,'warning');assert.equal(r.expiry,'無法核對');
 r=timingView({...args,market:{candles:[{closeTime:B-900001}]}});assert.match(r.delay,/落後/);
 r=timingView({...args,market:{candles:[{closeTime:B+899999}]}});assert.equal(r.tone,'warning');assert.match(r.status,/異常/);
 args.data.timing.stage='failed';assert.match(timingView(args).expiry,/不可進場/);args.data.timing.stage='waiting_candle';
 args.data.timing.latestResearch.consumed=true;assert.equal(timingView(args).expiry,'本輪已處理');
 args.data.timing.stopped=true;r=timingView(args);assert.match(r.nextResearch,/已暫停/);assert.match(r.expiry,/不可進場/);
 r=timingView({...args,preview:true});assert.match(r.status,/展示資料/);
});
