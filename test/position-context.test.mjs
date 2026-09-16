import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { positionMetrics,withEntryReasons } from '../src/position-context.mjs';
import { writeJson,journalAppend } from '../src/io.mjs';
import { makeEngineConfig } from '../src/engine-config.mjs';
import { loadPolicy } from '../src/config.mjs';

test('spot metrics include fees once, UTC duration and peak drawdown',()=>{
 const t={open_rate:100,current_rate:101,max_rate:102,amount:3,open_trade_value:300.3,
  fee_open:0.001,fee_close:0.001,is_short:false,trading_mode:'spot',open_date:'2026-09-09 01:00:00'};
 const m=positionMetrics(t,Date.parse('2026-09-09T03:00:00Z'));
 assert.equal(m.holdingMinutes,120);
 assert.ok(Math.abs(m.breakEvenRateEstimate-100.2002002)<1e-7);
 assert.ok(Math.abs(m.peakNetProfitUsdtEstimate-5.394)<1e-9);
 assert.ok(Math.abs(m.drawdownFromPeakPct-100/102)<1e-9);
 assert.equal(positionMetrics({...t,fee_close:null}).breakEvenRateEstimate,null);
 assert.equal(positionMetrics({...t,trading_mode:'futures'}).breakEvenRateEstimate,null);
 assert.equal(positionMetrics({...t,open_date:'bad'}).holdingMinutes,null);
 assert.equal(positionMetrics({},Date.now()).fees.entryRate,null);
 const fee=positionMetrics({...t,pair:'ETH/USDT',fee_open_cost:.3,fee_open_currency:'BNB'}).fees;
 assert.equal(fee.entryFeeQuoteCost,.3);assert.equal(fee.feeQuoteCurrency,'USDT');
 assert.equal(fee.entryFeePaidAsset,'BNB');assert.equal(fee.entryFeePaidAmount,null);
});

test('entry rationale is attributed by journal tag, pair and UUID; missing source stays null',async()=>{
 const local=await mkdtemp(join(tmpdir(),'position-context-'));
 const id='12345678-1234-1234-1234-123456789abc';
 const record={id:'a'.repeat(32),at:'2026-09-09T01:00:00Z',status:'pending',action:'buy',
  pair:'BTC/USDT',tag:'codex-test',snapshotId:id};
 await journalAppend(join(local,'orders.jsonl'),record);
 await writeJson(join(local,'runs',id+'.proposal.json'),{action:'buy',pair:record.pair,snapshotId:id,reason:'Observed breakout',apiKey:'must not propagate'});
 const r=await withEntryReasons({trades:[{pair:record.pair,enter_tag:record.tag},{pair:'ETH/USDT',enter_tag:record.tag}]},local);
 assert.equal(r.trades[0].originalEntry.reason,'Observed breakout');
 assert.equal(r.trades[0].originalEntry.executableStop,false);
 assert.equal(r.trades[1].originalEntry,null);
 assert.ok(!JSON.stringify(r).includes('must not propagate'));
});

test('Demo exits use native exchange stops and custom ATR exits without global ROI or trailing',async()=>{
 for(const mode of ['dry-run','demo','demo-futures']){
  const c=makeEngineConfig(await loadPolicy(mode),{});
  assert.equal(c.trailing_stop,mode==='dry-run'?undefined:false);
  assert.equal(c.order_types.stoploss_on_exchange,mode!=='dry-run');
  if(mode!=='dry-run'){
   assert.deepEqual(c.minimal_roi,{});
   assert.equal(c.use_custom_stoploss,true);
   assert.equal(c.order_types.stoploss,mode==='demo'?'limit':'market');
   assert.equal(c.order_types.stoploss_on_exchange_interval,15);
  }
 }
});
