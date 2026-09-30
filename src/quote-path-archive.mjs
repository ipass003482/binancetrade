// Public quote-depth evidence only. No account, order, strategy or network API.
// Records are immutable observations, never fills or an entry authorization.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import Decimal from 'decimal.js';
import {writeJson} from './io.mjs';
import {clockRange} from './exchange-clock.mjs';

export const QUOTE_PATH_ARCHIVE_VERSION='kev-quote-path-archive-v1';
export const QUOTE_PATH_GAP_MS=20000;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
export const quotePathDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validTime=value=>Number.isSafeInteger(value)&&value>0;
function checkedBook(proof,clock,mode,completedAt){
 try{
  const raw=proof?.books?.at(-1);
  if(!raw||!validTime(raw.at)||!validTime(raw.requestAt)||raw.requestAt>raw.at||raw.at>completedAt||
   !Number.isSafeInteger(raw.updateId)||raw.updateId<0)throw Error();
  // The depth response follows this round's checked time request. Validation
  // is independent of tape liquidity, trade direction and entry eligibility.
  clockRange(clock,mode,raw.at);
  const book={at:raw.at,requestAt:raw.requestAt,updateId:raw.updateId};
  for(const side of ['bids','asks']){
   if(!Array.isArray(raw[side])||raw[side].length!==5)throw Error();
   book[side]=raw[side].map((level,index)=>{
    if(!Array.isArray(level)||level.length!==2)throw Error();
    const [p,q]=level.map(value=>{if(!['string','number'].includes(typeof value))throw Error();
     const n=new Decimal(value);if(!n.isFinite()||n.lte(0)||Math.abs(n.e)>50)throw Error();return n;});
    if(index&&(side==='bids'?p.gte(raw[side][index-1][0]):p.lte(raw[side][index-1][0])))throw Error();
    return [...level];
   });
  }
  if(new Decimal(book.bids[0][0]).gte(book.asks[0][0]))throw Error();
  return book;
 }catch{return null;}
}

export function makeQuotePathRecord(sample,{mode,pairs=[],recordingStartedAt,previousBookAt={},telemetry={}}={}){
 if(!['demo','demo-futures'].includes(mode)||sample?.mode!==mode||!validTime(sample.observedAt))throw Error('QUOTE_ARCHIVE_SAMPLE_INVALID');
 const completedAt=sample.completedAt??sample.observedAt;
 if(!validTime(completedAt)||completedAt<sample.observedAt)throw Error('QUOTE_ARCHIVE_SAMPLE_INVALID');
 const expectedSource=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const clock=sample.clock?{mode:sample.clock.mode,source:sample.clock.source,requestStartedAt:sample.clock.requestStartedAt,
  receivedAt:sample.clock.receivedAt,serverTime:sample.clock.serverTime}:null;
 const observations=[],missingPairs=[];
 for(const pair of pairs){
  const proof=sample.markets?.[pair];
  if(!proof){missingPairs.push({pair,reason:sample.diagnostics?.[pair]?.reason??sample.failureReason??'FLOW_PROOF_MISSING'});continue;}
  const book=proof.mode===mode&&proof.pair===pair&&proof.source===expectedSource?checkedBook(proof,clock,mode,completedAt):null;
  const prior=previousBookAt[pair]??null,gapMs=book&&prior!==null?book.at-prior:null;
  observations.push({pair,source:proof.source,rawProofSha256:quotePathDigest(proof),
   rawProofHashEncoding:'sha256-canonical-json',rawProofRetained:false,book,
   dataStatus:book?'ok':'unavailable',reason:book?null:'QUOTE_BOOK_OR_CLOCK_INVALID',
   previousBookAt:prior,gapMs,gapDetected:gapMs!==null&&(gapMs<0||gapMs>QUOTE_PATH_GAP_MS),
   bookRepeated:gapMs===0});
 }
 const body={version:QUOTE_PATH_ARCHIVE_VERSION,usedForEntries:false,mode,collectorVersion:sample.collectorVersion??null,
  pid:sample.pid??null,recordingStartedAt,observedAt:sample.observedAt,completedAt,clock,
  hashEncoding:'sha256-canonical-json-excluding-recordId',observations,missingPairs,
  telemetry:{...telemetry,gapThresholdMs:QUOTE_PATH_GAP_MS},
  limitations:'Sampled depth is not a fill guarantee. Full tape cannot be reconstructed from its hash. Fees and at-quote funding must be joined independently.'};
 return {recordId:quotePathDigest(body),...body};
}

// Exactly one pending write, with explicit dropped-sample telemetry. Disk use
// stops at a fixed budget; no retained observation is deleted to make room.
export function createQuotePathArchive(local,{mode,pairs=[],now=()=>Date.now(),
 maxBytes=256*1024*1024,chunkBytes=4*1024*1024,maxRecordBytes=256*1024,
 appendRecord=null,persistStatus=null}={}){
 if(!['demo','demo-futures'].includes(mode)||![maxBytes,chunkBytes,maxRecordBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('QUOTE_ARCHIVE_OPTIONS');
 const directory=join(local,'quote-path-research'),instanceId=randomUUID(),recordingStartedAt=now();
 let pending=null,closed=false,initialized=false,totalBytes=0,chunkSize=0,part=0,capacityFull=false;
 const previousBookAt={},status={version:QUOTE_PATH_ARCHIVE_VERSION,usedForEntries:false,mode,instanceId,recordingStartedAt,
  budgetBytes:maxBytes,recordsWritten:0,skippedBusySamples:0,invalidSamples:0,writeFailures:0,
  droppedSince:null,lastDroppedAt:null,lastWrittenAt:null,firstRetainedAt:null,firstRetainedAtScope:'current-instance',
  retentionPolicy:'stop-on-budget-full-no-deletion'};
 const saveStatus=persistStatus??(value=>writeJson(join(directory,'status.json'),value));
 const drop=()=>{const at=now();status.droppedSince??=at;status.lastDroppedAt=at;};
 async function append(line){
  if(appendRecord)return appendRecord(line);
  await mkdir(directory,{recursive:true});
  if(!initialized){
   const files=(await readdir(directory)).filter(file=>file.endsWith('.jsonl'));
   for(const file of files)totalBytes+=(await stat(join(directory,file))).size;
   initialized=true;
  }
  const bytes=Buffer.byteLength(line);
  if(totalBytes+bytes>maxBytes)throw Error('QUOTE_ARCHIVE_BUDGET_FULL');
  if(chunkSize&&chunkSize+bytes>chunkBytes){part++;chunkSize=0;}
  const path=join(directory,`quotes-${recordingStartedAt}-${instanceId}-${part}.jsonl`);
  const file=await open(path,'a+',0o600);
  try{
   const {size}=await file.stat();
   if(size){const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);if(tail[0]!==10)throw Error('QUOTE_ARCHIVE_TORN_WRITE');}
   await file.writeFile(line,'utf8');await file.sync();
  }finally{await file.close();}
  totalBytes+=bytes;chunkSize+=bytes;
 }
 function record(sample){
  if(closed||capacityFull)return;
  if(pending){status.skippedBusySamples++;drop();return;}
  let row,line;
  try{
   row=makeQuotePathRecord(sample,{mode,pairs,recordingStartedAt,previousBookAt,telemetry:{skippedBusySamples:status.skippedBusySamples,
    invalidSamples:status.invalidSamples,writeFailures:status.writeFailures,droppedSince:status.droppedSince,lastDroppedAt:status.lastDroppedAt}});
   line=JSON.stringify(row)+'\n';if(Buffer.byteLength(line)>maxRecordBytes)throw Error('QUOTE_ARCHIVE_RECORD_TOO_LARGE');
  }catch{
   status.invalidSamples++;status.state='unavailable';status.reason='QUOTE_ARCHIVE_SAMPLE_INVALID';drop();
   pending=Promise.resolve().then(()=>saveStatus({...status,totalBytes,updatedAt:now()}))
    .catch(()=>{status.statusWriteFailed=true;}).finally(()=>{pending=null;});return;
  }
  pending=(async()=>{
   try{
    await append(line);
    status.recordsWritten++;status.lastWrittenAt=row.completedAt;status.firstRetainedAt??=row.observedAt;
    for(const observation of row.observations)if(observation.book)previousBookAt[observation.pair]=observation.book.at;
    status.state='recording';delete status.reason;
   }catch(error){
    capacityFull=error?.message==='QUOTE_ARCHIVE_BUDGET_FULL';status.state=capacityFull?'budget_full':'unavailable';
    status.reason=capacityFull?'QUOTE_ARCHIVE_BUDGET_FULL':'QUOTE_ARCHIVE_WRITE_FAILED';status.writeFailures++;drop();
   }
   try{await saveStatus({...status,totalBytes,lastBookAtByPair:{...previousBookAt},updatedAt:now()});}catch{status.statusWriteFailed=true;}
  })().finally(()=>{pending=null;});
 }
 record.close=async()=>{closed=true;if(pending)await pending;
  try{await saveStatus({...status,totalBytes,lastBookAtByPair:{...previousBookAt},updatedAt:now()});}catch{status.statusWriteFailed=true;}};
 record.status=()=>({...status,totalBytes,capacityFull,pending:Boolean(pending)});
 return record;
}
