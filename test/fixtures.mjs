import { timeframeSpec } from '../src/timeframe.mjs';
import { randomUUID } from 'node:crypto';
import { loadPolicy } from '../src/config.mjs';
import { clockEndpoint } from '../src/exchange-clock.mjs';
export const clockFixture=(now,mode='dry-run')=>({mode,source:clockEndpoint(mode),requestStartedAt:now,receivedAt:now,serverTime:now,offsetMs:0,uncertaintyMs:0,rttMs:0});
export function trendCandles(now,direction='long',timeframe='15m'){
 const {ms,historyBars:n}=timeframeSpec(timeframe),boundary=Math.floor(now/ms)*ms;
 return Array.from({length:n},(_,i)=>{const close=direction==='long'?97+i/10-(n-32)/10:103.1-i/10+(n-32)/10;
  return {openTime:boundary-(n-i)*ms,closeTime:boundary-(n-1-i)*ms-1,
   open:String(close),high:String(close+.05),low:String(close-.05),close:String(close),volume:'10'};});
}
export async function fixture() {
 const now=Date.now(),iso=new Date(now).toISOString(),policy=await loadPolicy();
 const snapshot={id:randomUUID(),mode:'dry-run',createdAt:iso,markets:[{pair:'BTC/USDT',verifiedSpot:true,bid:'100',ask:'100.01',spreadBps:1,fetchedAt:iso,candles:trendCandles(now)}],evidence:[{id:'spot:BTC/USDT',status:'ok',data:{pair:'BTC/USDT'}},{id:'technical:BTC/USDT',pair:'BTC/USDT',status:'ok'}]};
 const proposal={action:'buy',pair:'BTC/USDT',stakeUsdt:'25',snapshotId:snapshot.id,evidenceIds:['spot:BTC/USDT'],reason:'Synthetic test only'};
 snapshot.clock=clockFixture(now);snapshot.candleBoundary=Math.floor(now/900000)*900000;
 snapshot.markets[0].clock=snapshot.clock;
 const account={trades:[],balance:{stake:'USDT',currencies:[{currency:'USDT',free:1000}]},daily:{stake_currency:'USDT',data:[{date:iso.slice(0,10),abs_profit:0}]}};
 return {now,policy,snapshot,proposal,account,records:[],stopped:false,executionQuote:structuredClone(snapshot.markets[0])};
}
export function engineConfig(policy) { return {timeframe:policy.timeframe??'15m',dry_run:true,runmode:'dry_run',trading_mode:'spot',exchange:'binance',
 bot_name:policy.freqtrade.botName,strategy:policy.freqtrade.strategy,state:'running',stake_currency:'USDT',
 short_allowed:false,force_entry_enable:true,position_adjustment_enable:false,stoploss:-0.02,max_open_trades:policy.maxOpenTrades};}
export function trade(pair='ETH/USDT') {return {trade_id:1,pair,stake_amount:25,current_rate:100,profit_abs:0,total_profit_abs:0,has_open_orders:false,is_short:false,is_open:true};}

// Synthetic validated-result stub for isolated decision/bridge contract tests.
// It is never written into the real model store or used as validation evidence;
// test/model-entry.test.mjs exercises the actual file/hash/time validator.
export function syntheticModelEvidence(snapshot,{direction='long',targetByPair={},entryAllowed=true}={}){
 const prediction={snapshotId:snapshot.id,mode:snapshot.mode,candleBoundary:snapshot.candleBoundary,
  modelFingerprint:'b'.repeat(64),
  issuedAt:snapshot.completedAt??snapshot.createdAt,
  forecasts:snapshot.markets.map(m=>{const origin=Number(m.candles.at(-1).close),
   target=targetByPair[m.pair]??origin*(direction==='short'?.97:direction==='hold'?1:1.03);
   return {pair:m.pair,originClose:origin,forecastCloses:[target,target,target],
    targetCloseAt:snapshot.candleBoundary+900000-1,usedForOrders:false};})};
 return {status:'ok',entryAllowed,reason:entryAllowed?null:'MODEL_REVIEW_SUPPRESSED',
  prediction,predictionSha256:'a'.repeat(64),modelFingerprint:'b'.repeat(64)};
}

export function flowFixture(now,mode='demo',pair='BTC/USDT',short=false){
 return {version:'sampled-demo-flow-v1',mode,pair,source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
 books:[0,1,2].map(i=>({at:now-20000+i*10000,updateId:i+1,
  bids:Array.from({length:5},(_,k)=>[String(100+(short?-1:1)*i*.001-.001-k*.001),short?'1':'3']),
  asks:Array.from({length:5},(_,k)=>[String(100+(short?-1:1)*i*.001+.001+k*.001),short?'3':'1'])})),
 startTime:now-61500,endTime:now-1500,trades:[0,1,2].map(i=>({a:i+1,T:now-55000+i*25000,p:'100',q:'1',m:short}))};
}
