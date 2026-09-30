import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,utimes,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {depthExitQuote,auditTradePath,auditFromFiles} from '../scripts/kev-executable-path-audit.mjs';
import {makeQuotePathRecord,quotePathDigest} from '../src/quote-path-archive.mjs';

const at=Date.parse('2026-09-29T00:00:00.000Z');
const iso=ms=>new Date(at+ms).toISOString();
const trade={trade_id:525,pair:'BTC/USDT',is_short:false,is_open:true,amount:2,open_rate:100,
 open_timestamp:at,nr_of_successful_entries:1,nr_of_successful_exits:0,
 fee_open_cost:0.2,fee_close:0.001,fee_open:0.001,open_trade_value:200.2,funding_fees:0,
 enter_tag:'codex-0123456789abcdef0123456789abcdef',orders:[{ft_is_entry:true,ft_order_side:'buy',
 ft_order_tag:'codex-0123456789abcdef0123456789abcdef',filled:2,average:100,cost:200,
 order_filled_timestamp:at,status:'closed',is_open:false,order_id:'1'}]};
const book=(ms,bids=[['101','1'],['100','2']],asks=[['102','1'],['103','2']])=>({at:at+ms,requestAt:at+ms-100,
 updateId:1,bids,asks});
const snapshot=(books,mode='demo',pair='BTC/USDT')=>({id:'one',mode,clock:{mode,
 source:mode==='demo'?'https://demo-api.binance.com/api/v3/time':'https://demo-fapi.binance.com/fapi/v1/time',
 requestStartedAt:at-200,receivedAt:at,serverTime:at-100},markets:[{mode,pair,
 source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
 verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',
 orderFlow:{mode,pair,source:mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',books}}]});

test('quantity-aware long exit consumes bid depth and keeps fee-inclusive value a quote scenario',()=>{
 const q=depthExitQuote(book(10_000),2,false);
 assert.equal(q.status,'observed_depth_scenario');
 assert.equal(q.vwap,'100.5');
 const report=auditTradePath({mode:'demo',trade,snapshots:[{snapshot:snapshot([book(10_000),book(20_000)]),sha256:'abc'}],observedAt:iso(30_000)});
 assert.equal(report.entry.status,'verified_entry_fill');
 assert.equal(report.samples.length,2);
 assert.equal(report.samples[0].feeScenario.status,'quote_only_net_scenario');
 assert.equal(report.samples[0].feeScenario.netUsdt,'0.599');
 assert.equal(report.coverage.status,'sampled_without_large_gaps');
 assert.equal(report.samples[0].snapshotSha256,'abc');
 assert.match(report.conclusion,/No counterfactual fill/);
});

test('spot base-fee adjustment uses reconciled engine open value rather than fee_open_cost',()=>{
 const adjusted={...trade,amount:1.99,open_trade_value:199.199,fee_open_cost:0.1,fee_open_currency:'BTC'};
 const report=auditTradePath({mode:'demo',trade:adjusted,
  snapshots:[snapshot([book(10_000,[['101','2']],[['102','2']])])],observedAt:iso(15_000)});
 assert.equal(report.samples[0].quote.grossQuote,'200.99');
 assert.equal(report.samples[0].feeScenario.netUsdt,'1.59001');
 assert.equal(report.samples[0].feeScenario.entryCostBasis,'verified_engine_open_trade_value_including_open_fee');
});

test('actual Spot #532 quantity rounding agrees with engine PnL at its recorded exit quote',()=>{
 const adjusted={...trade,pair:'XRP/USDT',amount:51,open_rate:1.4965,open_trade_value:76.3978215,
  fee_open_cost:0.07639467885000001,fee_open_currency:'XRP',trading_mode:'spot',precision_mode_price:4,price_precision:0.0001,
  orders:[{...trade.orders[0],filled:51.1,average:1.4965,cost:76.47115}]};
 const report=auditTradePath({mode:'demo',trade:adjusted,
  snapshots:[snapshot([book(10_000,[['1.4993','100']],[['1.4994','100']])],'demo','XRP/USDT')],observedAt:iso(15_000)});
 assert.equal(report.samples[0].feeScenario.netUsdt,'-0.0099858');
});

test('short exit buys asks and insufficient depth is never converted to a top quote fill',()=>{
 const short={...trade,pair:'BTC/USDT:USDT',is_short:true,open_trade_value:199.8,orders:[{...trade.orders[0],ft_order_side:'sell'}]};
 const quote=depthExitQuote(book(10_000),2,true);
 assert.equal(quote.vwap,'102.5');
 const report=auditTradePath({mode:'demo-futures',trade:short,
  snapshots:[snapshot([book(10_000)],'demo-futures','BTC/USDT:USDT')],observedAt:iso(15_000)});
 assert.equal(report.samples[0].feeScenario.status,'quote_only_funding_unknown');
 assert.equal(report.samples[0].feeScenario.netUsdt,null);
 assert.equal(report.samples[0].feeScenario.netBeforeFundingUsdt,'-5.405');
 const missing=depthExitQuote(book(10_000,[['101','0.5']],[['102','0.5']]),2,false);
 assert.equal(missing.status,'insufficient_displayed_depth');
 assert.equal(missing.displayedQuantity,'0.5');
});

test('missing fee, missing fill, clock fault and path gaps remain explicitly unavailable',()=>{
 const absentFee=auditTradePath({mode:'demo',trade:{...trade,fee_close:null},
  snapshots:[snapshot([book(10_000)])],observedAt:iso(15_000)});
 assert.equal(absentFee.samples[0].feeScenario.status,'fee_or_entry_accounting_unavailable');
 const missingFill=auditTradePath({mode:'demo',trade:{...trade,orders:[]},snapshots:[],observedAt:iso(30_000)});
 assert.equal(missingFill.entry.status,'entry_fill_unverified');
 assert.equal(missingFill.coverage.status,'unavailable');
 const stale=snapshot([book(10_000)]);stale.clock.serverTime+=5_000;
 const badClock=auditTradePath({mode:'demo',trade,snapshots:[stale],observedAt:iso(30_000)});
 assert.equal(badClock.samples[0].quote.status,'timestamp_or_clock_unverified');
 assert.equal(badClock.coverage.status,'incomplete');
 const gap=auditTradePath({mode:'demo',trade,snapshots:[snapshot([book(10_000)])],observedAt:iso(90_000)});
 assert.equal(gap.coverage.status,'incomplete');
 assert.equal(gap.coverage.maxGapMs,80_000);
});

test('mismatched engine opening value, weighted fill price and futures quantity are rejected',()=>{
 for(const change of [{open_trade_value:199},{open_rate:99},{fee_open:0.002},{trading_mode:'futures'}]){
  const report=auditTradePath({mode:'demo',trade:{...trade,...change},snapshots:[snapshot([book(10_000)])],observedAt:iso(15_000)});
  assert.equal(report.samples[0].feeScenario.status,'entry_accounting_mismatch');
 }
 const futures={...trade,pair:'BTC/USDT:USDT',amount:1.9,open_trade_value:190.19};
 const report=auditTradePath({mode:'demo-futures',trade:futures,
  snapshots:[snapshot([book(10_000)],'demo-futures','BTC/USDT:USDT')],observedAt:iso(15_000)});
 assert.equal(report.samples[0].feeScenario.status,'entry_accounting_mismatch');
});

test('final funding is never applied to an earlier futures quote, including a zero final total',()=>{
 for(const funding of [0,1,-1,null]){
  const futures={...trade,pair:'BTC/USDT:USDT',funding_fees:funding};
  const report=auditTradePath({mode:'demo-futures',trade:futures,
   snapshots:[snapshot([book(10_000)],'demo-futures','BTC/USDT:USDT')],observedAt:iso(15_000)});
  assert.equal(report.samples[0].feeScenario.netUsdt,null);
  assert.equal(report.samples[0].feeScenario.netBeforeFundingUsdt,'0.599');
  assert.equal(report.samples[0].feeScenario.fundingBasis,'historical_funding_unverified');
 }
});

test('file audit hashes explicit history and stored snapshots without writing a result or inventing gaps',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-depth-audit-'));
 try{
  const history=join(dir,'history.json'),runs=join(dir,'runs');
  await (await import('node:fs/promises')).mkdir(runs);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  const file=join(runs,'one.snapshot.json');await writeFile(file,JSON.stringify(snapshot([book(10_000),book(20_000)])));
  await utimes(file,new Date(at+25_000),new Date(at+25_000));
  const report=await auditFromFiles({mode:'demo',historyFile:history,runsDir:runs,tradeId:525});
  assert.equal(report.source.selectedSnapshotFiles,1);
  assert.equal(report.source.historySha256.length,64);
  assert.equal(report.trades[0].samples.length,2);
  assert.equal(report.readOnly,true);
  assert.deepEqual((await readdir(dir)).sort(),['history.json','runs']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const archiveRecord=(ms,{bid='101',quantity='2',mode='demo'}={})=>{
 const pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const depth=book(ms,Array.from({length:5},(_,i)=>[String(Number(bid)-i),quantity]),Array.from({length:5},(_,i)=>[String(Number(bid)+1+i),quantity]));
 const sample={mode,observedAt:at,completedAt:at+ms,pid:123,collectorVersion:'test',clock:snapshot([],mode,pair).clock,
  markets:{[pair]:{mode,pair,source,books:[depth],trades:[]}}};
 return makeQuotePathRecord(sample,{mode,pairs:[pair],recordingStartedAt:at});
};

test('prospective quote archive is readable by verified event fields independent of file mtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-audit-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  const records=[archiveRecord(10_000),archiveRecord(20_000)];
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  await writeFile(file,records.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await utimes(file,new Date(0),new Date(0));
  const report=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(report.source.quoteArchive.checkedRecords,2);assert.equal(report.source.quoteArchive.selectedRecords,2);
  assert.deepEqual(report.source.quoteArchive.errors,[]);
  assert.equal(report.trades[0].samples.length,2);assert.equal(report.trades[0].coverage.status,'sampled_without_large_gaps');
  assert.equal(report.trades[0].samples[0].feeScenario.netUsdt,'1.598');
  assert.equal(report.trades[0].samples[0].archiveEvidence.recordChecksumVerified,true);
  assert.equal(report.trades[0].samples[0].archiveEvidence.rawProofIndependentlyVerified,false);
  assert.equal((await readdir(dir)).length,2,'audit writes no files');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('archive tampering, torn rows and differing depth at the same timestamp remain incomplete',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-invalid-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  const original=archiveRecord(10_000),tampered=structuredClone(original);tampered.observations[0].book.bids[0][0]='100.5';
  await writeFile(file,[original,tampered].map(row=>JSON.stringify(row)).join('\n')+'\n{"torn":');
  const failed=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.ok(failed.source.quoteArchive.errors.some(row=>row.reason==='ARCHIVE_CHECKSUM_MISMATCH'));
  assert.ok(failed.source.quoteArchive.errors.some(row=>row.reason==='ARCHIVE_PARTIAL_LAST_LINE'));
  assert.equal(failed.trades[0].coverage.status,'source_incomplete');assert.equal(failed.trades[0].coverage.sourceComplete,false);
  await writeFile(file,[original,archiveRecord(10_000,{bid:'102'})].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const conflict=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(conflict.trades[0].samples[0].quote.status,'conflicting_same_timestamp_depth');
  assert.equal(conflict.trades[0].coverage.status,'incomplete');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('archive insufficient depth cannot become a fill and future captured records cannot fill an old gap',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-capacity-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  await writeFile(file,[archiveRecord(10_000,{quantity:'0.1'}),archiveRecord(40_000)].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const report=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(report.source.quoteArchive.selectedRecords,1);
  assert.equal(report.trades[0].samples[0].quote.status,'insufficient_displayed_depth');
  assert.equal(report.trades[0].coverage.validDepthSamples,0);assert.equal(report.trades[0].coverage.status,'incomplete');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('healthy, unavailable round, and recovery retain coverage gaps without marking valid archive corrupt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-recovery-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  const unavailable=makeQuotePathRecord({mode:'demo',observedAt:at+20_000,markets:{},failureReason:'HTTP_429'},
   {mode:'demo',pairs:['BTC/USDT'],recordingStartedAt:at,telemetry:{skippedBusySamples:1}});
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(40_000),trades:[trade]}));
  await writeFile(file,[archiveRecord(10_000),unavailable,archiveRecord(30_000)].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const recovered=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(recovered.source.quoteArchive.checkedRecords,3);assert.equal(recovered.source.quoteArchive.unavailableRecords,1);
  assert.deepEqual(recovered.source.quoteArchive.errors,[]);assert.equal(recovered.trades[0].samples.length,2);
  assert.equal(recovered.trades[0].coverage.sourceComplete,true);assert.equal(recovered.trades[0].coverage.unavailableRecords,1);
  assert.equal(recovered.trades[0].coverage.status,'sampled_with_unavailable_rounds');
  assert.equal(recovered.trades[0].coverage.unavailableSamples[0].missingPairs[0].reason,'HTTP_429');
  assert.equal(recovered.trades[0].coverage.unavailableSamples[0].telemetry.skippedBusySamples,1);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(60_000),trades:[trade]}));
  await writeFile(file,[archiveRecord(10_000),unavailable,archiveRecord(50_000)].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const gap=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(gap.trades[0].coverage.sourceComplete,true);assert.equal(gap.trades[0].coverage.status,'incomplete');
  assert.equal(gap.trades[0].coverage.maxGapMs,40_000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('null-clock records cannot smuggle a usable quote or omit required missing-pair evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-clockless-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  for(const mutate of [row=>{row.clock=null;},row=>{row.clock=null;row.observations=[];row.missingPairs=[];}]){
   const original=archiveRecord(10_000);mutate(original);const {recordId,...body}=original;
   await writeFile(file,JSON.stringify({recordId:quotePathDigest(body),...body})+'\n');
   const report=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
   assert.equal(report.trades[0].samples.length,0);assert.equal(report.source.quoteArchive.unavailableRecords,0);
   assert.ok(report.source.quoteArchive.errors.some(error=>error.reason==='ARCHIVE_UNAVAILABLE_ENVELOPE_INVALID'));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('checksum-verified timestamped errors before the trade do not poison its later coverage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kev-archive-scope-'));
 try{
  const history=join(dir,'history.json'),file=join(dir,`quotes-${at}-abc-0.jsonl`);
  await writeFile(history,JSON.stringify({mode:'demo',observedAt:iso(30_000),trades:[trade]}));
  const old=archiveRecord(10_000);old.observedAt-=100_000;old.completedAt-=100_000;
  old.clock.receivedAt-=100_000;old.clock.requestStartedAt-=100_000;old.clock.serverTime-=100_000;
  old.clock.source='https://invalid.example/time';old.observations[0].book.at-=100_000;old.observations[0].book.requestAt-=100_000;
  const {recordId,...body}=old;const timestampedError={recordId:quotePathDigest(body),...body};
  await writeFile(file,[timestampedError,archiveRecord(10_000),archiveRecord(20_000)].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const report=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(report.source.quoteArchive.errors.length,1);assert.equal(report.source.quoteArchive.errors[0].reason,'CLOCK_INVALID');
  assert.ok(report.source.quoteArchive.errors[0].timeRange.to<at);
  assert.equal(report.trades[0].coverage.sourceComplete,true);assert.equal(report.trades[0].coverage.sourceErrorCount,0);
  assert.equal(report.trades[0].coverage.status,'sampled_without_large_gaps');
  timestampedError.completedAt--;
  await writeFile(file,[timestampedError,archiveRecord(10_000),archiveRecord(20_000)].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const corrupt=await auditFromFiles({mode:'demo',historyFile:history,archiveDir:dir});
  assert.equal(corrupt.source.quoteArchive.errors[0].reason,'ARCHIVE_CHECKSUM_MISMATCH');
  assert.equal(corrupt.source.quoteArchive.errors[0].timeRange,undefined);
  assert.equal(corrupt.trades[0].coverage.sourceComplete,false);assert.equal(corrupt.trades[0].coverage.status,'source_incomplete');
 }finally{await rm(dir,{recursive:true,force:true});}
});
