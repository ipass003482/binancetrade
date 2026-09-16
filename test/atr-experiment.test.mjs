import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateClosed15m,featureFrame,decideFrame,assertControlParity,riskStake,simulatePortfolio,BAR,VARIANTS } from '../src/atr-experiment.mjs';
import { trendCandles } from './fixtures.mjs';
const B=Date.parse('2026-06-01T00:00:00Z');
test('ATR aggregation includes complete UTC 15m groups only and never an open group',()=>{
 const candles=trendCandles(B,'long','5m');
 const last=aggregateClosed15m(candles,B).at(-1);
 assert.equal(last.closeTime,B-1);assert.equal(last.openTime,B-900000);
 const partial=[...candles,{openTime:B,closeTime:B+BAR-1,open:'100',high:'9999',low:'1',close:'100',volume:'10'}];
 assert.deepEqual(aggregateClosed15m(partial,B+BAR),aggregateClosed15m(candles,B));
 assert.ok(aggregateClosed15m(candles.slice(1),B).every(c=>c.openTime%900000===0));
});
test('control reproduces existing long and short signals and exit distances',()=>{
 for(const mode of ['demo','demo-futures'])for(const direction of ['long','short']){
  const candles=trendCandles(B,direction,'5m'),pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT';
  const frame=featureFrame({candles,mode,pair,now:B});
  for(const bps of [0,50,10000])assertControlParity(frame,candles,bps);
 }
});
test('15m variant changes risk geometry only; direction relaxation keeps one-hour sign',()=>{
 const q={action:'buy',reasons:['ENTRY_DIRECTION_NOT_ALIGNED'],metrics:{return1hPct:'0.5',return4hPct:'-1'}};
 const frame={pair:'BTC/USDT',mode:'demo',now:B,close:100,high:99,low:98,atr5:.5,atr15:1,directions:[q]};
 assert.equal(decideFrame(frame,'atr15m',0).action,'hold');
 const r=decideFrame(frame,'atr15m-hour1',0);assert.equal(r.action,'buy');assert.equal(r.stopFraction,.01);assert.equal(r.targetFraction,.02);
 q.metrics.return1hPct='-0.5';assert.equal(decideFrame(frame,'atr15m-hour1',0).action,'hold');
 q.metrics.return1hPct='0.5';q.reasons.push('ENTRY_RELATIVE_VOLUME_BELOW_ONE');assert.equal(decideFrame(frame,'atr15m-hour1',0).action,'hold');
 q.reasons=[];frame.high=99.94;frame.atr15=5;
 assert.equal(decideFrame(frame,'atr15m',0).action,'buy','breakout must keep .1 * 5m ATR rather than .1 * 15m ATR');
});
test('wider stop reduces stake at equal stop-plus-cost risk and respects exposure cap',()=>{
 const a={budget:1,maxStake:300,available:300,costFraction:.003};
 const small=riskStake({...a,stopFraction:.005}),large=riskStake({...a,stopFraction:.01});
 assert.ok(large<small);assert.ok(Math.abs(small*.008-1)<1e-12);assert.ok(Math.abs(large*.013-1)<1e-12);
 assert.equal(riskStake({...a,available:10,stopFraction:.01}),10);
});
function fixture(short=false){
 const pair=short?'BTC/USDT:USDT':'BTC/USDT',mode=short?'demo-futures':'demo';
 const candles=Array.from({length:146},(_,i)=>({openTime:B+(i-96)*BAR,closeTime:B+(i-95)*BAR-1,open:'100',high:'100.05',low:'99.95',close:'100',volume:'10'}));
 const d={mode,pair,candles},frames=new Map([[pair,candles.map((_,i)=>({pair,mode,now:B+(i-95)*BAR,close:100,high:99,low:101,atr5:.5,atr15:1,directions:[{action:short?'open-short':'buy',reasons:i===95?[]:['ENTRY_RELATIVE_VOLUME_BELOW_ONE'],metrics:{return1hPct:short?'-1':'1'}}]}))]]);
 const config={initialCapital:2000,riskBudgetUsdt:1,maxStake:300,maxExposure:900,maxOpenTrades:3,maxEntriesPerDay:4,maxDailyLoss:50,slippageBpsPerSide:5,priceSpaceBufferBps:30,fees:{[pair]:{buyRate:.001,sellRate:.001,spreadBps:0,stepSize:.001,minQty:.001,minNotional:5}}};
 return {datasets:[d],frames,config,from:B,to:B+50*BAR};
}
test('next-open fill, four-hour exit, risk bounds and funding-free accounting',()=>{
 for(const variant of VARIANTS){
  const r=simulatePortfolio({...fixture(),variant});assert.equal(r.trades,1);
  const t=r.tradeDetails[0];assert.equal(t.openedAt,B);assert.equal(t.closedAt,B+48*BAR);assert.equal(t.reason,'time_exit');
  assert.ok(t.plannedRiskUsdt<=1+1e-12);assert.ok(Math.abs(r.netUsdt-r.tradeDetails.reduce((s,t)=>s+t.net,0))<1e-9);
 }
});
test('zero daily count cap permits fills in the research consumer too',()=>{
 const f=fixture();f.config.maxEntriesPerDay=0;
 assert.equal(simulatePortfolio({...f,variant:'atr15m'}).trades,1);
});

test('funding at boundary excludes new position, boundary plus 1ms includes it without rounding',()=>{
 const f=fixture(true),d=f.datasets[0];d.funding={events:[{time:B,rate:'.01',markPrice:'100'},{time:B+1,rate:'.01',markPrice:'100'}]};
 const r=simulatePortfolio({...f,variant:'atr15m'}),t=r.tradeDetails[0];
 assert.equal(r.trades,1);assert.ok(Math.abs(t.funding-t.amount*100*.01)<1e-10);
 assert.ok(Math.abs(r.netUsdt-t.net)<1e-9);
});
test('uncertain intrabar funding credits are omitted on a bar that exits',()=>{
 const f=fixture(true),d=f.datasets[0];d.funding={events:[{time:B+1,rate:'.01',markPrice:'100'}]};
 d.candles[96].low='90';
 const r=simulatePortfolio({...f,variant:'atr15m'});assert.equal(r.trades,1);assert.equal(r.tradeDetails[0].funding,0);assert.equal(r.tradeDetails[0].reason,'target');
});
test('same bar stop and target use stop, and opening gap fills worse than stop',()=>{
 const f=fixture();f.datasets[0].candles[97].high='110';f.datasets[0].candles[97].low='90';
 const both=simulatePortfolio({...f,variant:'control-5m'});assert.equal(both.tradeDetails[0].reason,'stop_first_if_both');
 f.datasets[0].candles[97].open='95';
 const gap=simulatePortfolio({...f,variant:'control-5m'});assert.equal(gap.tradeDetails[0].reason,'gap_stop');assert.ok(gap.netUsdt<both.netUsdt);
});
