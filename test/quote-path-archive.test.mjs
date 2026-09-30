import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuotePathArchive,makeQuotePathRecord,quotePathDigest} from '../src/quote-path-archive.mjs';
const B=Date.parse('2026-09-29T01:00:00Z');
function sample(mode='demo',at=B){
 const pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',base=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const book={at:at+100,requestAt:at+1,updateId:at,
  bids:Array.from({length:5},(_,i)=>[String(100-i*.01),'2']),asks:Array.from({length:5},(_,i)=>[String(100.01+i*.01),'2'])};
 return {mode,observedAt:at,completedAt:at+150,pid:123,collectorVersion:'test',
  clock:{mode,source:base+(mode==='demo'?'/api/v3/time':'/fapi/v1/time'),requestStartedAt:at-50,receivedAt:at,serverTime:at},
  markets:{[pair]:{mode,pair,source:base,version:'sampled-demo-flow-v1',books:[book],startTime:at-60000,endTime:at-1,trades:[]}},
  diagnostics:{[pair]:{reason:'FLOW_INCOMPLETE'}}};
}
const wait=async archive=>{while(archive.status().pending)await new Promise(resolve=>setImmediate(resolve));};

test('both modes capture valid newest depth independently of incomplete tape with verifiable immutable hash',()=>{
 for(const mode of ['demo','demo-futures']){
  const s=sample(mode),pair=Object.keys(s.markets)[0];
  const record=makeQuotePathRecord(s,{mode,pairs:[pair],recordingStartedAt:B});
  assert.equal(record.observations[0].dataStatus,'ok');assert.equal(record.observations[0].book.bids.length,5);
  assert.equal(record.observations[0].rawProofSha256,quotePathDigest(s.markets[pair]));
  assert.equal(record.observations[0].rawProofRetained,false);assert.equal(record.usedForEntries,false);
  const {recordId,...body}=record;assert.equal(recordId,quotePathDigest(body));
  s.markets[pair].books[0].bids[0][0]='1';
  assert.equal(record.observations[0].book.bids[0][0],'100');
 }
});

test('bad clock or crossed book never produces a usable quote; unavailable pairs remain explicit',()=>{
 for(const modify of [s=>s.clock.serverTime+=10000,s=>s.markets['ETH/USDT'].books[0].bids[0][0]='101']){
  const s=sample();modify(s);const row=makeQuotePathRecord(s,{mode:'demo',pairs:['ETH/USDT','BTC/USDT'],recordingStartedAt:B});
  assert.equal(row.observations[0].book,null);assert.equal(row.observations[0].dataStatus,'unavailable');
  assert.deepEqual(row.missingPairs,[{pair:'BTC/USDT',reason:'FLOW_PROOF_MISSING'}]);
 }
});

test('single in-flight writer never queues market samples and reports lost coverage on the next record',async()=>{
 const rows=[],statuses=[];let release,at=B;
 const archive=createQuotePathArchive('/unused',{mode:'demo',pairs:['ETH/USDT'],now:()=>at,
  appendRecord:line=>new Promise(resolve=>{rows.push(JSON.parse(line));release=resolve;}),persistStatus:async s=>statuses.push(s)});
 archive(sample());at+=10000;archive(sample('demo',at));
 assert.equal(rows.length,1);assert.equal(archive.status().skippedBusySamples,1);
 release();await wait(archive);
 at=B+30000;archive(sample('demo',at));assert.equal(rows.length,2);
 assert.equal(rows[1].telemetry.skippedBusySamples,1);assert.equal(rows[1].observations[0].gapDetected,true);
 assert.equal(rows[1].observations[0].gapMs,30000);release();await archive.close();
 assert.equal(statuses.at(-1).recordsWritten,2);
});

test('archive rotates chunks, respects total budget and never deletes retained quote records',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'quote-path-test-'));
 try{
  const archive=createQuotePathArchive(directory,{mode:'demo',pairs:['ETH/USDT'],now:()=>B,maxBytes:5000,chunkBytes:1000});
  for(let i=0;i<10;i++){archive(sample('demo',B+i*10000));await wait(archive);}
  await archive.close();const path=join(directory,'quote-path-research'),files=(await readdir(path)).filter(f=>f.endsWith('.jsonl'));
  assert.ok(files.length>=2);const texts=await Promise.all(files.map(f=>readFile(join(path,f),'utf8')));
  assert.ok(texts.reduce((n,s)=>n+Buffer.byteLength(s),0)<=5000);
  assert.equal(archive.status().capacityFull,true);assert.equal(archive.status().state,'budget_full');
  const first=texts.flatMap(text=>text.trim().split('\n').map(JSON.parse)).sort((a,b)=>a.observedAt-b.observedAt)[0];
  assert.equal(first.observedAt,B);assert.equal(first.usedForEntries,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('storage failures and invalid samples stay contained and are visible in status',async()=>{
 const statuses=[];const archive=createQuotePathArchive('/unused',{mode:'demo',pairs:['ETH/USDT'],now:()=>B,
  appendRecord:async()=>{throw Error('private filesystem failure');},persistStatus:async s=>statuses.push(s)});
 archive(sample());await wait(archive);assert.equal(archive.status().writeFailures,1);
 assert.equal(statuses.at(-1).reason,'QUOTE_ARCHIVE_WRITE_FAILED');assert.equal(JSON.stringify(statuses).includes('private filesystem'),false);
 archive({mode:'demo'});await wait(archive);await archive.close();
 assert.equal(archive.status().invalidSamples,1);assert.equal(statuses.at(-1).reason,'QUOTE_ARCHIVE_SAMPLE_INVALID');
});
