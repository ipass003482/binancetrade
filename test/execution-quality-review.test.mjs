import test from 'node:test';
import assert from 'node:assert/strict';
import {entryId} from '../src/entry-identity.mjs';
import {reviewExecutionQuality,EXECUTION_QUALITY_REVIEW_VERSION} from '../src/execution-quality-review.mjs';

const B=Date.parse('2026-09-15T10:00:00Z'),iso=n=>new Date(B+n).toISOString();
function fixture({mode='demo',short=false,quantity=.5,entry=100,fill=97,stop=98,net='-1.6'}={}){
 const pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',sid='00000000-0000-4000-8000-000000000001',
  id=entryId(sid,pair,'per-pair-cycle-v1'),tag='codex-'+id,action=mode==='demo'?'buy':short?'open-short':'open-long';
 const riskPolicy={version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'};
 const order=(orderId,price,side,at,isEntry)=>({order_id:orderId,pair,amount:quantity,filled:quantity,remaining:0,cost:price*quantity,
  average:price,safe_price:price,price:price+10,ft_order_side:side,ft_is_entry:isEntry,ft_order_tag:isEntry?tag:null,
  status:'closed',is_open:false,order_filled_timestamp:B+at,order_timestamp:B+at,order_type:isEntry?'market':'stoploss'});
 const trade={trade_id:1,pair,enter_tag:tag,is_open:false,is_short:short,trading_mode:mode==='demo'?'spot':'futures',
  open_timestamp:B+1500,close_timestamp:B+61000,profit_abs:net,amount:quantity,open_rate:entry,close_rate:fill,
  exit_reason:'stoploss_on_exchange',stop_loss_abs:stop,initial_stop_loss_abs:stop-2,fee_open_cost:2,fee_close_cost:3,
  orders:[order('entry-1',entry,short?'sell':'buy',1000,true),order('stop-1',fill,'stoploss',61000,false)]};
 const plan={tag,snapshotId:sid,pair,isShort:short,purpose:'strategy',ruleVersion:'kronos-direction-v12',executionPolicyVersion:'per-pair-cycle-v1',
  createdAt:iso(500),riskBudgetUsdt:1,maxEntryNotionalUsdt:50,stopFraction:.01,riskCostFraction:.002,riskPolicy,
  nativeEntryGuard:{mode,pair,snapshotId:sid,side:short?'short':'long',bridgeQuotePrice:String(entry),quoteFetchedAt:iso(400)}};
 const journal=[{id,at:iso(600),status:'pending',tag,pair,action,tradeId:null,purpose:'strategy',ruleVersion:plan.ruleVersion,
  snapshotId:sid,executionPolicyVersion:plan.executionPolicyVersion,riskPolicy},
 {id,at:iso(1600),status:'submitted',tag,pair,action,tradeId:1}];
 const protection={version:'demo-native-stop-v1',mode,asOf:iso(100000),attempts:[{orderId:'stop-1',pair,side:short?'buy':'sell',
  status:'confirmed',orderStatus:'closed',acceptedAmount:quantity,stopPrice:stop,requestedStopPrice:stop+10,confirmedAt:iso(2000),observedAt:iso(100000)}]};
 return {mode,observedAt:iso(120000),trades:[trade],plansByTag:{[tag]:plan},journal,protection};
}
const row=f=>reviewExecutionQuality(f).rows[0];
const plan=f=>Object.values(f.plansByTag)[0];

test('exact native stop evidence separates adverse gross slippage, planned risk and original net loss without fee deductions',()=>{
 const f=fixture(),before=JSON.stringify(f),r=reviewExecutionQuality(f),x=r.rows[0];
 assert.equal(JSON.stringify(f),before);assert.equal(r.version,EXECUTION_QUALITY_REVIEW_VERSION);
 assert.equal(x.openedAt,iso(1500));assert.equal(x.closedAt,iso(61000));
 assert.equal(x.netRealizedUsdt,'-1.6');assert.equal(x.netUnrealizedUsdt,null);
 assert.equal(x.stopSlippage.status,'verified');assert.equal(x.stopSlippage.referencePrice,'98');assert.equal(x.stopSlippage.fillPrice,'97');
 assert.equal(x.stopSlippage.filledAmount,'0.5');assert.equal(x.stopSlippage.signedUnfavorableUsdt,'0.5');
 assert.equal(x.stopSlippage.classification,'native-stop-execution');assert.match(x.stopSlippage.signedUnfavorableBps,/^102\.040816/);
 assert.equal(x.plannedRisk.status,'verified');assert.equal(x.plannedRisk.budgetUsdt,'1');
 assert.equal(x.plannedRisk.atMaxEntryNotionalUsdt,'0.85');assert.equal(x.plannedRisk.atFilledEntryNotionalUsdt,'0.85');
 assert.equal(x.plannedRisk.actualLossUsdt,'1.6');assert.equal(x.plannedRisk.excessOverBudgetUsdt,'0.6');assert.equal(x.plannedRisk.excessOverPlannedUsdt,'0.75');
 assert.equal(r.summary.netRealizedUsdt,'-1.6');assert.equal(r.summary.verifiedStopSlippage,1);assert.equal(r.summary.lossesOverBudget,1);
});

test('ETH 61 observed price and quantity example explains 0.78725 USDT adverse stop execution, not its whole net loss',()=>{
 const f=fixture({mode:'demo-futures',short:true,quantity:.047,entry:2405.16,fill:2434.74,stop:2417.99,net:'-1.48125012'});
 f.trades[0].orders[0].cost=113.04252;f.trades[0].orders[1].cost=114.43278;
 Object.assign(plan(f),{maxEntryNotionalUsdt:114.84850712,stopFraction:.005334528353212745,riskCostFraction:.002635899418764188});
 plan(f).nativeEntryGuard.bridgeQuotePrice='2405.22';
 const x=row(f);assert.equal(x.stopSlippage.signedUnfavorableUsdt,'0.78725');
 assert.equal(x.entrySlippage.signedUnfavorableUsdt,'0.00282');assert.equal(x.netRealizedUsdt,'-1.48125012');
 assert.equal(x.plannedRisk.excessOverBudgetUsdt,'0.48125012');assert.notEqual(x.stopSlippage.signedUnfavorableUsdt,x.plannedRisk.actualLossUsdt);
});

test('favorable fills retain negative signed slippage and short/long directions use the correct sign',()=>{
 for(const [options,expected] of [[{fill:99,stop:98},'-.5'],[{mode:'demo-futures',short:true,fill:101,stop:102},'-.5']]){
  const f=fixture(options),x=row(f);assert.equal(x.stopSlippage.signedUnfavorableUsdt,String(Number(expected)));
 }
 const long=fixture();plan(long).nativeEntryGuard.bridgeQuotePrice='99';assert.equal(row(long).entrySlippage.signedUnfavorableUsdt,'0.5');
 const short=fixture({mode:'demo-futures',short:true});plan(short).nativeEntryGuard.bridgeQuotePrice='101';assert.equal(row(short).entrySlippage.signedUnfavorableUsdt,'0.5');
});

test('currency precision uses exact recorded notional instead of multiplying back a rounded average',()=>{
 const f=fixture({quantity:3,entry:1/3});f.trades[0].orders[0].cost=1;plan(f).nativeEntryGuard.bridgeQuotePrice='.3';
 const x=row(f);assert.equal(x.entrySlippage.status,'verified');assert.equal(x.entrySlippage.signedUnfavorableUsdt,'0.1');
 assert.equal(x.entrySlippage.fillPrice,'0.33333333333333333333');assert.equal(x.entrySlippage.signedUnfavorableBps,'1111.1111111111111111');
 assert.equal(reviewExecutionQuality(f).summary.signedEntrySlippageUsdt,'0.1');
});

test('exit_reason, close_rate_requested and trade stop fields alone cannot establish an order-specific stop trigger',()=>{
 const f=fixture();f.protection=null;f.trades[0].close_rate_requested=98;
 assert.equal(row(f).stopSlippage.status,'unknown');assert.equal(row(f).stopSlippage.referencePrice,null);
 const g=fixture();g.trades[0].orders[1].ft_order_side='sell';g.trades[0].orders[1].order_type='market';
 assert.equal(row(g).stopSlippage.reason,'FILLED_STOP_ORDER_MISSING');
 const h=fixture();h.trades[0].exit_reason=null;h.trades[0].stop_loss_abs=1;h.trades[0].initial_stop_loss_abs=2;
 assert.equal(row(h).stopSlippage.referencePrice,'98');assert.equal(row(h).stopSlippage.status,'verified');
});

test('requested order price is never substituted for a fill; average and safe_price must agree with actual cost/filled',()=>{
 const f=fixture();f.trades[0].orders[1].price=10;assert.equal(row(f).stopSlippage.fillPrice,'97');
 for(const patch of [{average:undefined,safe_price:undefined},{average:90},{safe_price:90},{cost:1},{average:'NaN'}]){
  const g=fixture();Object.assign(g.trades[0].orders[1],patch);assert.equal(row(g).stopSlippage.status,'unknown');
 }
 const safe=fixture();delete safe.trades[0].orders[1].average;assert.equal(row(safe).stopSlippage.fillPrice,'97');
});

test('base-asset fee amounts and recorded USDT fee fields never get summed into slippage or deducted from net again',()=>{
 const f=fixture(),before=row(f);
 Object.assign(f.trades[0],{fee_open_cost:999,fee_close_cost:333,fee_open_currency:'ETH',fee_close_currency:'USDT',funding_fees:777});
 f.trades[0].orders[0].ft_fee_base=.001;
 const after=row(f);assert.deepEqual(after,before);
});

test('stop reference requires unique order identity, correct side/amount/mode and confirmed native acceptance',()=>{
 const changes=[f=>f.protection.attempts.push({...f.protection.attempts[0]}),f=>f.protection.attempts[0].orderId='other',
  f=>f.protection.attempts[0].pair='BTC/USDT',f=>f.protection.attempts[0].side='buy',f=>f.protection.attempts[0].acceptedAmount=2,
  f=>f.protection.attempts[0].status='unknown',f=>f.protection.attempts[0].stopPrice=null,
  f=>f.protection.attempts[0].confirmedAt=iso(61001),f=>f.protection.mode='demo-futures',f=>f.protection.asOf=iso(120001)];
 for(const mutate of changes){const f=fixture();mutate(f);const x=row(f);assert.equal(x.stopSlippage.status,'unknown');assert.equal(x.stopSlippage.signedUnfavorableUsdt,null);assert.equal(x.netRealizedUsdt,'-1.6');}
 const historical=fixture();historical.protection.attempts[0].orderStatus='open';historical.protection.asOf=iso(3000);
 historical.protection.attempts[0].observedAt=iso(3000);
 assert.equal(row(historical).stopSlippage.status,'verified');
});

test('tiny quantities require exact conservation and cost checks use relative tolerance without an absolute floor',()=>{
 const valid=fixture({quantity:1e-9});assert.equal(row(valid).stopSlippage.status,'verified');
 const missing=fixture({quantity:1e-9});Object.assign(missing.trades[0].orders[1],{filled:5e-10,remaining:0,cost:4.85e-8,status:'canceled'});
 assert.equal(row(missing).stopSlippage.reason,'FILL_NOT_VERIFIED');
 const cost=fixture({quantity:1e-12});cost.trades[0].orders[1].cost=1.94e-10;
 assert.equal(row(cost).stopSlippage.reason,'FILL_PRICE_COST_CONFLICT');
 const quantityNoise=fixture();Object.assign(quantityNoise.trades[0].orders[1],{amount:1,filled:.9,remaining:.10000000000000002,cost:87.3,status:'canceled'});
 quantityNoise.protection.attempts[0].acceptedAmount=1;
 assert.equal(row(quantityNoise).stopSlippage.reason,'FILL_NOT_VERIFIED');
});

test('stop evidence confirmation and observation cannot be newer than their snapshot or outside trade lifetime',()=>{
 const changes=[f=>f.protection.asOf=iso(1999),f=>f.protection.attempts[0].observedAt=iso(100001),
  f=>f.protection.attempts[0].observedAt=iso(1999),f=>f.protection.attempts[0].observedAt=null,
  f=>f.protection.attempts[0].confirmedAt=iso(1499),f=>f.trades[0].orders[1].order_filled_timestamp=B+1499,
  f=>f.trades[0].orders[1].order_filled_timestamp=B+61001];
 for(const change of changes){const f=fixture();change(f);assert.equal(row(f).stopSlippage.status,'unknown');assert.equal(row(f).netRealizedUsdt,'-1.6');}
 const noOptionalObservation=fixture();delete noOptionalObservation.protection.attempts[0].observedAt;
 assert.equal(row(noOptionalObservation).stopSlippage.status,'verified');
});

test('entry timing uses the immutable plan before exchange fill, not later local trade creation, and never postdates close',()=>{
 const valid=fixture();assert.ok(valid.trades[0].orders[0].order_filled_timestamp<valid.trades[0].open_timestamp);
 assert.equal(row(valid).entrySlippage.status,'verified');
 for(const fillAt of [499,61001]){
  const f=fixture();f.trades[0].orders[0].order_filled_timestamp=B+fillAt;
  assert.equal(row(f).entrySlippage.reason,'ENTRY_FILL_TIME_MISMATCH');
  assert.equal(row(f).plannedRisk.atFilledEntryNotionalUsdt,null);
  assert.equal(row(f).plannedRisk.fillRiskReason,'ENTRY_FILL_TIME_MISMATCH');
 }
});

test('only verified stop filled quantity contributes, including terminal partial fills and base-fee-adjusted exit sizes',()=>{
 const f=fixture();Object.assign(f.trades[0].orders[1],{amount:1,filled:.5,remaining:.5,status:'canceled'});f.protection.attempts[0].acceptedAmount=1;
 assert.equal(row(f).stopSlippage.signedUnfavorableUsdt,'0.5');
 const g=fixture();Object.assign(g.trades[0].orders[1],{amount:.499,filled:.499,cost:48.403});g.protection.attempts[0].acceptedAmount=.499;
 assert.equal(row(g).stopSlippage.signedUnfavorableUsdt,'0.499');assert.equal(row(g).plannedRisk.atFilledEntryNotionalUsdt,'0.85');
 for(const patch of [{status:'open',is_open:true},{remaining:1},{filled:0},{order_filled_timestamp:B+120001},{ft_is_entry:true}]){
  const h=fixture();Object.assign(h.trades[0].orders[1],patch);assert.equal(row(h).stopSlippage.status,'unknown');
 }
});

test('multiple or conflicting filled stop IDs stay unknown while identical duplicate components are collapsed',()=>{
 const f=fixture();f.trades[0].orders.push({...f.trades[0].orders[1],order_id:'stop-2'});assert.equal(row(f).stopSlippage.reason,'MULTIPLE_FILLED_STOP_ORDERS');
 const g=fixture();g.trades[0].orders.push({...g.trades[0].orders[1],cost:1});assert.equal(row(g).stopSlippage.reason,'CONFLICTING_ORDER_ID');
 const h=fixture();h.trades[0].orders.push(structuredClone(h.trades[0].orders[1]));assert.equal(row(h).stopSlippage.signedUnfavorableUsdt,'0.5');
});

test('entry and planned risk require an exact original plan plus settled immutable journal, independently of stop evidence',()=>{
 const changes=[f=>f.plansByTag={},f=>plan(f).tag='codex-'+'a'.repeat(32),f=>plan(f).snapshotId='other',
  f=>plan(f).isShort=true,f=>f.journal[1].tradeId=2,f=>f.journal[1].status='unknown',f=>f.journal.push({...f.journal[0]}),
  f=>f.journal[1].riskPolicy={version:'changed'},f=>f.journal[0].pair='BTC/USDT'];
 for(const mutate of changes){const f=fixture();mutate(f);const x=row(f);assert.equal(x.plannedRisk.status,'unknown');assert.equal(x.entrySlippage.status,'unknown');assert.equal(x.stopSlippage.status,'verified');assert.equal(x.netRealizedUsdt,'-1.6');}
});

test('another stop with unknown filled quantity cannot be silently treated as zero',()=>{
 for(const filled of [undefined,null,'NaN',-1]){
  const f=fixture();f.trades[0].orders.push({...f.trades[0].orders[1],order_id:'unknown-stop',filled});
  assert.equal(row(f).stopSlippage.reason,'STOP_FILLED_AMOUNT_UNKNOWN');
  assert.equal(row(f).stopSlippage.signedUnfavorableUsdt,null);assert.equal(row(f).netRealizedUsdt,'-1.6');
 }
 const f=fixture();f.trades[0].orders.push({...f.trades[0].orders[1],order_id:'cancelled-stop',filled:0,status:'canceled'});
 assert.equal(row(f).stopSlippage.status,'verified');
});

test('stake and leverage cannot contradict the entry plan or be changed, nulled or introduced by terminal journal rows',()=>{
 const valid=fixture();valid.journal[0].stakeUsdt='50';valid.journal[0].leverage=1;valid.trades[0].leverage=1;plan(valid).nativeEntryGuard.leverage=1;
 assert.equal(row(valid).plannedRisk.status,'verified');
 const changes=[f=>f.journal[1].stakeUsdt='99',f=>f.journal[1].leverage=2,f=>f.journal[1].stakeUsdt=null,
  f=>f.journal[0].stakeUsdt='99',f=>plan(f).nativeEntryGuard.leverage=2,f=>f.trades[0].leverage=2];
 for(const mutate of changes){const f=structuredClone(valid);mutate(f);assert.equal(row(f).plannedRisk.status,'unknown');assert.equal(row(f).entrySlippage.status,'unknown');}
 const introduced=fixture();introduced.journal[1].stakeUsdt='50';assert.equal(row(introduced).plannedRisk.status,'unknown');
});

test('missing plan risk fields or bridge quote stay unknown without borrowing requested trade prices',()=>{
 for(const mutate of [f=>plan(f).riskBudgetUsdt=null,f=>plan(f).riskCostFraction=null,f=>plan(f).riskPolicy.reserveFraction='0']){
  const f=fixture();mutate(f);assert.equal(row(f).plannedRisk.status,'unknown');assert.equal(row(f).plannedRisk.actualLossUsdt,'1.6');
 }
 for(const mutate of [f=>plan(f).nativeEntryGuard=null,f=>plan(f).nativeEntryGuard.bridgeQuotePrice=null,
  f=>plan(f).nativeEntryGuard.pair='BTC/USDT',f=>plan(f).nativeEntryGuard.quoteFetchedAt=iso(501)]){
  const f=fixture();mutate(f);assert.equal(row(f).entrySlippage.status,'unknown');
 }
});

test('open floating PnL is not an actual loss; wins keep actual loss and excess equal to zero',()=>{
 const f=fixture();Object.assign(f.trades[0],{is_open:true,close_timestamp:null,profit_abs:'-.4'});f.trades[0].orders.pop();
 const r=reviewExecutionQuality(f);assert.equal(r.rows[0].netRealizedUsdt,null);assert.equal(r.rows[0].netUnrealizedUsdt,'-0.4');
 assert.equal(r.rows[0].closedAt,null);assert.equal(r.rows[0].openedAt,iso(1500));
 assert.equal(r.rows[0].plannedRisk.actualLossUsdt,null);assert.equal(r.rows[0].plannedRisk.excessOverBudgetUsdt,null);
 assert.equal(r.summary.netRealizedUsdt,'0');assert.equal(r.summary.netUnrealizedUsdt,'-0.4');
 const win=fixture({net:'.4'});assert.equal(row(win).plannedRisk.actualLossUsdt,'0');assert.equal(row(win).plannedRisk.excessOverBudgetUsdt,'0');
});

test('unknown or hostile numeric PnL never becomes zero, and duplicate trade IDs cannot duplicate losses',()=>{
 for(const value of [undefined,null,'NaN','1e1000000','']){
  const f=fixture();f.trades[0].profit_abs=value;const r=reviewExecutionQuality(f);assert.equal(r.rows[0].netRealizedUsdt,null);assert.equal(r.summary.pnlComplete,false);assert.equal(r.summary.netRealizedUsdt,null);
 }
 const f=fixture();f.trades.push(structuredClone(f.trades[0]));const r=reviewExecutionQuality(f);assert.equal(r.rows.length,1);assert.equal(r.summary.netRealizedUsdt,'-1.6');
 f.trades[1].profit_abs='-9';const bad=reviewExecutionQuality(f);assert.equal(bad.summary.pnlComplete,false);assert.equal(bad.rows[0].stopSlippage.status,'unknown');
});

test('invalid identity and unsupported input are rejected without manufacturing evidence',()=>{
 for(const change of [f=>f.mode='live',f=>f.observedAt='yesterday',f=>f.trades=null,f=>f.journal=null,f=>f.plansByTag=[]]){
  const f=fixture();change(f);assert.throws(()=>reviewExecutionQuality(f),/EXECUTION_REVIEW_INPUT_INVALID/);
 }
 for(const change of [f=>f.trades[0].is_short=true,f=>f.trades[0].trading_mode='futures',f=>f.trades[0].close_timestamp=B+120001,
  f=>f.trades[0].exchange='binance',f=>f.trades[0].quote_currency='ETH',f=>f.trades[0].base_currency='BTC']){
  const f=fixture();change(f);assert.equal(row(f).entrySlippage.status,'unknown');
 }
 const f=fixture();f.trades[0].trade_id=null;const r=reviewExecutionQuality(f);assert.equal(r.rows.length,0);assert.equal(r.summary.pnlComplete,false);
 const invalidDate=fixture();invalidDate.trades[0].close_timestamp=Number.MAX_SAFE_INTEGER;assert.equal(row(invalidDate).closedAt,null);
});
