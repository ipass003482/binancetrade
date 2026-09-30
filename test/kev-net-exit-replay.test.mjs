import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {makeQuotePathRecord,quotePathDigest} from '../src/quote-path-archive.mjs';
import {compareKevNetExitReplay,decodeKevQuoteArchive} from '../src/kev-net-exit-replay.mjs';

const B=Date.parse('2026-09-29T03:00:00Z'),END=B+920000;
const source=mode=>mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
function trade(mode='demo',short=false){
 const fee=mode==='demo'?'.001':'.0004';
 return {trade_id:7,pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',is_short:short,is_open:true,
  amount:'1',open_rate:'100',open_timestamp:B,fee_open:fee,fee_close:fee,
  open_trade_value:new Decimal(100).mul(short?new Decimal(1).minus(fee):new Decimal(1).plus(fee)).toFixed(),
  trading_mode:mode==='demo'?'spot':'futures',enter_tag:'codex-original-approved-fill',nr_of_successful_entries:1,nr_of_successful_exits:0,
  precision_mode_price:4,price_precision:'.00001',orders:[{ft_is_entry:true,status:'closed',is_open:false,ft_order_side:short?'sell':'buy',
   ft_order_tag:'codex-original-approved-fill',filled:'1',average:'100',cost:'100',order_filled_timestamp:B,order_id:'123'}]};
}
function record(at,bid='100',mode='demo',{quantities=null,previousBookAt=null}={}){
 const pair=trade(mode).pair,p=new Decimal(bid),levels=(side)=>Array.from({length:5},(_,i)=>[
  (side==='bids'?p.minus(new Decimal('.01').mul(i)):p.plus('.02').plus(new Decimal('.01').mul(i))).toFixed(),quantities?.[i]??'10']);
 const book={at,requestAt:at-1,updateId:at,bids:levels('bids'),asks:levels('asks')};
 const clock={mode,source:source(mode)+(mode==='demo'?'/api/v3/time':'/fapi/v1/time'),requestStartedAt:at-3,receivedAt:at-2,serverTime:at-2};
 const proof={mode,pair,source:source(mode),books:[book]};
 return makeQuotePathRecord({mode,clock,observedAt:at-2,completedAt:at,markets:{[pair]:proof}},
  {mode,pairs:[pair],recordingStartedAt:B-10,previousBookAt:previousBookAt===null?{}:{[pair]:previousBookAt}});
}
const file=rows=>[{name:'quotes-fixture.jsonl',text:rows.map(r=>JSON.stringify(r)).join('\n')+'\n'}];
function path(fn=()=> '100',mode='demo'){return Array.from({length:92},(_,i)=>record(B+i*10000,fn(i*10000),mode));}
function run(rows,{mode='demo',t=trade(mode),fundingEvidence=null,adverseSlippageBps='0',observedAt=END,...more}={}){
 return compareKevNetExitReplay({mode,trade:t,archiveFiles:file(rows),observedAt:new Date(observedAt).toISOString(),fundingEvidence,adverseSlippageBps,...more});
}
function ledger(t,{events=[],through=END}={}){
 const body={version:'kev-funding-event-ledger-v1',mode:'demo-futures',pair:t.pair,tradeId:t.trade_id,quantity:t.amount,
  source:source('demo-futures'),basis:'trade_cashflows',coverageFrom:B,coverageThrough:through,observedAt:END,complete:true,events};
 return {recordId:quotePathDigest(body),...body};
}
function resign(r){const {recordId,...body}=r;return {recordId:quotePathDigest(body),...body};}
const arm=(r,p='baseline')=>r.results.find(a=>a.policy===p);

test('frozen baseline exits at900 seconds and executes next observation with exact long fees',()=>{
 const r=run(path());assert.equal(r.status,'indicative_comparison');
 for(const a of r.results){assert.equal(a.signal.at,B+900000);assert.equal(a.signal.reason,'rules_time');assert.equal(a.exit.at,B+910000);
  assert.equal(a.exit.netUsdt,'-0.2');assert.equal(a.exit.exitFeeUsdt,'0.1');assert.equal(a.exit.latencyMs,10000);}
 assert.equal(r.comparison.stagedMinusBaselineNetUsdt,'0');assert.equal(r.actualTradeWinRate,null);assert.equal(r.automaticPromotion,false);
 assert.equal(r.approvedEntryMembershipVerified,false);
});

test('full-quantity bids and asks produce VWAP; top-of-book cannot substitute for missing quantity',()=>{
 const rows=path(()=> '99.4');rows[1]=record(B+10000,'99.4','demo',{quantities:['.4','.3','.3','10','10']});
 const r=run(rows);assert.equal(arm(r).signal.reason,'rules_stop');assert.equal(arm(r).exit.displayedVwap,'99.391');
 assert.equal(arm(r).exit.levelsUsed,3);assert.equal(arm(r).exit.netUsdt,new Decimal('99.391').mul('.999').minus('100.1').toFixed());
 const thin=path();thin[10]=record(B+100000,'100','demo',{quantities:['.1','.1','.1','.1','.1']});
 assert.equal(arm(run(thin)).reason,'insufficient_displayed_depth');
 const mode='demo-futures',t=trade(mode,true),shortRows=path(()=> '100.6',mode);shortRows[1]=record(B+10000,'100.6',mode,{quantities:['.4','.3','.3','10','10']});
 const s=run(shortRows,{mode,t,fundingEvidence:ledger(t)});assert.equal(arm(s).exit.displayedVwap,'100.629');
 assert.equal(arm(s).exit.side,'buy');assert.equal(arm(s).exit.netUsdt,new Decimal('99.96').minus(new Decimal('100.629').mul('1.0004')).toFixed());
});

test('next-observation adverse slippage can turn a net-positive staged signal into a loss',()=>{
 const rows=path(age=>age===600000?'100.35':age<600000?'100':'100.1');
 const r=run(rows,{adverseSlippageBps:'10'}),s=arm(r,'staged');
 assert.equal(s.signal.reason,'staged_net_10bps');assert.equal(s.signal.at,B+600000);assert.equal(s.signal.targetNetUsdt,'0.1');
 assert.ok(new Decimal(s.signal.netUsdt).gt(0));assert.equal(s.exit.at,B+610000);assert.ok(new Decimal(s.exit.netUsdt).lt(0));
 assert.equal(s.exit.scenarioExitPrice,'99.9999');assert.equal(arm(r).signal.reason,'rules_time');
});

test('middle stage is exactly1USDT after fees and600second stage uses entry notional10bps',()=>{
 const r=run(path(age=>age>=300000?'101.3':'100'));
 assert.equal(arm(r,'staged').signal.at,B+300000);assert.equal(arm(r,'staged').signal.reason,'staged_net_1usdt');
 assert.equal(arm(r,'staged').signal.targetNetUsdt,'1');assert.equal(arm(r).signal.reason,'rules_time');
 const noGrossSubstitution=run(path(age=>age>=300000?'101.05':'100'));
 assert.notEqual(arm(noGrossSubstitution,'staged').signal.at,B+300000);
 assert.equal(arm(noGrossSubstitution,'staged').signal.at,B+600000);
});

test('trailing protection is persistent and takes precedence over stop, time and lower staged targets',()=>{
 const r=run(path(age=>age===100000?'101':age>=110000?'100.65':'100'));
 for(const a of r.results){assert.equal(a.signal.at,B+110000);assert.equal(a.signal.reason,'rules_profit_trail');
  assert.equal(a.peakObservedNetUsdt,'0.799');assert.ok(new Decimal(a.persistedTrailStopPrice).gt('100.65'));}
 const gapDown=run(path(age=>age===100000?'101':age>=110000?'99':'100'));
 assert.equal(arm(gapDown).signal.reason,'rules_profit_trail');
 const stop=run(path(age=>age>=900000?'99.4':'100'));
 assert.equal(arm(stop,'staged').signal.reason,'rules_stop');
});

test('initial fixed target stays active before300s and staged900s cap overrides profit targets',()=>{
 const early=run(path(age=>age>=290000?'101.6':'100'));
 assert.equal(arm(early,'staged').signal.at,B+290000);assert.equal(arm(early,'staged').signal.reason,'rules_target');
 const cap=run(path(age=>age>=900000?'101.6':'100'));
 assert.equal(arm(cap).signal.reason,'rules_target');assert.equal(arm(cap,'staged').signal.reason,'rules_time');
});

test('futures require explicit funding coverage; final totals and unknown funding are never treated as zero',()=>{
 const mode='demo-futures',t=trade(mode);t.funding_fees=0;
 const missing=run(path(()=> '100',mode),{mode,t});assert.equal(missing.status,'incomplete_evidence');
 assert.equal(arm(missing).reason,'POINT_IN_TIME_FUNDING_EVIDENCE_UNAVAILABLE');assert.equal(missing.comparison,null);
 const known=run(path(()=> '100',mode),{mode,t,fundingEvidence:ledger(t)});
 assert.equal(arm(known).exit.netUsdt,'-0.08');assert.equal(arm(known).exit.signedFundingUsdt,'0');
});

test('signed funding joins only earlier events, rejects late-known events and cannot extend closed-trade cashflows',()=>{
 const mode='demo-futures',t=trade(mode),event={id:'funding-1',at:B+20000,knownAt:B+20000,netUsdt:'.5'};
 const early=run(path(()=> '99.4',mode),{mode,t,fundingEvidence:ledger(t,{events:[event]})});
 assert.equal(arm(early).exit.at,B+10000);assert.equal(arm(early).exit.signedFundingUsdt,'0');
 const received=run(path(()=> '100',mode),{mode,t,fundingEvidence:ledger(t,{events:[event]})});
 assert.equal(arm(received).exit.signedFundingUsdt,'.5'.replace(/^\./,'0.'));assert.equal(arm(received).exit.netUsdt,'0.42');
 const paid=run(path(()=> '100',mode),{mode,t,fundingEvidence:ledger(t,{events:[{...event,netUsdt:'-.1'}]})});assert.equal(arm(paid).exit.netUsdt,'-0.18');
 const late=run(path(()=> '100',mode),{mode,t,fundingEvidence:ledger(t,{events:[{...event,knownAt:B+30000}]})});
 assert.equal(arm(late).reason,'FUNDING_NOT_KNOWN_AT_QUOTE');
 const closed={...t,is_open:false,close_timestamp:B+500000};
 const uncovered=run(path(()=> '100',mode),{mode,t:closed,fundingEvidence:ledger(closed)});assert.equal(arm(uncovered).reason,'FUNDING_COVERAGE_UNAVAILABLE');
 const tampered=ledger(t);tampered.coverageThrough=B+900000;
 assert.equal(arm(run(path(()=> '100',mode),{mode,t,fundingEvidence:tampered})).reason,'POINT_IN_TIME_FUNDING_EVIDENCE_UNAVAILABLE');
});

test('uncovered start, large gaps, missing next tick and future quotes fail comparison explicitly',()=>{
 assert.equal(arm(run(path().slice(3))).reason,'QUOTE_PATH_GAP');
 const gap=path().filter(r=>![B+100000,B+110000].includes(r.completedAt));assert.equal(arm(run(gap)).reason,'QUOTE_PATH_GAP');
 const nextMissing=run(path().slice(0,-1));assert.equal(arm(nextMissing).reason,'NEXT_OBSERVATION_UNAVAILABLE');assert.equal(nextMissing.comparison,null);
 const future=run(path(),{observedAt:B+900000});assert.equal(arm(future).reason,'NEXT_OBSERVATION_UNAVAILABLE');
 assert.equal(arm(run(path(),{observedAt:B+300000})).reason,'TIME_CAP_PATH_UNCOVERED');
});

test('cap replay retains both delayed first cap observation and following execution observation',()=>{
 const rows=Array.from({length:90},(_,i)=>record(B+i*10000));
 rows.push(record(B+899000),record(B+919000),record(B+938000));
 const r=run(rows,{observedAt:B+960000});assert.equal(r.status,'indicative_comparison');
 for(const a of r.results){assert.equal(a.signal.at,B+919000);assert.equal(a.signal.reason,'rules_time');assert.equal(a.exit.at,B+938000);}
 assert.equal(r.sampleWindow.requestedThrough,B+940000);
 assert.match(r.sampleWindow.basis,/not_live_latency_bound/);
});

test('archive checksum corruption, torn tails, invalid clocks and conflicting same-time depth are rejected',()=>{
 const tampered=path();tampered[1].observations[0].book.bids[0][0]='999';
 assert.equal(arm(run(tampered)).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
 const raw=file(path());raw[0].text=raw[0].text.trimEnd();
 const torn=compareKevNetExitReplay({mode:'demo',trade:trade(),archiveFiles:raw,observedAt:new Date(END).toISOString()});
 assert.equal(arm(torn).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
 const badClock=path();badClock[1].clock.serverTime+=10000;badClock[1]=resign(badClock[1]);assert.equal(arm(run(badClock)).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
 const conflict=path();conflict.push(record(B+10000,'100.2'));assert.equal(arm(run(conflict)).reason,'conflicting_same_timestamp_depth');
 const dedup=path();dedup.push(dedup[0]);assert.equal(run(dedup).status,'indicative_comparison');
});

test('honest unavailable rounds and drop telemetry are coverage gaps, never usable zero-price observations',()=>{
 const rows=path(),r=rows[3];rows[3]=resign({...r,clock:null,observations:[],missingPairs:[{pair:trade().pair,reason:'FETCH_FAILED'}]});
 const decoded=decodeKevQuoteArchive({mode:'demo',pair:trade().pair,archiveFiles:file(rows),asOf:END});
 assert.ok(decoded.issues.some(i=>i.reason==='PAIR_OBSERVATION_UNAVAILABLE'));assert.ok(!decoded.issues.some(i=>i.reason==='CLOCK_INVALID'));
 assert.equal(arm(run(rows)).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
 const dropped=path();dropped[3].telemetry={droppedSince:B+20001,lastDroppedAt:B+20001};dropped[3]=resign(dropped[3]);
 assert.equal(arm(run(dropped)).reason,'ARCHIVE_EVIDENCE_INCOMPLETE');
});

test('mismatched entry amount/open value/order tag cannot manufacture a compared approved trade',()=>{
 for(const edit of [t=>({...t,open_trade_value:'1'}),t=>({...t,amount:'2'}),t=>({...t,orders:[{...t.orders[0],ft_order_tag:'other'}]})]){
  const r=run(path(),{t:edit(trade())});assert.equal(r.comparison,null);assert.notEqual(r.status,'indicative_comparison');
 }
 const r=run(path(),{adverseSlippageBps:'-1'});assert.equal(r.status,'unavailable');assert.equal(r.reason,'SLIPPAGE_INVALID');
});
