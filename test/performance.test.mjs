import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePerformance,PERFORMANCE_DEFAULTS} from '../src/performance.mjs';
const base=Date.parse('2026-01-01T00:00:00Z');
const trade=(n,net,extra={})=>({trade_id:n,pair:'BTC/USDT',quote_currency:'USDT',is_open:false,is_short:false,
 open_timestamp:base+(n-1)*86400000,close_timestamp:base+(n-1)*86400000+3600000,
 profit_abs:net,stake_amount:100,leverage:1,...extra});
const evaluate=(trades,extra={})=>evaluatePerformance({trades,mode:'demo',observedAt:'2026-12-31T00:00:00Z',...extra});
const orders=(n,entry=100,exit=102)=>[
 {order_id:n+'-in',ft_is_entry:true,ft_order_side:'buy',status:'closed',is_open:false,amount:1,filled:1,remaining:0,cost:entry,average:entry},
 {order_id:n+'-out',ft_is_entry:false,ft_order_side:'sell',status:'closed',is_open:false,amount:1,filled:1,remaining:0,cost:exit,average:exit}
];
test('net metrics reveal concentrated profits and preserve close-time loss streaks',()=>{
 const r=evaluate([trade(4,20),trade(1,-4),trade(3,-2),trade(2,-3),trade(5,1)]);
 assert.equal(r.summary.netRealizedUsdt,'12');assert.equal(r.summary.grossWinsUsdt,'21');assert.equal(r.summary.grossLossesUsdt,'9');
 assert.equal(r.summary.expectancyUsdt,'2.4');assert.equal(r.summary.profitFactor,21/9);assert.equal(r.summary.winRate,.4);
 assert.equal(r.summary.netWithoutBestTradeUsdt,'-8');assert.equal(r.summary.bestTradeId,4);
 assert.equal(r.summary.closedTradeDrawdownUsdt,'9');assert.equal(r.summary.maxConsecutiveLosses,3);
 assert.equal(r.summary.accountEquityDrawdownPercent,null);assert.equal(r.assessment.status,'insufficient_evidence');
 assert.equal(r.assessment.promotionAuthorized,false);assert.equal(r.daily[0].netRealizedUsdt,'-4');
});
test('zero denominator is unavailable rather than Infinity, and no trades do not pass',()=>{
 const wins=evaluate([trade(1,2),trade(2,3)]);
 assert.equal(wins.summary.profitFactor,null);assert.equal(wins.summary.profitFactorReason,'no_losing_trades');
 const empty=evaluate([]);assert.equal(empty.summary.profitFactorReason,'no_closed_trades');assert.equal(empty.summary.expectancyUsdt,null);
 assert.equal(empty.summary.calendarDays,0);assert.equal(empty.assessment.status,'insufficient_evidence');
});
test('research criteria distinguish insufficiency, failed criteria and preliminary results',()=>{
 assert.deepEqual(PERFORMANCE_DEFAULTS,{minClosedTrades:100,minCalendarDays:30,minProfitFactor:1.2,extraExecutionCostBpsPerSide:5});
 const sufficient=Array.from({length:100},(_,i)=>trade(i+1,i%2?-1:2));
 const r=evaluate(sufficient);assert.equal(r.assessment.status,'preliminary_only');assert.equal(r.assessment.promotionAuthorized,false);
 const failed=evaluate(sufficient.map(t=>({...t,profit_abs:-1})));assert.equal(failed.assessment.status,'criteria_not_met');
 const sameDay=evaluate(sufficient.map(t=>({...t,open_timestamp:base,close_timestamp:base+3600000})));
 assert.equal(sameDay.assessment.status,'insufficient_evidence');assert.equal(sameDay.summary.calendarDays,1);
});
test('unversioned and previous experiments never count as current-version evidence',()=>{
 const trades=Array.from({length:100},(_,i)=>trade(i+1,i%2?-1:2));
 const r=evaluate(trades,{tradeVersions:{1:'current',2:'previous'},currentVersion:'current'});
 assert.equal(r.aggregateAssessment.status,'preliminary_only');assert.equal(r.assessment.status,'insufficient_evidence');
 assert.equal(r.currentVersion.summary.closedTrades,1);assert.equal(r.currentVersion.summary.netRealizedUsdt,'2');
 assert.equal(r.cohorts.version.find(c=>c.key==='unversioned').summary.closedTrades,98);
 assert.equal(r.currentVersion.assessment.scope,'current_version_closed_trades');
});
test('invalid accounting, currency, chronology and duplicate IDs invalidate assessment without hiding diagnostics',()=>{
 for(const patch of [{profit_abs:null},{profit_abs:'NaN'},{profit_abs:true},{quote_currency:'BTC'},
  {pair:'BTC/USDC'},{open_timestamp:null},{close_timestamp:null},{close_timestamp:base-1},{close_timestamp:Date.parse('2027-01-01T00:00:00Z')}]){
  const r=evaluate([trade(1,1,patch),trade(2,2)]);
  assert.equal(r.assessment.status,'insufficient_evidence');assert.equal(r.summary.pnlComplete,false);assert.equal(r.summary.netRealizedUsdt,null);
  assert.ok(r.diagnostics.length);assert.equal(r.summary.knownValidOutcomes.netRealizedUsdt,'2');
 }
 const duplicate=evaluate([trade(1,1),trade(1,2)]);assert.equal(duplicate.summary.closedTrades,0);
 assert.equal(duplicate.diagnostics.filter(d=>d.code==='DUPLICATE_TRADE_ID').length,2);
 assert.equal(evaluate([trade(1,1)],{observedAt:'not a date'}).summary.pnlComplete,false);
});
test('open PnL never contaminates realized returns; futures are isolated and grouped by direction/leverage',()=>{
 const r=evaluate([trade(1,2),trade(2,999,{is_open:true,close_timestamp:null})]);
 assert.equal(r.summary.openTrades,1);assert.equal(r.summary.closedTrades,1);assert.equal(r.summary.netRealizedUsdt,'2');
 const f=evaluate([trade(1,-2,{pair:'BTC/USDT:USDT'}),trade(2,4,{pair:'ETH/USDT:USDT',is_short:true,leverage:2,stake_amount:150})],{mode:'demo-futures'});
 assert.equal(f.summary.netRealizedUsdt,'2');assert.equal(f.cohorts.direction.find(c=>c.key==='short').summary.netRealizedUsdt,'4');
 assert.equal(f.cohorts.leverage.length,2);assert.equal(f.cohorts.stake.length,2);
 assert.ok(evaluate([trade(1,1,{pair:'BTC/USDT:USDT'})]).diagnostics.some(d=>d.code==='TRADE_MODE_MISMATCH'));
});
test('execution stress uses actual filled quote turnover and does not double subtract reported fees',()=>{
 const t=trade(1,1.8,{orders:orders(1),fee_open_cost:.1,fee_close_cost:.102,nr_of_successful_entries:1,nr_of_successful_exits:1});
 const r=evaluate([t],{thresholds:{extraExecutionCostBpsPerSide:10}});
 assert.equal(r.summary.netRealizedUsdt,'1.8');assert.equal(r.executionCostStress.available,true);
 assert.equal(r.executionCostStress.entryFilledQuoteTurnoverUsdt,'100');assert.equal(r.executionCostStress.exitFilledQuoteTurnoverUsdt,'102');
 assert.equal(r.executionCostStress.extraExecutionCostUsdt,'0.202');assert.equal(r.executionCostStress.stressedNetRealizedUsdt,'1.598');
 const shortOrders=orders(2);shortOrders[0].ft_order_side='sell';shortOrders[1].ft_order_side='buy';
 assert.equal(evaluate([trade(2,2,{pair:'BTC/USDT:USDT',is_short:true,orders:shortOrders})],{mode:'demo-futures'}).executionCostStress.available,true);
});

test('native stop fills count actual turnover in both directions without inferring missing fills',()=>{
 for(const short of [false,true]){
  const pair=short?'BTC/USDT:USDT':'BTC/USDT',items=orders(1);
  items[0].ft_order_side=short?'sell':'buy';items[1].ft_order_side='stoploss';items[1].pair=pair;
  const t=trade(1,-1,{pair,is_short:short,orders:items,nr_of_successful_entries:1,nr_of_successful_exits:0});
  const r=evaluate([t],{mode:short?'demo-futures':'demo'});
  assert.equal(r.executionCostStress.available,true);assert.equal(r.executionCostStress.stressedNetRealizedUsdt,'-1.101');
  assert.equal(evaluate([{...t,nr_of_successful_exits:1}],{mode:short?'demo-futures':'demo'}).executionCostStress.available,false);
  for(const patch of [{ft_is_entry:true},{pair:'OTHER/USDT'},{side:short?'sell':'buy'},{cost:null}]){
   const bad={...t,orders:[items[0],{...items[1],...patch}]};
   assert.equal(evaluate([bad],{mode:short?'demo-futures':'demo'}).executionCostStress.available,false);
  }
 }
});
test('cost stress does not fabricate turnover from stake, price, missing fills or incomplete order history',()=>{
 for(const changed of [undefined,orders(1).slice(0,1),orders(1).map((o,i)=>i?{...o,cost:null}:o),
  orders(1).map((o,i)=>i?{...o,is_open:true}:o),orders(1).map(o=>({...o,order_id:'duplicate'})),
  orders(1).map((o,i)=>i?{...o,remaining:.2}:o)]){
  const r=evaluate([trade(1,2,{orders:changed})]);assert.equal(r.executionCostStress.available,false);
  assert.equal(r.executionCostStress.stressedNetRealizedUsdt,null);assert.equal(r.executionCostStress.extraExecutionCostUsdt,null);
 }
 const partial=evaluate([trade(1,2,{orders:orders(1)}),trade(2,3)]);
 assert.equal(partial.executionCostStress.coveredTrades,1);assert.equal(partial.executionCostStress.available,false);
 const mismatch=evaluate([trade(1,2,{orders:orders(1),nr_of_successful_entries:2})]);
 assert.equal(mismatch.executionCostStress.missing[0].reason,'fill_count_mismatch');
});
test('close-day span does not grow when a stale report is evaluated later and missing days remain absent',()=>{
 const r=evaluate([trade(1,-1),trade(30,3)]);
 assert.equal(r.summary.calendarDays,30);assert.equal(r.summary.observedCloseDays,2);assert.equal(r.daily.length,2);
 assert.throws(()=>evaluate([],{thresholds:{minClosedTrades:0}}),/INVALID_THRESHOLDS/);
 assert.throws(()=>evaluate([],{thresholds:{unknown:1}}),/INVALID_THRESHOLDS/);
});
test('explicit trade mode, direction, leverage and stake must match the project environment',()=>{
 for(const patch of [{trading_mode:'futures'},{trading_mode:null},{is_short:true},{leverage:2},
  {leverage:null},{leverage:'oops'},{leverage:1.5},{leverage:0},{stake_amount:null},{stake_amount:-1},{stake_amount:0}]){
  const r=evaluate([trade(1,2,patch)]);
  assert.equal(r.summary.pnlComplete,false);assert.equal(r.assessment.status,'insufficient_evidence');assert.ok(r.diagnostics.length);
 }
 for(const patch of [{trading_mode:'spot'},{leverage:4},{leverage:'Infinity'}]){
  const r=evaluate([trade(1,2,{pair:'BTC/USDT:USDT',...patch})],{mode:'demo-futures'});
  assert.equal(r.summary.pnlComplete,false);
 }
 assert.equal(evaluate([trade(1,2,{trading_mode:'spot'})]).summary.pnlComplete,true);
 assert.equal(evaluate([trade(1,2,{pair:'BTC/USDT:USDT',trading_mode:'futures',is_short:true,leverage:3})],{mode:'demo-futures'}).summary.pnlComplete,true);
});
test('extreme exponents cannot become silent zeroes, infinite ratios or huge output strings',()=>{
 for(const value of [Infinity,NaN,'1e309','1e-9999999999999999999','1e9999999999999999999','0x10',' '.repeat(10000)+'1','9'.repeat(10000)]){
  const r=evaluate([trade(1,value),trade(2,2)]);
  assert.equal(r.summary.pnlComplete,false);assert.equal(r.summary.profitFactor,null);
  assert.ok(r.diagnostics.some(d=>d.code==='INVALID_NET_PNL'));assert.ok(JSON.stringify(r).length<20000);
 }
 const r=evaluate([trade(1,'1e100'),trade(2,'-1e-100'),trade(3,2)]);
 assert.equal(r.summary.pnlComplete,true);assert.ok(Number.isFinite(r.summary.profitFactor));
 assert.equal(r.summary.netRealizedUsdt,'1'+'0'.repeat(99)+'1.'+'9'.repeat(100));
 const aggregate=evaluate([...Array.from({length:11},(_,i)=>trade(i+1,'1e100')),trade(12,-1)],
  {thresholds:{minClosedTrades:12,minCalendarDays:12}});
 assert.equal(aggregate.assessment.status,'preliminary_only');
});
test('stress rejects contradictory fills and quote cost while accepting harmless decimal rounding',()=>{
 const cases=[
  {amount:.5},{amount:null},{filled:0,remaining:0,cost:0},{filled:1.1},{remaining:.2},
  {average:200},{average:'NaN'},{cost:'1e99999'},
  {status:'canceled',filled:.5,remaining:.5,cost:51}
 ];
 for(const patch of cases){const records=orders(1);records[1]={...records[1],...patch};
  const r=evaluate([trade(1,2,{orders:records})]);assert.equal(r.executionCostStress.available,false);
  assert.equal(r.executionCostStress.stressedNetRealizedUsdt,null);
 }
 const records=orders(1);records[1].amount=1.000000000000001;records[1].cost=102.000000001;
 assert.equal(evaluate([trade(1,2,{orders:records})]).executionCostStress.available,true);
 const duplicateZero=orders(1);duplicateZero.push({...duplicateZero[0],filled:0,remaining:1,cost:0,status:'canceled'});
 assert.equal(evaluate([trade(1,2,{orders:duplicateZero})]).executionCostStress.missing[0].reason,'missing_or_duplicate_order_id');
});
test('exact filled stake cohorts do not silently assume intended rounded order sizes',()=>{
 const r=evaluate([trade(1,2,{stake_amount:'299.99'}),trade(2,-1,{stake_amount:'299.98'})]);
 assert.deepEqual(r.cohorts.stake.map(c=>c.key),['299.98','299.99']);
 assert.ok(r.limitations.some(note=>note.includes('intended order size is not inferred')));
});
