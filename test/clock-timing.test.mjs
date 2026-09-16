import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clockFixture,fixture,engineConfig,trendCandles } from './fixtures.mjs';
import { clockEndpoint,clockRange,readExchangeClock } from '../src/exchange-clock.mjs';
import { clockBoundary,verifyEntryTiming } from '../src/entry-timing.mjs';
import { execute } from '../src/bridge.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { journalRead } from '../src/io.mjs';
const B=Date.parse('2026-09-10T00:00:00Z'),M=900000;
test('clock uses only selected environment time route and accounts for RTT uncertainty',async()=>{
 for(const mode of ['dry-run','demo','demo-futures']){
  const times=[B+5000,B+5100],mono=[0,100];let url;
  const c=await readExchangeClock(mode,{now:()=>times.shift(),monotonic:()=>mono.shift(),fetchImpl:async u=>{
   url=u;return new Response(JSON.stringify({serverTime:B+4950}));}});
  assert.equal(url,clockEndpoint(mode));assert.equal(c.offsetMs,-100);assert.equal(c.uncertaintyMs,50);
  assert.equal(clockBoundary(c,mode,B+5100),B);
 }
 assert.throws(()=>clockEndpoint('live'),/MODE_REJECTED/);
});
test('large skew, slow RTT, stale or future samples, malformed clocks and wrong modes fail closed',()=>{
 const c=clockFixture(B+5000,'demo');
 for(const [value,now,code] of [
  [{...c,serverTime:c.serverTime+2001},B+5000,/SKEW/],
  [{...c,requestStartedAt:B+3000},B+5000,/RTT/],
  [c,B+65001,/STALE/],[c,B+4999,/STALE/],
  [{...c,serverTime:'1788998405000'},B+5000,/INVALID/],
  [{...c,source:clockEndpoint('demo-futures')},B+5000,/INVALID/]
 ])assert.throws(()=>clockRange(value,'demo',now),code);
});
test('clock request fails on local wall-clock jump or invalid/unavailable endpoint',async()=>{
 const time=[B+5000,B+5500],mono=[0,100];
 await assert.rejects(readExchangeClock('demo',{now:()=>time.shift(),monotonic:()=>mono.shift(),fetchImpl:async()=>new Response(JSON.stringify({serverTime:B+5000}))}),/JUMP/);
 await assert.rejects(readExchangeClock('demo',{fetchImpl:async()=>new Response('{}')}),/INVALID/);
 await assert.rejects(readExchangeClock('demo',{fetchImpl:async()=>{throw Error('NETWORK_OFFLINE');}}),/NETWORK_OFFLINE/);
});
test('same candle stays valid; across next close original signal is rejected even under 600 seconds',()=>{
 const at=B+M-30000,clock=clockFixture(at),snapshot={mode:'dry-run',createdAt:new Date(at).toISOString(),clock,candleBoundary:B,
  markets:[{pair:'BTC/USDT',candles:trendCandles(at)}]};
 assert.equal(verifyEntryTiming({snapshot,pair:'BTC/USDT',mode:'dry-run',clock,now:at}).boundary,B);
 assert.throws(()=>verifyEntryTiming({snapshot,pair:'BTC/USDT',mode:'dry-run',clock:clockFixture(B+M+10),now:B+M+10}),/SUPERSEDED/);
 assert.throws(()=>verifyEntryTiming({snapshot:{...snapshot,candleBoundary:B-M},pair:'BTC/USDT',mode:'dry-run',clock,now:at}),/SUPERSEDED/);
});
test('uncertainty straddling a candle boundary rejects before the local boundary',()=>{
 const c={...clockFixture(B+M-20),requestStartedAt:B+M-120,serverTime:B+M-70};
 assert.throws(()=>clockBoundary(c,'dry-run',B+M-20),/UNCERTAIN/);
});
test('final client synchronous check runs after preflight and can block the POST',async()=>{
 const f=await fixture();let posts=0,checkRan=false;
 const c=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{if(o.method==='POST')posts++;return new Response(JSON.stringify(engineConfig(f.policy)));}});
 await assert.rejects(c.submit(f.proposal,'tag',null,{beforeSend:async()=>()=>{checkRan=true;throw Error('SIGNAL_CANDLE_SUPERSEDED');}}),e=>e.submissionStarted===false&&e.message==='SIGNAL_CANDLE_SUPERSEDED');
 assert.equal(posts,0);assert.equal(checkRan,true);
});
test('real bridge final exchange-clock recheck rejects a crossing and never retries',async t=>{
 const f=await fixture(),at=B+M-1000,local=await mkdtemp(join(tmpdir(),'binance-timing-'));let wall=at,posts=0;
 t.mock.method(Date,'now',()=>wall);
 const clock=clockFixture(at);f.snapshot={...f.snapshot,id:randomUUID(),createdAt:new Date(at).toISOString(),clock,candleBoundary:B,
  markets:[{...f.snapshot.markets[0],clock,fetchedAt:new Date(at).toISOString(),candles:trendCandles(at)}]};
 f.proposal.snapshotId=f.snapshot.id;f.executionQuote=structuredClone(f.snapshot.markets[0]);
 f.account.daily.data[0].date=new Date(at).toISOString().slice(0,10);
 const engine=engineConfig(f.policy),client=new FreqtradeClient(f.policy,{}, {fetchImpl:async(u,o)=>{
  if(o.method==='POST')posts++;return new Response(JSON.stringify(engine));}});
 client.snapshot=async()=>({...f.account,engine});
 await assert.rejects(execute({...f,local,client,now:()=>wall,getQuote:async()=>f.executionQuote,getClock:async()=>{
  wall=B+M+100;return clockFixture(wall);}}),/SUPERSEDED/);
 assert.equal(posts,0);assert.deepEqual((await journalRead(join(local,'orders.jsonl'))).map(r=>r.status),['pending','rejected']);
});
