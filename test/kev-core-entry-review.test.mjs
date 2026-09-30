import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {quoteMarkout,commonNonoverlap,evaluateCoreSnapshot} from '../scripts/kev-core-entry-review.mjs';
import {entryCost} from '../src/trading-costs.mjs';

const AT=Date.parse('2026-09-29T03:00:10.000Z');
const book=(at,bid='100',ask='100.02',bidQ='100',askQ='100')=>({at,requestAt:at-100,updateId:at,
 bids:Array.from({length:5},(_,i)=>[new Decimal(bid).minus(new Decimal(i).mul('.001')).toFixed(),bidQ]),
 asks:Array.from({length:5},(_,i)=>[new Decimal(ask).plus(new Decimal(i).mul('.001')).toFixed(),askQ])});
const path=(bid='102',ask='102.02')=>({issues:[],samples:Array.from({length:91},(_,i)=>({book:book(AT+i*10000,bid,ask),recordId:'proof-'+i}))});
function row(mode='demo',action='buy'){
 return {at:AT,split:'development',mode,action,entryBook:book(AT-1000,'100','100.02'),staticRiskSizing:{quantity:'1'},
  cost:{status:'ok',buyRate:'.001',sellRate:'.001',slippageBpsPerSide:5,fundingReserveBps:mode==='demo'?'0':'1'}};
}
test('markouts use full quantity depth and charge fees/slippage exactly once for spot and both futures sides',()=>{
 for(const [mode,action]of [['demo','buy'],['demo-futures','open-long'],['demo-futures','open-short']]){
  const value=row(mode,action),long=action!=='open-short',result=quoteMarkout(value,path(),300),entry=new Decimal(long?'100.02':'100').mul(long?'1.0005':'.9995'),
   exit=new Decimal(long?'102':'102.02').mul(long?'.9995':'1.0005').mul(mode==='demo'?'.999':'1'),
   expected=mode==='demo'?exit.mul('.999').minus(entry):exit.minus(entry).mul(long?1:-1).minus(entry.mul('.001')).minus(exit.mul('.001'));
  assert.equal(result.status,'displayed_depth_fee_scenario');assert.ok(new Decimal(result.netBeforeFundingUsdt).minus(expected).abs().lt('1e-12'));
  assert.equal(result.exitBookAt,AT+300000);assert.equal(result.entryDepthAgeMs,1000);
  if(mode==='demo')assert.equal(result.spotEntryFeeBase,'0.001');
  else {assert.equal(result.netUsdt,null);assert.equal(result.actualFunding,'unknown_no_point_in_time_cashflow_ledger');
   assert.ok(new Decimal(result.netAfterReservedFundingUsdt).minus(expected.minus(entry.mul('.0001'))).abs().lt('1e-12'));}
 }
});
test('markouts never select a later best quote and refuse depth shortages, gaps and holdout leakage',()=>{
 const p=path();p.samples[31].book=book(AT+310000,'900','900.02');
 assert.equal(quoteMarkout(row(),p,300).exitBookAt,AT+300000);
 const gap=path();gap.samples=gap.samples.filter(s=>s.book.at<AT+100000||s.book.at>AT+150000);
 assert.equal(quoteMarkout(row(),gap,300).reason,'QUOTE_PATH_GAP');
 const shallow=row();shallow.staticRiskSizing.quantity='501';assert.match(quoteMarkout(shallow,path(),300).reason,/ENTRY_INSUFFICIENT_DISPLAYED_DEPTH/);
 const future=row();future.entryBook.at=AT+1;assert.equal(quoteMarkout(future,path(),300).reason,'ENTRY_DEPTH_STALE_OR_FUTURE');
 const leaked=row();leaked.at=Date.parse('2026-09-29T04:44:00Z');leaked.entryBook.at=leaked.at;
 assert.equal(quoteMarkout(leaked,path(),300).reason,'DEVELOPMENT_HORIZON_CROSSES_HOLDOUT');
 const incomplete=path();incomplete.issues.push({reason:'missing',range:{from:AT+1,to:AT+2}});
 assert.equal(quoteMarkout(row(),incomplete,300).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
});
test('one common nonoverlap cohort is selected from all signal arms without future outcomes',()=>{
 const make=(key,at,arms,extra={})=>({key,at,mode:'demo',pair:'ETH/USDT',arms,...extra});
 const rows=[make('new',1000,{coherent:true}),make('same-time-other-arm',1000,{legacyOne:true}),make('old',2000,{legacyTwo:true}),make('other',3000,{legacyOne:true},{pair:'BTC/USDT'}),make('next',321001,{legacyTwo:true})];
 assert.deepEqual(commonNonoverlap(rows.reverse(),300).map(r=>r.key),['new','same-time-other-arm','other','next']);
});
function snapshot(at=AT,id='first',opposed=true){
 const pair='ETH/USDT',source='https://demo-api.binance.com',books=[-20000,-10000,0].map((delta,i)=>book(at+delta,new Decimal('100').plus(new Decimal(i).mul('.01')).toFixed(),new Decimal('100.002').plus(new Decimal(i).mul('.01')).toFixed(),opposed?'1':'2',opposed?'2':'1')),
  proof={version:'sampled-demo-flow-v1',mode:'demo',pair,source,startTime:at-61000,endTime:at-1000,books,
   trades:[[-20000,'3',false],[-15000,'2',true],[-10000,'3',false],[-1000,'2',true]].map(([d,q,m],a)=>({a,T:at+d,p:'100',q,m}))};
 const market={mode:'demo',pair,source,timeframe:'order-flow',verifiedSpot:true,bid:books[2].bids[0][0],ask:books[2].asks[0][0],orderFlow:proof,
  filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'100000',stepSize:'.001'},{filterType:'MARKET_LOT_SIZE',minQty:'0',maxQty:'100000',stepSize:'0'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]};
 market.spreadBps=new Decimal(market.ask).minus(market.bid).div(market.bid).mul(10000).toNumber();
 const costFacts={mode:'demo',kind:'costs',readOnly:true,source,observedAt:new Date(at).toISOString(),rates:[{pair,status:'ok',buyRate:'.001',sellRate:'.001',method:'recorded'}]};
 const costs={maxAgeSeconds:300,slippageBpsPerSide:5,priceSpaceBufferBps:30,fundingReserveEvents:1};
 market.entryCost=entryCost(costFacts,market,'demo',costs,at);
 return {costs,policy:{mode:'demo',pairs:[pair],maxStakeUsdt:'300',maxExposureUsdt:'900',maxSpreadBps:20,maxPriceMoveBps:100},snapshot:{id,mode:'demo',entryPolicyVersion:'kev-order-flow-v1',timeframe:'order-flow',createdAt:new Date(at).toISOString(),completedAt:new Date(at).toISOString(),
  decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:Math.floor(at/60000)*60000,markets:[market],costFacts,
  clock:{mode:'demo',source:source+'/api/v3/time',requestStartedAt:at-100,receivedAt:at,serverTime:at-50}}};
}
test('historical evaluation preserves raw proofs and separates new signal from original single/two-window gates',()=>{
 const opposed=snapshot(),before=structuredClone(opposed.snapshot),value=evaluateCoreSnapshot(opposed.snapshot,{policy:opposed.policy,costConfig:opposed.costs});
 assert.deepEqual(value.rows[0].arms,{legacyOne:false,legacyTwo:false,coherent:true});assert.equal(value.rows[0].common.eligible,true);
 assert.equal(value.rows[0].legacy.reason,'FLOW_TAPE_BOOK_MISMATCH');assert.deepEqual(opposed.snapshot,before);
 const first=snapshot(AT,'first',false),a=evaluateCoreSnapshot(first.snapshot,{policy:first.policy,costConfig:first.costs});
 assert.deepEqual(a.rows[0].arms,{legacyOne:true,legacyTwo:false,coherent:true});
 const second=snapshot(AT+60000,'second',false),b=evaluateCoreSnapshot(second.snapshot,{policy:second.policy,costConfig:second.costs,confirmationState:a.confirmationState});
 assert.equal(b.rows[0].arms.legacyTwo,true);
 const reversed=snapshot(),market=reversed.snapshot.markets[0];market.bid='99.999';market.ask='100';
 market.spreadBps=new Decimal(market.ask).minus(market.bid).div(market.bid).mul(10000).toNumber();
 market.entryCost=entryCost(reversed.snapshot.costFacts,market,'demo',reversed.costs,AT);
 const c=evaluateCoreSnapshot(reversed.snapshot,{policy:reversed.policy,costConfig:reversed.costs});
 assert.equal(c.rows[0].common.eligible,true);assert.equal(c.rows[0].arms.coherent,false);
 assert.ok(c.rows[0].coherent.reasons.includes('KEV_SIGNAL_EXECUTION_PRICE_NOT_CONFIRMED'));
});
