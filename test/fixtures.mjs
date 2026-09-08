import { randomUUID } from 'node:crypto';
import { loadPolicy } from '../src/config.mjs';
export async function fixture() {
 const now=Date.now(),iso=new Date(now).toISOString(),policy=await loadPolicy();
 const snapshot={id:randomUUID(),mode:'dry-run',createdAt:iso,markets:[{pair:'BTC/USDT',verifiedSpot:true,bid:'100',ask:'100.01',spreadBps:1,fetchedAt:iso}],evidence:[{id:'spot:BTC/USDT',status:'ok'}]};
 const proposal={action:'buy',pair:'BTC/USDT',stakeUsdt:'25',snapshotId:snapshot.id,evidenceIds:['spot:BTC/USDT'],reason:'Synthetic test only'};
 const account={trades:[],balance:{stake:'USDT',currencies:[{currency:'USDT',free:1000}]},daily:{stake_currency:'USDT',data:[{date:iso.slice(0,10),abs_profit:0}]}};
 return {now,policy,snapshot,proposal,account,records:[],stopped:false,executionQuote:structuredClone(snapshot.markets[0])};
}
export function engineConfig(policy) { return {dry_run:true,runmode:'dry_run',trading_mode:'spot',exchange:'binance',
 bot_name:policy.freqtrade.botName,strategy:policy.freqtrade.strategy,state:'running',stake_currency:'USDT',
 short_allowed:false,force_entry_enable:true,position_adjustment_enable:false,stoploss:-0.02,max_open_trades:policy.maxOpenTrades};}
export function trade(pair='ETH/USDT') {return {trade_id:1,pair,stake_amount:25,total_profit_abs:0,has_open_orders:false,is_short:false,is_open:true};}
