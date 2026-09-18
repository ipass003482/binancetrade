import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOW_LOSS_COOLDOWN_MS,recentLossCooldowns} from '../src/order-flow.mjs';

const now=Date.parse('2026-09-18T08:00:00.000Z');

test('recentLossCooldowns blocks only recent negative closed fills',()=>{
 const result=recentLossCooldowns([
  {trade_id:10,pair:'NEAR/USDT',is_open:false,profit_abs:'-0.44',close_timestamp:now-90_000},
  {trade_id:11,pair:'SOL/USDT:USDT',is_open:false,profit_abs:'0.20',close_timestamp:now-90_000},
  {trade_id:12,pair:'BTC/USDT',is_open:false,profit_abs:'-0.30',close_timestamp:now-FLOW_LOSS_COOLDOWN_MS-1},
  {trade_id:13,pair:'UNI/USDT',is_open:true,profit_abs:'-0.50',close_timestamp:now-90_000},
 ],{now});
 assert.deepEqual([...result.keys()],['NEAR/USDT']);
 assert.equal(result.get('NEAR/USDT').tradeId,10);
});

test('recentLossCooldowns keeps the newest loss for a pair',()=>{
 const result=recentLossCooldowns([
  {trade_id:1,pair:'NEAR/USDT',is_open:false,profit_abs:'-0.10',close_timestamp:now-300_000},
  {trade_id:2,pair:'NEAR/USDT',is_open:false,profit_abs:'-0.25',close_timestamp:now-30_000},
 ],{now});
 assert.equal(result.get('NEAR/USDT').tradeId,2);
 assert.equal(result.get('NEAR/USDT').profitAbs,-0.25);
});

