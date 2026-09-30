// Read-only research: archived depth is an observation, never a guaranteed fill.
import {readFile, readdir, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import Decimal from 'decimal.js';
import {clockRange} from '../src/exchange-clock.mjs';
import {QUOTE_PATH_ARCHIVE_VERSION,quotePathDigest} from '../src/quote-path-archive.mjs';

const D=Decimal.clone({precision:40});
const hash=text=>createHash('sha256').update(text).digest('hex');
const finite=value=>{try{const d=new D(value);return d.isFinite()?d:null;}catch{return null;}};
const positive=value=>{const d=finite(value);return d?.gt(0)?d:null;};
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const modeSource={demo:'https://demo-api.binance.com','demo-futures':'https://demo-fapi.binance.com'};

// A five-level REST depth snapshot has no exchange event time and can disappear
// before an order arrives. This is a quantity-aware *displayed-liquidity* quote.
export function depthExitQuote(book,quantity,isShort){
 const needed=positive(quantity),bids=book?.bids,asks=book?.asks;
 if(!needed||!Array.isArray(bids)||!Array.isArray(asks)||!bids.length||!asks.length)return {status:'invalid_depth'};
 const parse=rows=>rows.map(row=>Array.isArray(row)&&row.length===2?[positive(row[0]),positive(row[1])]:[null,null]);
 const buy=parse(bids),sell=parse(asks);
 if([...buy,...sell].some(([p,q])=>!p||!q)||buy[0][0].gte(sell[0][0])||
   buy.some(([p],i)=>i&&p.gte(buy[i-1][0]))||sell.some(([p],i)=>i&&p.lte(sell[i-1][0])))return {status:'invalid_depth'};
 const levels=isShort?sell:buy;let left=needed,notional=new D(0),used=0;
 for(const [price,available] of levels){const taken=D.min(left,available);notional=notional.plus(taken.mul(price));left=left.minus(taken);used++;if(left.isZero())break;}
 if(left.gt(0))return {status:'insufficient_displayed_depth',requiredQuantity:needed.toFixed(),
  displayedQuantity:needed.minus(left).toFixed()};
 return {status:'observed_depth_scenario',side:isShort?'buy':'sell',quantity:needed.toFixed(),
  bestPrice:levels[0][0].toFixed(),vwap:notional.div(needed).toFixed(),grossQuote:notional.toFixed(),levelsUsed:used};
}

function entryEvidence(trade,mode){
 const short=mode==='demo-futures'&&trade?.is_short===true,side=short?'sell':'buy';
 if(!trade||!Number.isSafeInteger(trade.trade_id)||!positive(trade.amount)||!positive(trade.open_rate)||
  !Number.isSafeInteger(trade.open_timestamp)||!Array.isArray(trade.orders)||
  trade.nr_of_successful_entries!==1||(trade.nr_of_successful_exits??0)>1)return {status:'entry_shape_unverified'};
 const entries=trade.orders.filter(o=>o?.ft_is_entry===true||
  (o?.ft_is_entry===undefined&&o?.ft_order_side===side&&o?.ft_order_tag===trade.enter_tag));
 if(entries.length!==1)return {status:'entry_fill_unverified'};
 const order=entries[0],quantity=positive(order.filled),price=positive(order.average??order.safe_price),cost=positive(order.cost),at=order.order_filled_timestamp;
 if(order.status!=='closed'||order.is_open!==false||order.ft_order_side!==side||
  order.ft_order_tag!==trade.enter_tag||!quantity||!price||!cost||!Number.isSafeInteger(at)||
  Math.abs(at-trade.open_timestamp)>15_000||
  cost.minus(quantity.mul(price)).abs().gt(D.max('0.00000001',cost.mul('0.0000001'))))return {status:'entry_fill_unverified'};
 return {status:'verified_entry_fill',at,quantity:quantity.toFixed(),price:price.toFixed(),cost:cost.toFixed(),orderId:String(order.order_id)};
}

function feeScenario(trade,entry,quote,mode){
 if(entry.status!=='verified_entry_fill'||quote.status!=='observed_depth_scenario')return {status:'unavailable'};
 const exitRate=finite(trade.fee_close),openRate=finite(trade.fee_open),openValue=positive(trade.open_trade_value);
 if(!exitRate||exitRate.lt(0)||exitRate.gte('0.1')||!openRate||openRate.lt(0)||openRate.gte('0.1')||!openValue)
  return {status:'fee_or_entry_accounting_unavailable'};
 const qty=new D(quote.quantity),exitGross=new D(quote.grossQuote),entryQty=new D(entry.quantity),enginePrice=positive(trade.open_rate);
 if(!enginePrice||typeof trade.is_short!=='boolean'||mode==='demo'&&trade.is_short||
  (trade.trading_mode!==undefined&&trade.trading_mode!==(mode==='demo'?'spot':'futures'))||
  (mode==='demo-futures'?!qty.eq(entryQty):qty.gt(entryQty)))return {status:'entry_accounting_mismatch'};
 // The installed engine rounds its average open rate to the exchange tick.
 // Check it against the actual weighted fill before trusting the engine value.
 const tick=trade.precision_mode_price===4?positive(trade.price_precision):
  trade.precision_mode_price===2&&Number.isSafeInteger(trade.price_precision)&&trade.price_precision>=0&&trade.price_precision<=18
   ?new D(10).pow(-trade.price_precision):null;
 const epsilon=D.max('0.00000001',enginePrice.mul('0.00000001'));
 if(enginePrice.minus(entry.price).abs().gt(D.max(epsilon,tick??0)))return {status:'entry_accounting_mismatch'};
 const expectedOpen=qty.mul(enginePrice).mul(trade.is_short?new D(1).minus(openRate):new D(1).plus(openRate));
 if(openValue.minus(expectedOpen).abs().gt(D.max('0.00000001',expectedOpen.mul('0.0000000001'))))
  return {status:'entry_accounting_mismatch'};
 // fee_open_cost can use the unrounded max stake while open_trade_value uses
 // the reconciled trade quantity. Match calculate_profit's actual basis; do
 // not subtract fee_open_cost again or assume its currency label is USDT.
 const exitFee=exitGross.mul(exitRate),netBeforeFunding=trade.is_short
  ?openValue.minus(exitGross.plus(exitFee)):exitGross.minus(exitFee).minus(openValue);
 // A final history funding total (even zero) does not prove funding at an
 // earlier book timestamp. Historical futures totals remain unknown until a
 // separately evidenced point-in-time funding ledger is available.
 const fundingKnown=mode==='demo';
 return {status:fundingKnown?'quote_only_net_scenario':'quote_only_funding_unknown',
  netUsdt:fundingKnown?netBeforeFunding.toFixed():null,netBeforeFundingUsdt:netBeforeFunding.toFixed(),modeledExitFeeUsdt:exitFee.toFixed(),
  entryCostBasis:'verified_engine_open_trade_value_including_open_fee',
  fundingBasis:fundingKnown?'not_applicable':'historical_funding_unverified',
  note:'Displayed depth and fee-rate scenario only; no exit order or executable fill is inferred.'};
}

export function auditTradePath({mode,trade,snapshots,observedAt,maxGapMs=20_000}={}){
 if(!Object.hasOwn(modeSource,mode)||!Array.isArray(snapshots)||stamp(observedAt)===null)throw Error('PATH_AUDIT_INPUT_INVALID');
 const entry=entryEvidence(trade,mode),asOf=stamp(observedAt),end=trade?.is_open===false?Math.min(asOf,trade.close_timestamp??-1):asOf;
 const result={mode,tradeId:trade?.trade_id??null,pair:trade?.pair??null,isOpen:trade?.is_open??null,
  entry,observedAt,samples:[],coverage:{status:'unavailable',gapCount:null,maxGapMs:null},
  conclusion:'No counterfactual fill, realized PnL or win-rate claim.'};
 if(entry.status!=='verified_entry_fill'||!Number.isSafeInteger(end)||end<entry.at){result.coverage.reason='entry_or_time_unverified';return result;}
 const seen=new Map();
 for(const item of snapshots){
  const snapshot=item.snapshot??item,sha256=item.sha256??null;
  if(snapshot?.mode!==mode||!Array.isArray(snapshot.markets)||!snapshot.markets.some(m=>m.pair===trade.pair))continue;
  const market=snapshot.markets.find(m=>m.pair===trade.pair);
  if(market.source!==modeSource[mode]||market.mode!==mode||market.orderFlow?.pair!==trade.pair||
   market.orderFlow?.source!==modeSource[mode]||
   (mode==='demo'?market.verifiedSpot!==true:market.verifiedFutures!==true))continue;
  let clockValid=true;
  try{clockRange(snapshot.clock,mode,snapshot.clock?.receivedAt);if(snapshot.clock.receivedAt>asOf)clockValid=false;}catch{clockValid=false;}
  for(const [index,book] of (market.orderFlow?.books??[]).entries()){
   const at=book?.at,requestAt=book?.requestAt;
   if(!Number.isSafeInteger(at)||at<entry.at||at>end)continue;
   const bookHash=quotePathDigest({at,requestAt,updateId:book.updateId,bids:book.bids,asks:book.asks}),previous=seen.get(at);
   if(previous){
    if(previous.bookHash!==bookHash){previous.row.quote={status:'conflicting_same_timestamp_depth'};previous.row.feeScenario={status:'unavailable'};}
    continue;
   }
   const timing=clockValid&&Number.isSafeInteger(requestAt)&&requestAt<=at&&at-requestAt<=1_500&&
    Math.abs(snapshot.clock.receivedAt-at)<=60_000;
   const quote=timing?depthExitQuote(book,trade.amount,trade.is_short===true):{status:'timestamp_or_clock_unverified'};
   const row={at:new Date(at).toISOString(),timeBasis:'local_REST_depth_receipt_not_exchange_event_time',
    requestDurationMs:Number.isSafeInteger(requestAt)?at-requestAt:null,snapshotId:snapshot.id??null,
    snapshotSha256:sha256,bookIndex:index,bookUpdateId:book.updateId??null,
    ...(item.archiveEvidence?{archiveEvidence:item.archiveEvidence}:{}),
    quote,feeScenario:feeScenario(trade,entry,quote,mode)};
   result.samples.push(row);seen.set(at,{bookHash,row});
  }
 }
 result.samples.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const valid=result.samples.filter(s=>s.quote.status==='observed_depth_scenario');
 const times=[entry.at,...valid.map(s=>Date.parse(s.at)),end],gaps=[];
 for(let i=1;i<times.length;i++)if(times[i]-times[i-1]>maxGapMs)gaps.push({from:new Date(times[i-1]).toISOString(),to:new Date(times[i]).toISOString(),gapMs:times[i]-times[i-1]});
 result.coverage={status:valid.length&&gaps.length===0?'sampled_without_large_gaps':'incomplete',
  requiredMaxGapMs:maxGapMs,validDepthSamples:valid.length,totalSamples:result.samples.length,
  gapCount:gaps.length,maxGapMs:Math.max(0,...gaps.map(g=>g.gapMs)),gaps:gaps.slice(0,20),
  limitation:'Snapshots sample displayed five-level depth; continuous order-book state and actual exit fills remain unknown.'};
 return result;
}

async function readQuoteArchive({mode,archiveDir,windows,asOf}){
 const names=(await readdir(archiveDir)).filter(name=>/^quotes-\d+-[a-f0-9-]+-\d+\.jsonl$/.test(name)).sort();
 const snapshots=[],errors=[],unavailableSamples=[],seen=new Set();let checkedRecords=0,selectedRecords=0,unavailableRecords=0,unavailableObservations=0,totalBytes=0;
 let lastTelemetry=null,lastTelemetryAt=null;
 for(const file of names){
  const path=join(archiveDir,file),info=await stat(path);totalBytes+=info.size;
  if(totalBytes>512*1024*1024){errors.push({file,reason:'ARCHIVE_READ_BUDGET_EXCEEDED'});break;}
  // A concurrent append can leave an incomplete last line. Do not interpret
  // that line as a complete observation or silently declare the source whole.
  const stream=createReadStream(path,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  let lineNumber=0;
  try{for await(const line of lines){lineNumber++;if(!line)continue;let errorWindow=null;
   try{
    if(Buffer.byteLength(line)>256*1024)throw Error('ARCHIVE_RECORD_TOO_LARGE');
    const record=JSON.parse(line),{recordId,...body}=record;
    if(!/^[a-f0-9]{64}$/.test(recordId??'')||quotePathDigest(body)!==recordId)throw Error('ARCHIVE_CHECKSUM_MISMATCH');
    if(record.version!==QUOTE_PATH_ARCHIVE_VERSION||record.hashEncoding!=='sha256-canonical-json-excluding-recordId'||
     record.mode!==mode||record.usedForEntries!==false||!Array.isArray(record.observations)||
     !Number.isSafeInteger(record.observedAt)||record.observedAt<=0||!Number.isSafeInteger(record.completedAt)||
     record.completedAt<record.observedAt)throw Error('ARCHIVE_ENVELOPE_INVALID');
    // Scope a later validation error only when checksum-verified timestamps
    // contain every retained book. Corrupt/unknown timestamps stay unscoped.
    if(record.observations.every(o=>o?.book===null||Number.isSafeInteger(o?.book?.at)&&o.book.at>=record.observedAt&&o.book.at<=record.completedAt))
     errorWindow={from:record.observedAt,to:record.completedAt,basis:'checksum_verified_record_envelope'};
    const pairPattern=mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/;
    const wholeRoundUnavailable=record.clock===null;
    if(wholeRoundUnavailable){
     // The collector deliberately records a failed round without inventing a
     // clock or book. It is missing market coverage, not damaged archive data.
     if(record.observations.length!==0||!Array.isArray(record.missingPairs)||!record.missingPairs.length||
      new Set(record.missingPairs.map(p=>p?.pair)).size!==record.missingPairs.length||
      record.missingPairs.some(p=>!pairPattern.test(p?.pair??'')||typeof p.reason!=='string'||!p.reason.length||p.reason.length>256))
      throw Error('ARCHIVE_UNAVAILABLE_ENVELOPE_INVALID');
    }else{
     if(record.clock?.receivedAt!==record.observedAt)throw Error('ARCHIVE_ENVELOPE_INVALID');
     clockRange(record.clock,mode,record.completedAt);
    }
    checkedRecords++;
    if(seen.has(recordId))continue;seen.add(recordId);
    if(record.completedAt>asOf)continue;
    if(lastTelemetryAt===null||record.completedAt>lastTelemetryAt){lastTelemetryAt=record.completedAt;lastTelemetry=record.telemetry??null;}
    if(wholeRoundUnavailable){unavailableRecords++;
     if(windows.some(w=>record.completedAt>=w.from&&record.observedAt<=w.to))unavailableSamples.push({recordId,file,line:lineNumber,
      observedAt:record.observedAt,completedAt:record.completedAt,missingPairs:record.missingPairs,telemetry:record.telemetry??null});
     continue;
    }
    const markets=[];let selected=false;
    for(const observation of record.observations){
     const pattern=mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/;
     if(!pattern.test(observation.pair??'')||observation.source!==modeSource[mode]||
      !/^[a-f0-9]{64}$/.test(observation.rawProofSha256??'')||observation.rawProofHashEncoding!=='sha256-canonical-json'||
      observation.rawProofRetained!==false)throw Error('ARCHIVE_OBSERVATION_INVALID');
     if(observation.dataStatus!=='ok'||!observation.book){unavailableObservations++;continue;}
     const book=observation.book;
     if(!Number.isSafeInteger(book.at)||!Number.isSafeInteger(book.requestAt)||!Number.isSafeInteger(book.updateId)||book.updateId<0||
      book.requestAt<record.clock.receivedAt||book.at<book.requestAt||book.at>record.completedAt||
      book.bids?.length!==5||book.asks?.length!==5||depthExitQuote(book,'0.000000000001',false).status==='invalid_depth')
      throw Error('ARCHIVE_BOOK_INVALID');
     if(!windows.some(w=>book.at>=w.from&&book.at<=w.to))continue;
     selected=true;markets.push({mode,pair:observation.pair,source:observation.source,
      verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',orderFlow:{mode,pair:observation.pair,source:observation.source,books:[book]}});
    }
    if(selected){selectedRecords++;snapshots.push({sha256:recordId,snapshot:{id:recordId,mode,clock:record.clock,markets},
     archiveEvidence:{file,line:lineNumber,recordId,recordChecksumVerified:true,rawProofIndependentlyVerified:false,
      note:'The envelope checksum covers retained depth; the original full tape proof was not retained.'}});}
   }catch(error){errors.push({file,line:lineNumber,reason:/^ARCHIVE_|^CLOCK_/.test(error.message)?error.message:'ARCHIVE_RECORD_INVALID',
    ...(errorWindow?{timeRange:errorWindow}:{})});}
  }}catch{errors.push({file,line:lineNumber,reason:'ARCHIVE_READ_FAILED'});}finally{lines.close();stream.destroy();}
  if(info.size){const tailStream=createReadStream(path,{start:info.size-1,end:info.size-1});let tail='';for await(const chunk of tailStream)tail+=chunk.toString('utf8');
   if(tail!=='\n')errors.push({file,reason:'ARCHIVE_PARTIAL_LAST_LINE'});}
 }
 return {snapshots,unavailableSamples,source:{archiveDir:resolve(archiveDir),chunkFiles:names.length,checkedRecords,selectedRecords,unavailableRecords,
  selectedUnavailableRecords:unavailableSamples.length,unavailableSamples:unavailableSamples.slice(0,20),unavailableObservations,
  totalBytes,lastTelemetryAt:lastTelemetryAt===null?null:new Date(lastTelemetryAt).toISOString(),lastTelemetry,
  checksumScope:'Retained envelope and depth only; unavailable original tape proof cannot be reconstructed from rawProofSha256.',errors}};
}

export async function auditFromFiles({mode,historyFile,runsDir=null,archiveDir=null,tradeId=null}={}){
 if(!Object.hasOwn(modeSource,mode)||!historyFile||(!runsDir&&!archiveDir))throw Error('PATH_AUDIT_ARGS_INVALID');
 const historyRaw=await readFile(historyFile,'utf8'),history=JSON.parse(historyRaw);
 if(history.mode!==mode||stamp(history.observedAt)===null||!Array.isArray(history.trades))throw Error('PATH_AUDIT_HISTORY_INVALID');
 const trades=history.trades.filter(t=>tradeId===null||t.trade_id===tradeId);
 const windows=trades.map(t=>({from:t.open_timestamp??Infinity,to:t.is_open===false?t.close_timestamp??-Infinity:Date.parse(history.observedAt)}));
 const files=runsDir?(await readdir(runsDir)).filter(f=>f.endsWith('.snapshot.json')).sort():[],snapshots=[],skipped=[];
 for(const file of files){
  const path=join(runsDir,file),info=await stat(path),mtime=info.mtimeMs;
  // Files are created at snapshot completion; this bounds the read set. A
  // copied archive with altered mtimes must use original files/metadata.
  if(!windows.some(w=>mtime>=w.from-90_000&&mtime<=w.to+90_000))continue;
  try{const raw=await readFile(path,'utf8');snapshots.push({snapshot:JSON.parse(raw),sha256:hash(raw)});}
  catch(error){skipped.push({file,reason:error.code??'invalid_snapshot'});}
 }
 const selectedSnapshotFiles=snapshots.length,archive=archiveDir?await readQuoteArchive({mode,archiveDir,windows,asOf:Date.parse(history.observedAt)}):null;
 // Prefer the checked archive's original per-round clock over a later minute
 // snapshot carrying the same depth observation.
 if(archive)snapshots.unshift(...archive.snapshots);
 const reports=trades.map(trade=>auditTradePath({mode,trade,snapshots,observedAt:history.observedAt}));
 if(archive)for(const report of reports){
  const trade=trades.find(t=>t.trade_id===report.tradeId),from=report.entry.at??trade.open_timestamp,
   to=trade.is_open===false?Math.min(Date.parse(history.observedAt),trade.close_timestamp):Date.parse(history.observedAt);
  const applicableErrors=archive.source.errors.filter(error=>!error.timeRange||error.timeRange.to>=from&&error.timeRange.from<=to);
  report.coverage.sourceComplete=applicableErrors.length===0;report.coverage.sourceErrorCount=applicableErrors.length;
  if(applicableErrors.length&&report.coverage.status==='sampled_without_large_gaps')report.coverage.status='source_incomplete';
  const unavailable=archive.unavailableSamples.filter(sample=>sample.completedAt>=from&&sample.observedAt<=to&&sample.missingPairs.some(p=>p.pair===trade.pair));
  report.coverage.unavailableRecords=unavailable.length;report.coverage.unavailableSamples=unavailable.slice(0,20);
  if(unavailable.length&&report.coverage.status==='sampled_without_large_gaps')report.coverage.status='sampled_with_unavailable_rounds';
 }
 return {version:'kev-depth-path-audit-v2',mode,observedAt:history.observedAt,
  source:{historyFile:resolve(historyFile),historySha256:hash(historyRaw),runsDir:runsDir?resolve(runsDir):null,
   selectedSnapshotFiles,skipped,...(archive?{quoteArchive:archive.source}:{})},
  readOnly:true,ordersSubmitted:0,changesApplied:0,
  trades:reports,
  caveat:'File mtime narrows legacy snapshots only; quote archives use verified record timestamps. Every quote is displayed liquidity at REST receipt only; no replayed fill, historical win-rate uplift or exit promotion is implied. Historical futures net including funding stays unknown without point-in-time funding evidence.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const match=/^--([a-z-]+)=(.+)$/.exec(arg);if(!match)throw Error('Usage: --mode=demo --history=FILE [--runs-dir=DIR] [--archive-dir=DIR] [--trade-id=N]');return [match[1],match[2]];}));
 if(Object.keys(args).some(k=>!['mode','history','runs-dir','archive-dir','trade-id'].includes(k))||
  (args['trade-id']!==undefined&&!/^[1-9]\d*$/.test(args['trade-id'])))throw Error('PATH_AUDIT_ARGS_INVALID');
 console.log(JSON.stringify(await auditFromFiles({mode:args.mode,historyFile:args.history,runsDir:args['runs-dir'],archiveDir:args['archive-dir'],
  tradeId:args['trade-id']===undefined?null:Number(args['trade-id'])}),null,2));
}
