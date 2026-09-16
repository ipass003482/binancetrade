import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/config.mjs';
import { assess } from '../src/risk.mjs';
import { fixture } from './fixtures.mjs';
import { makeEngineConfig } from '../src/engine-config.mjs';
import { DashboardStore } from '../ui/store.mjs';
test('switching from expanded spot pair to futures selects an allowed futures pair',async()=>{
 const store=new DashboardStore({fetchImpl:async url=>new Response(JSON.stringify(url.startsWith('/api/dashboard')?
  {policy:{pairs:['BTC/USDT:USDT']}}:{pair:new URL(url,'http://local').searchParams.get('pair')}))});
 store.state.pair='XRP/USDT';store.state.mode='demo';await store.refresh({mode:'demo-futures'});
 assert.equal(store.state.pair,'BTC/USDT:USDT');assert.equal(store.state.market.pair,'BTC/USDT:USDT');
});
test('Demo limits are separate; spot expansion does not expand futures or dry-run',async()=>{
 const dry=await loadPolicy(),spot=await loadPolicy('demo'),f=await loadPolicy('demo-futures');
 assert.equal(spot.pairs.length,10);assert.equal(f.pairs.length,4);assert.equal(dry.pairs.length,4);
 assert.equal(dry.maxDailyLossUsdt,'20');assert.equal(spot.maxDailyLossUsdt,'50');assert.equal(f.maxDailyLossUsdt,'50');
 assert.equal(spot.maxExposureUsdt,'900');assert.equal(spot.maxOpenTrades,3);assert.equal(spot.maxEntriesPerDay,0);assert.equal(f.maxEntriesPerDay,0);assert.equal(dry.maxEntriesPerDay,4);
 assert.equal(f.maxStakeUsdt,'150');assert.equal(f.maxExposureUsdt,'150');assert.equal(f.maxTotalNotionalUsdt,'150');assert.equal(f.leverage,1);
 const c=makeEngineConfig(f,{});assert.equal(c.stake_amount,150);assert.equal(c.max_open_trades,1);
});
test('low-risk stake and each mode daily threshold block excess entries',async()=>{
 for(const mode of ['demo','demo-futures']){
  const f=await fixture(),future=mode==='demo-futures';f.policy=await loadPolicy(mode);f.snapshot.mode=mode;
  const pair=f.policy.pairs[0],id=(future?'futures:':'spot:')+pair;
  f.proposal={...f.proposal,pair,action:future?'open-short':'buy',stakeUsdt:f.policy.maxStakeUsdt,evidenceIds:[id],...(future?{leverage:1}:{})};
  f.snapshot.evidence=[{id,status:'ok'}];
  const quote={...f.snapshot.markets[0],pair,mode,source:future?'https://demo-fapi.binance.com':'https://demo-api.binance.com',verifiedFutures:future,
   filters:[{filterType:'LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},
    {filterType:'MARKET_LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}]};
  f.snapshot.markets=[quote];f.executionQuote=quote;
  assert.equal(assess(f).stakeUsdt,f.policy.maxStakeUsdt);
  f.records=Array.from({length:1000},()=>({status:'pending',action:future?'open-short':'buy',at:new Date(f.now).toISOString()}));
  assert.equal(assess(f).stakeUsdt,f.policy.maxStakeUsdt,'Demo entries remain eligible after any daily count');
  assert.throws(()=>assess({...f,proposal:{...f.proposal,stakeUsdt:String(Number(f.policy.maxStakeUsdt)+.01)}}),/STAKE_LIMIT/);
  f.account.daily.data[0].abs_profit=-49;assert.equal(assess(f).stakeUsdt,f.policy.maxStakeUsdt);
  f.account.daily.data[0].abs_profit=-50;assert.throws(()=>assess(f),/DAILY_LOSS_LIMIT/);
 }
});
