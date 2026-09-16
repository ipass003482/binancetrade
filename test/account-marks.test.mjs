import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../src/risk.mjs';
import { fixture,trade } from './fixtures.mjs';
import { loadPolicy } from '../src/config.mjs';

async function context(futures=false) {
 const f=await fixture();
 f.account.trades=[{...trade(),current_rate:100,profit_abs:0}];
 if(!futures)return f;
 f.policy={...await loadPolicy('demo-futures'),maxOpenTrades:2,maxExposureUsdt:'100'};
 f.snapshot.mode=f.policy.mode;
 const pair='BTC/USDT:USDT';
 f.proposal={...f.proposal,action:'open-long',pair,leverage:1,evidenceIds:['futures:'+pair]};
 f.snapshot.evidence=[{id:'futures:'+pair,status:'ok'}];
 f.snapshot.markets=[{...f.snapshot.markets[0],pair,mode:f.policy.mode,
  source:'https://demo-fapi.binance.com',verifiedFutures:true,filters:[
   {filterType:'LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},
   {filterType:'MARKET_LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},
   {filterType:'MIN_NOTIONAL',notional:'5'}]}];
 f.executionQuote=structuredClone(f.snapshot.markets[0]);
 Object.assign(f.account.trades[0],{pair:'ETH/USDT:USDT',trading_mode:'futures',leverage:1,amount:0.25});
 return f;
}

for(const futures of [false,true]) {
 const mode=futures?'futures':'spot';
 test(mode+' entry requires finite current price and PnL even when total PnL is zero',async()=>{
  const f=await context(futures);
  assert.equal(assess(f).action,f.proposal.action);
  for(const field of ['current_rate','profit_abs'])for(const value of [undefined,null,'',NaN,Infinity,'invalid',true]) {
   const broken=structuredClone(f);broken.account.trades[0][field]=value;
   assert.throws(()=>assess(broken),/POSITION_MARK_UNAVAILABLE/,field+'='+String(value));
  }
  for(const value of [0,-1]) {
   const broken=structuredClone(f);broken.account.trades[0].current_rate=value;
   assert.throws(()=>assess(broken),/POSITION_MARK_UNAVAILABLE/);
  }
  f.account.trades[0].current_rate='100';f.account.trades[0].profit_abs='-1';
  assert.equal(assess(f).action,f.proposal.action);
 });

 test(mode+' exit stays available with unavailable marks, daily loss and STOP',async()=>{
  const f=await context(futures);
  f.proposal.action=futures?'close-long':'sell';f.proposal.stakeUsdt='0';
  f.account.trades[0].pair=f.proposal.pair;
  f.account.trades[0].current_rate=null;f.account.trades[0].profit_abs=null;
  f.account.trades[0].total_profit_abs=null;
  f.stopped=true;f.account.daily.data[0].abs_profit=-999;
  assert.equal(assess(f).tradeId,f.account.trades[0].trade_id);
 });
}
