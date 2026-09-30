import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {makeQuotePathRecord,quotePathDigest} from '../src/quote-path-archive.mjs';
import {compareKevNetHarvestReplay,compareKevNetExitReplay,FROZEN_EXIT_POLICIES} from '../src/kev-net-exit-replay.mjs';

const B=Date.parse('2026-09-29T03:00:00Z');
function trade(qty='1',mode='demo'){
 const fee=mode==='demo'?'.001':'.0004',cost=new Decimal(qty).mul(100).toFixed();
 return {trade_id:8,pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',is_short:false,is_open:true,
  amount:qty,open_rate:'100',open_timestamp:B,fee_open:fee,fee_close:fee,
  open_trade_value:new Decimal(cost).mul(new Decimal(1).plus(fee)).toFixed(),
  trading_mode:mode==='demo'?'spot':'futures',enter_tag:'codex-original-approved-fill',nr_of_successful_entries:1,nr_of_successful_exits:0,
  precision_mode_price:4,price_precision:'.00001',orders:[{ft_is_entry:true,status:'closed',is_open:false,ft_order_side:'buy',
   ft_order_tag:'codex-original-approved-fill',filled:qty,average:'100',cost,order_filled_timestamp:B,order_id:'123'}]};
}
function path(fn=()=> '100',mode='demo'){
 const pair=trade('1',mode).pair,source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 return Array.from({length:92},(_,i)=>{
  const at=B+i*10000,p=new Decimal(fn(i*10000)),clock={mode,source:source+(mode==='demo'?'/api/v3/time':'/fapi/v1/time'),
   requestStartedAt:at-3,receivedAt:at-2,serverTime:at-2};
  const book={at,requestAt:at-1,updateId:at,bids:[],asks:[]};
  for(let j=0;j<5;j++){book.bids.push([p.minus(new Decimal('.01').mul(j)).toFixed(),'10']);book.asks.push([p.plus('.02').plus(new Decimal('.01').mul(j)).toFixed(),'10']);}
  return makeQuotePathRecord({mode,clock,observedAt:at-2,completedAt:at,markets:{[pair]:{mode,pair,source,books:[book]}}},
   {mode,pairs:[pair],recordingStartedAt:B-10,previousBookAt:{}});
 });
}
function options(rows,t=trade(),slip='0'){
 return {mode:t.trading_mode==='spot'?'demo':'demo-futures',trade:t,archiveFiles:[{name:'quotes-fixture.jsonl',text:rows.map(r=>JSON.stringify(r)).join('\n')+'\n'}],
  observedAt:new Date(B+940000).toISOString(),adverseSlippageBps:slip};
}
const arm=(r,p='net_harvest')=>r.results.find(a=>a.policy===p);

test('net harvest retains original gross target at every age including middle stage for small notional',()=>{
 for(const age of [290000,300000,590000,600000,890000,900000]){
  const r=compareKevNetHarvestReplay(options(path(t=>t>=age?'101.6':'100'),trade('.1')));
  assert.equal(r.status,'indicative_comparison');
  for(const a of r.results){assert.equal(a.signal.at,B+age);assert.equal(a.signal.reason,'rules_target');}
  assert.equal(r.comparison.harvestMinusBaselineNetUsdt,'0');
 }
 const fixture=options(path(t=>t>=300000?'101.6':'100'),trade('.1'));
 const original=compareKevNetExitReplay(fixture),harvest=compareKevNetHarvestReplay(fixture);
 assert.equal(arm(original,'staged').signal.at,B+600000);
 assert.equal(arm(harvest).signal.at,B+300000);
 assert.equal(original.version,'kev-net-exit-displayed-depth-v1');
 assert.equal(original.policies,FROZEN_EXIT_POLICIES);
 assert.ok(Object.hasOwn(original.comparison,'stagedMinusBaselineNetUsdt'));
 assert.ok(!Object.hasOwn(original.comparison,'harvestMinusBaselineNetUsdt'));
});

test('additional net targets use actual fee-adjusted values and next quote with adverse slippage',()=>{
 const middle=compareKevNetHarvestReplay(options(path(age=>age>=300000?'101.3':'100')));
 assert.equal(arm(middle).signal.reason,'net_harvest_1usdt');assert.equal(arm(middle).signal.at,B+300000);
 assert.equal(arm(middle).signal.targetNetUsdt,'1');assert.equal(arm(middle).exit.at,B+310000);
 const late=compareKevNetHarvestReplay(options(path(age=>age===600000?'100.36':age>600000?'100.1':'100'),trade(),'10'));
 assert.equal(arm(late).signal.reason,'net_harvest_10bps');assert.equal(arm(late).signal.targetNetUsdt,'0.1');
 assert.equal(arm(late).exit.at,B+610000);assert.ok(new Decimal(arm(late).signal.netUsdt).gt(0));
 assert.ok(new Decimal(arm(late).exit.netUsdt).lt(0));assert.equal(arm(late,'baseline').signal.reason,'rules_time');
 const justGross=compareKevNetHarvestReplay(options(path(age=>age>=300000?'101.05':'100')));
 assert.notEqual(arm(justGross).signal.at,B+300000);assert.equal(arm(justGross).signal.at,B+600000);
});

test('frozen5bps signal reserve is fee-aware and independent from0/5/10bps next-quote stresses',()=>{
 const rows=path(age=>age===600000?'100.35':age===610000?'100.36':age>=620000?'100.1':'100');
 for(const stress of ['0','5','10']){
  const r=compareKevNetHarvestReplay(options(rows,trade(),stress)),h=arm(r);
  assert.equal(h.signal.at,B+610000);assert.equal(h.signal.thresholdExitSlippageBps,'5');
  assert.equal(h.signal.thresholdNetUsdt,'0.10951018');
  assert.equal(h.signal.netUsdt,'0.15964');
  assert.equal(h.exit.at,B+620000);
  const expected=new Decimal('100.1').mul(new Decimal(1).minus(new Decimal(stress).div(10000))).mul('.999').minus('100.1');
  assert.equal(h.exit.netUsdt,expected.toFixed());
 }
});

test('short net harvest buys full ask quantity with adverse reserve and signed known funding',()=>{
 const t=trade('1','demo-futures');t.is_short=true;t.open_trade_value='99.96';t.orders[0].ft_order_side='sell';
 const body={version:'kev-funding-event-ledger-v1',mode:'demo-futures',pair:t.pair,tradeId:t.trade_id,quantity:t.amount,
  source:'https://demo-fapi.binance.com',basis:'trade_cashflows',coverageFrom:B,coverageThrough:B+940000,observedAt:B+940000,complete:true,
  events:[{id:'funding-1',at:B+200000,knownAt:B+200000,netUsdt:'-.01'}]};
 const rows=path(age=>age===600000?'99.78':age===610000?'99.72':age>=620000?'100':'100','demo-futures');
 const r=compareKevNetHarvestReplay({...options(rows,t,'10'),fundingEvidence:{recordId:quotePathDigest(body),...body}}),h=arm(r);
 assert.equal(h.signal.at,B+610000);assert.equal(h.signal.reason,'net_harvest_10bps');
 const expectedSignal=new Decimal('99.96').minus(new Decimal('99.74').mul('1.0005').mul('1.0004')).minus('.01');
 assert.equal(h.signal.thresholdNetUsdt,expectedSignal.toFixed());assert.equal(h.exit.side,'buy');
 assert.equal(h.exit.scenarioExitPrice,new Decimal('100.02').mul('1.001').toFixed());
 assert.equal(h.exit.netUsdt,new Decimal('99.96').minus(new Decimal('100.02').mul('1.001').mul('1.0004')).minus('.01').toFixed());
});

test('original stop, trail and cap retain priority and do not wait for net profitability',()=>{
 const cap=compareKevNetHarvestReplay(options(path(age=>age>=900000?'100.4':'100')));
 for(const a of cap.results){assert.equal(a.signal.at,B+900000);assert.equal(a.signal.reason,'rules_time');}
 const stopped=compareKevNetHarvestReplay(options(path(age=>age>=900000?'99.4':'100')));
 for(const a of stopped.results)assert.equal(a.signal.reason,'rules_stop');
 const trail=compareKevNetHarvestReplay(options(path(age=>age===100000?'101':age>=110000?'99':'100')));
 for(const a of trail.results){assert.equal(a.signal.reason,'rules_profit_trail');assert.equal(a.signal.at,B+110000);}
 const loss=compareKevNetHarvestReplay(options(path()));
 for(const a of loss.results){assert.equal(a.signal.reason,'rules_time');assert.equal(a.exit.netUsdt,'-0.2');}
});

test('variant does not bypass depth, immutable evidence, funding or missing-path checks',()=>{
 const bad=path();bad[1].observations[0].book.bids[0][0]='999';
 assert.equal(arm(compareKevNetHarvestReplay(options(bad))).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
 const gap=path().slice(3);assert.equal(arm(compareKevNetHarvestReplay(options(gap))).reason,'QUOTE_PATH_GAP');
 const noFunding=compareKevNetHarvestReplay(options(path(()=> '100','demo-futures'),trade('1','demo-futures')));
 assert.equal(arm(noFunding).reason,'POINT_IN_TIME_FUNDING_EVIDENCE_UNAVAILABLE');assert.equal(noFunding.comparison,null);
 assert.equal(noFunding.actualTradeWinRate,null);assert.equal(noFunding.automaticPromotion,false);
 const lateMissing=compareKevNetHarvestReplay(options(path().slice(0,-1)));
 assert.equal(arm(lateMissing).reason,'NEXT_OBSERVATION_UNAVAILABLE');assert.equal(lateMissing.comparison,null);
});
