import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {executableCostEconomics} from '../src/trading-costs.mjs';

function fixture(mode='demo',action=mode==='demo'?'buy':'open-long'){
 return {mode,action,stopFraction:.005,targetFraction:.015,market:{bid:'100',ask:'100.1',spreadBps:'10',
  entryCost:{status:'ok',buyRate:'.001',sellRate:'.002',roundTripFeeBps:'30',spreadBps:'10',
   slippageBpsPerSide:5,fundingReserveBps:mode==='demo'?'0':'2',
   estimatedRoundTripCostBps:mode==='demo'?'50':'52',requiredPriceSpaceBps:mode==='demo'?'80':'82'}}};
}
const almost=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(Number(actual)-Number(expected))<=tolerance,`${actual} != ${expected}`);

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
