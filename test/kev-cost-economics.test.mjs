import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {executableCostEconomics} from '../src/trading-costs.mjs';

function fixture(mode='demo',action=mode==='demo'?'buy':'open-long'){
 return {mode,action,stopFraction:.005,targetFraction:.015,maxHoldingSeconds:900,market:{bid:'100',ask:'100.1',spreadBps:'10',
  entryCost:{status:'ok',buyRate:'.001',sellRate:'.002',roundTripFeeBps:'30',spreadBps:'10',
   slippageBpsPerSide:5,fundingReserveBps:mode==='demo'?'0':'2',
   estimatedRoundTripCostBps:mode==='demo'?'50':'52',requiredPriceSpaceBps:mode==='demo'?'80':'82'}}};
}
const almost=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(Number(actual)-Number(expected))<=tolerance,`${actual} != ${expected}`);

for(const [mode,action] of [['demo','buy'],['demo-futures','open-long'],['demo-futures','open-short']]){
 test(mode+' '+action+' horizon scenarios conserve cash for each marginal quote move and exact break-even',()=>{
  const f=fixture(mode,action),original=JSON.stringify(f),r=executableCostEconomics(f),h=r.holdingHorizon,long=action!=='open-short',
   entry=(long?100.1:100)*(long?1.0005:.9995),quantity=100/entry,currentExit=long?100:100.1,
   net=quote=>{
    const exit=quote*(long?.9995:1.0005);
    return mode==='demo'?quantity*.999*exit*.998-100:
     quantity*(exit-entry)*(long?1:-1)-100*(long?.001:.002)-quantity*exit*(long?.002:.001)-.02;
   };
  assert.equal(h.version,'kev-cost-horizon-v1');assert.equal(h.maxHoldingSeconds,900);
  assert.equal(h.attainmentProbability,null);assert.equal(h.forecast,false);
  assert.deepEqual(Object.keys(h.netUsdtPer100ByFavorableExitMoveBps),['0','10','20','30']);
  for(const bps of [0,10,20,30]){
   almost(h.netUsdtPer100ByFavorableExitMoveBps[bps],net(currentExit*(1+(long?1:-1)*bps/10000)),1e-8);
   assert.ok(Number(h.netUsdtPer100ByFavorableExitMoveBps[bps])<0,'Small favorable moves do not automatically cover full costs');
  }
  assert.equal(h.netUsdtPer100ByFavorableExitMoveBps[0],r.unchangedQuotesNetUsdtPer100);
  almost(net(currentExit*(1+(long?1:-1)*Number(h.breakEvenFavorableExitQuoteMoveBps)/10000)),0,1e-9);
  assert.ok(Number(h.breakEvenFavorableExitQuoteMoveBps)<Number(r.requiredFavorableExitQuoteMoveBps));
  assert.equal(JSON.stringify(f),original,'Scenario computation must not modify original proof or costs');
 });
}

test('zero-friction quote scenarios add no synthetic fees, slippage, funding or buffer expense',()=>{
 for(const [mode,action] of [['demo','buy'],['demo-futures','open-long'],['demo-futures','open-short']]){
  const f=fixture(mode,action);Object.assign(f.market,{ask:'100',spreadBps:'0'});
  Object.assign(f.market.entryCost,{buyRate:'0',sellRate:'0',roundTripFeeBps:'0',spreadBps:'0',slippageBpsPerSide:0,
   fundingReserveBps:'0',estimatedRoundTripCostBps:'0',requiredPriceSpaceBps:'30'});
  const r=executableCostEconomics(f);
  assert.equal(r.holdingHorizon.breakEvenFavorableExitQuoteMoveBps,'0.00000000');
  assert.deepEqual(r.holdingHorizon.netUsdtPer100ByFavorableExitMoveBps,{'0':'0.00000000','10':'0.10000000','20':'0.20000000','30':'0.30000000'});
  f.market.entryCost.requiredPriceSpaceBps='300';
  assert.deepEqual(executableCostEconomics(f).holdingHorizon,r.holdingHorizon,'A larger net buffer is not another cash expense');
 }
});

test('holding duration and planned target never scale observed returns or create an attainment probability',()=>{
 const f=fixture(),baseline=executableCostEconomics(f);f.targetFraction=.15;
 assert.deepEqual(executableCostEconomics(f).holdingHorizon,baseline.holdingHorizon);
 f.maxHoldingSeconds=1800;const longer=executableCostEconomics(f).holdingHorizon;
 assert.equal(longer.maxHoldingSeconds,1800);
 assert.deepEqual({...longer,maxHoldingSeconds:900},baseline.holdingHorizon);
 delete f.maxHoldingSeconds;assert.equal(executableCostEconomics(f).holdingHorizon.maxHoldingSeconds,null);
 f.maxHoldingSeconds=null;assert.equal(executableCostEconomics(f).holdingHorizon.maxHoldingSeconds,null);
 for(const value of [0,-1,900.5,'900',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  f.maxHoldingSeconds=value;assert.throws(()=>executableCostEconomics(f),/KEV_COST_ECONOMICS_INVALID/);
 }
});

test('spot break-even conserves quote cash with BUY fee deducted from received base and SELL fee from proceeds',()=>{
 const f=fixture(),r=executableCostEconomics(f),entry=100.1*1.0005,
  receivedBase=100/entry*(1-.001),exitFill=Number(r.breakEvenExitQuotePrice)*.9995;
 almost(receivedBase*exitFill*(1-.002),100);
 almost(receivedBase*Number(r.exitQuoteForNetBuffer)*.9995*.998-100,.3);
 almost(r.unchangedQuotesNetUsdtPer100,receivedBase*100*.9995*.998-100,1e-8);
 assert.match(r.feeAssumption,/BUY fee in received base/);
 assert.equal(r.forecast,false);
});

for(const action of ['open-long','open-short'])test('futures '+action+' correctly assigns asymmetric fees, both slippages and funding',()=>{
 const f=fixture('demo-futures',action),r=executableCostEconomics(f),long=action==='open-long',
  entry=(long?100.1:100)*(long?1.0005:.9995),amount=100/entry,
  entryFee=100*(long?.001:.002),net=quote=>{
   const exit=Number(quote)*(long?.9995:1.0005);
   return amount*(exit-entry)*(long?1:-1)-entryFee-amount*exit*(long?.002:.001)-.02;
  };
 almost(net(r.breakEvenExitQuotePrice),0);
 almost(net(r.exitQuoteForNetBuffer),.3);
 almost(net(r.targetExitQuotePrice),r.targetNetUsdtPer100,1e-8);
 almost(net(r.stopExitQuotePrice),r.stopNetUsdtPer100,1e-8);
 assert.equal(r.entryFeeRate,long?'0.001':'0.002');
 assert.equal(r.exitFeeRate,long?'0.002':'0.001');
 assert.ok(Number(r.unchangedQuotesNetUsdtPer100)<0);
});

test('executable bid/ask scenarios charge spread exactly once and retain it in the aggregate risk estimate',()=>{
 const f=fixture();Object.assign(f.market,{bid:'100',ask:'101',spreadBps:'100'});
 Object.assign(f.market.entryCost,{buyRate:'0',sellRate:'0',roundTripFeeBps:'0',spreadBps:'100',
  slippageBpsPerSide:0,estimatedRoundTripCostBps:'100',requiredPriceSpaceBps:'130'});
 const r=executableCostEconomics(f);
 assert.equal(r.unchangedQuotesNetUsdtPer100,'-0.99009901');
 assert.equal(r.breakEvenExitQuotePrice,'101');
 assert.equal(r.exitQuoteForNetBuffer,'101.303');
 assert.equal(f.market.entryCost.estimatedRoundTripCostBps,'100');
});

test('a favorable price move can still have negative net profit after complete costs',()=>{
 const f=fixture();f.targetFraction=.001;
 const r=executableCostEconomics(f);
 assert.ok(Number(r.targetExitQuotePrice)>Number(r.modeledEntryFillPrice));
 assert.ok(Number(r.targetNetUsdtPer100)<0);
 assert.ok(Number(r.requiredFavorableExitQuoteMoveBps)>0);
});

test('higher sell fees and funding never make the relevant exit threshold easier',()=>{
 for(const action of ['open-long','open-short']){
  const f=fixture('demo-futures',action),before=executableCostEconomics(f);
  Object.assign(f.market.entryCost,{fundingReserveBps:'12',estimatedRoundTripCostBps:'62',requiredPriceSpaceBps:'92'});
  const after=executableCostEconomics(f);
  assert.ok(new Decimal(after.requiredFavorableExitQuoteMoveBps).gt(before.requiredFavorableExitQuoteMoveBps));
  Object.assign(f.market.entryCost,{sellRate:'.003',roundTripFeeBps:'40',estimatedRoundTripCostBps:'72',requiredPriceSpaceBps:'102'});
  assert.ok(new Decimal(executableCostEconomics(f).requiredFavorableExitQuoteMoveBps).gt(after.requiredFavorableExitQuoteMoveBps));
 }
});

test('a zero spread is valid while inconsistent quote, market or cost spreads fail closed',()=>{
 const f=fixture();Object.assign(f.market,{ask:'100',spreadBps:'0'});
 Object.assign(f.market.entryCost,{spreadBps:'0',estimatedRoundTripCostBps:'40',requiredPriceSpaceBps:'70'});
 assert.ok(Number(executableCostEconomics(f).breakEvenExitQuotePrice)>100);
 for(const mutate of [v=>v.market.spreadBps='1',v=>v.market.ask='100.01',v=>v.market.bid='100.01',
  v=>Object.assign(v.market.entryCost,{spreadBps:'1',estimatedRoundTripCostBps:'41',requiredPriceSpaceBps:'71'})]){
  const v=structuredClone(f);mutate(v);assert.throws(()=>executableCostEconomics(v),/KEV_COST_ECONOMICS_INVALID/);
 }
});

test('invalid inputs, incomplete cost sums, spot funding and short spot all fail closed',()=>{
 for(const mutate of [f=>f.action='open-short',f=>delete f.market.entryCost.buyRate,
  f=>f.market.entryCost.sellRate='NaN',f=>f.market.entryCost.buyRate='1e100000',
  f=>f.market.entryCost.estimatedRoundTripCostBps='30',f=>f.market.entryCost.requiredPriceSpaceBps='49',
  f=>f.market.entryCost.roundTripFeeBps='20',f=>f.market.entryCost.fundingReserveBps='1',
  f=>f.market.bid='101',f=>f.market.entryCost.slippageBpsPerSide=-1]){
  const f=fixture();mutate(f);assert.throws(()=>executableCostEconomics(f),/KEV_COST_ECONOMICS_INVALID/);
 }
});
