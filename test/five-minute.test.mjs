import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { timeframeSpec,tradingTimeframe } from '../src/timeframe.mjs';
import { nextBoundary,lastClaim,claimBoundary,verifyScheduledCandles } from '../src/candle-schedule.mjs';
import { verifyEntryTiming } from '../src/entry-timing.mjs';
import { technicalSummary } from '../src/research-profile.mjs';
import { baselineDecision,backtestBaseline } from '../src/baseline.mjs';
import { clockFixture,trendCandles,engineConfig } from './fixtures.mjs';
import { writeJson } from '../src/io.mjs';
import { loadPolicy } from '../src/config.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
const B=Date.parse('2026-09-10T00:00:00Z'),M=300000;
test('Demo uses 5m and keeps four hours of holding time, while historical 15m stays readable',async()=>{
 for(const mode of ['demo','demo-futures']){
  const p=await loadPolicy(mode);assert.equal(p.timeframe,'5m');assert.equal(p.maxSignalAgeSeconds,120);
  const s=timeframeSpec(tradingTimeframe(mode));assert.equal(s.historyBars,96);assert.equal(s.maxHoldingBars*s.ms,14400000);
 }
 assert.equal(tradingTimeframe('dry-run'),'15m');assert.equal(timeframeSpec().maxHoldingBars,16);
 assert.throws(()=>timeframeSpec('1m'),/REJECTED/);
});
test('5m schedule migrates old 15m claims and never claims a closed candle twice',async()=>{
 const local=await mkdtemp(join(tmpdir(),'five-minute-'));
 await writeJson(join(local,'candle-schedule.json'),{version:1,boundary:B});
 assert.equal(nextBoundary(B+M-1,await lastClaim(local),'5m'),B+M);
 assert.equal(await claimBoundary(local,B+M,B+M+5000,'5m'),true);
 assert.equal(await claimBoundary(local,B+M,B+M+6000,'5m'),false);
 assert.equal(await lastClaim(local),B+M);
 assert.equal(nextBoundary(B+M+6000,await lastClaim(local),'5m'),B+2*M);
 const snapshot={timeframe:'5m',markets:[{candles:[{openTime:B,closeTime:B+M-1}]}]};
 verifyScheduledCandles(snapshot,B+M,B+M+5000);
 assert.throws(()=>verifyScheduledCandles({...snapshot,timeframe:'15m'},B+M,B+M+5000),/NOT_READY/);
});
test('5m entry expires at the next boundary and rejects 15m snapshots',()=>{
 const at=B+M-1000,clock=clockFixture(at,'demo'),snapshot={mode:'demo',timeframe:'5m',clock,createdAt:new Date(at).toISOString(),candleBoundary:B,
  markets:[{pair:'BTC/USDT',candles:trendCandles(at,'long','5m')}]};
 const args={snapshot,pair:'BTC/USDT',mode:'demo',clock,now:at};assert.equal(verifyEntryTiming(args).boundary,B);
 assert.throws(()=>verifyEntryTiming({...args,now:B+M+10,clock:clockFixture(B+M+10,'demo')}),/SUPERSEDED/);
 assert.throws(()=>verifyEntryTiming({...args,snapshot:{...snapshot,timeframe:'15m'}}),/TIMEFRAME/);
});
test('5m indicators retain 12 and 48 bar hour offsets, not old 4 and 16 bar offsets',()=>{
 const candles=trendCandles(B,'long','5m');
 const set=(i,p)=>Object.assign(candles.at(i),{open:String(p),close:String(p),high:String(p+.01),low:String(p-.01)});
 set(-1,100);set(-13,80);set(-49,50);set(-5,90);set(-17,75);
 const result=technicalSummary(candles,'5m');assert.equal(result.return1hPct,'25.0000');assert.equal(result.return4hPct,'100.0000');
 assert.throws(()=>technicalSummary(candles.slice(-32),'5m'),/INSUFFICIENT/);
 const decision=baselineDecision({candles,mode:'demo',pair:'BTC/USDT',timeframe:'5m',now:B,cost:{status:'ok',requiredPriceSpaceBps:'1'}});
 assert.equal(decision.directionChecks[0].metrics.return1hPct,'25');assert.equal(decision.directionChecks[0].metrics.return4hPct,'100');
});
test('5m historical fills remain next-open and time exit stays four hours later',()=>{
 const candles=trendCandles(B,'long','5m');
 for(let i=0;i<50;i++)candles.push({openTime:B+i*M,closeTime:B+(i+1)*M-1,open:'100',high:'100.01',low:'99.99',close:'100',volume:'10'});
 const decide=({now})=>now===B?{action:'buy',signalAt:B,stopFraction:.01,targetFraction:.02,maxHoldingBars:48}:{action:'hold'};
 const r=backtestBaseline({schemaVersion:1,timeframe:'5m',mode:'demo',pair:'BTC/USDT',candles},{buyRate:.001,sellRate:.001,slippageBpsPerSide:0,decide});
 assert.equal(r.trades.length,1);assert.equal(r.trades[0].openedAt,B);assert.equal(r.trades[0].closedAt-B,14400000);assert.equal(r.trades[0].reason,'time_exit');
});
test('Demo engine with old 15m timeframe cannot pass execution identity',async()=>{
 const p=await loadPolicy('demo'),engine={...engineConfig(p),dry_run:false,runmode:'live',demo_trading:true,timeframe:'15m'};
 const client=new FreqtradeClient(p,{}, {fetchImpl:async()=>new Response(JSON.stringify(engine))});
 await assert.rejects(client.assertMode(),/IDENTITY/);engine.timeframe='5m';assert.equal((await client.assertMode()).timeframe,'5m');
});
