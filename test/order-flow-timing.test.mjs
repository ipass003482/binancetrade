import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleOrderFlow,startOrderFlowSampler,nextFlowSampleDelay,FLOW_COLLECTOR_VERSION} from '../src/order-flow-collector.mjs';
import {FLOW_VERSION} from '../src/order-flow.mjs';
const B=Date.parse('2026-09-15T06:00:00Z');
const levels=(mid,side)=>Array.from({length:5},(_,i)=>[String(mid+(side==='bids'?-1:1)*(i+1)*.001),side==='bids'?'3':'1']);
const book=(at,mid)=>({at,updateId:1,bids:levels(mid,'bids'),asks:levels(mid,'asks')});
const response=data=>({ok:true,text:async()=>JSON.stringify(data)});

test('later batch windows advance with dispatch; all ten pairs remain valid despite round latency',async()=>{
 let now=B;const pairs=Array.from({length:10},(_,i)=>`A${i}/USDT`),previous={mode:'demo',markets:{}};
 for(let i=0;i<10;i++){const at=B+Math.floor(i/3)*1200;previous.markets[pairs[i]]={books:[book(at-20000,100),book(at-10000,100.001)]};}
 const calls=[];
 const fetchImpl=async raw=>{
  const u=new URL(raw);if(u.pathname.endsWith('/time'))return response({serverTime:B});
  const index=Number(u.searchParams.get('symbol').match(/^A(\d+)USDT$/)[1]);calls.push(raw);
  if(u.pathname.endsWith('/depth'))return response({lastUpdateId:2,bids:levels(100.002,'bids'),asks:levels(100.002,'asks')});
  // Three concurrent requests share one simulated batch completion clock.
  now=Math.max(now,B+(Math.floor(index/3)+1)*1200);
  const end=Number(u.searchParams.get('endTime'));
  return response([0,1,2].map(i=>({a:i+1,T:end-50000+i*24000,p:'100',q:'1',m:false})));
 };
 const result=await sampleOrderFlow({mode:'demo',pairs},previous,{fetchImpl,now:()=>now});
 assert.equal(result.collectorVersion,FLOW_COLLECTOR_VERSION);
 assert.equal(Object.keys(result.markets).length,10);
 for(const pair of pairs){assert.equal(result.diagnostics[pair].eligible,true,pair);assert.ok(result.diagnostics[pair].collection.bookMinusTapeMs<=5000);}
 assert.ok(result.markets['A9/USDT'].endTime>result.markets['A0/USDT'].endTime);
 assert.ok(calls.every(url=>url.startsWith('https://demo-api.binance.com/api/v3/')));
});

test('a slow tape cannot relabel an older depth response with its completion time',async()=>{
 let now=B,releaseTape;
 const fetchImpl=async raw=>{
  const u=new URL(raw);if(u.pathname.endsWith('/time'))return response({serverTime:B});
  if(u.pathname.endsWith('/depth'))return response({lastUpdateId:2,bids:levels(100.002,'bids'),asks:levels(100.002,'asks')});
  await new Promise(resolve=>{releaseTape=resolve;});
  return response([0,1,2].map(i=>({a:i+1,T:B-55000+i*25000,p:'100',q:'1',m:false})));
 };
 const previous={mode:'demo',markets:{'ETH/USDT':{books:[book(B-20000,100),book(B-10000,100.001)]}}};
 const pending=sampleOrderFlow({mode:'demo',pairs:['ETH/USDT']},previous,{fetchImpl,now:()=>now});
 for(let i=0;i<10;i++)await Promise.resolve();
 now=B+2500;releaseTape();const r=await pending;
 assert.equal(r.markets['ETH/USDT'].books.at(-1).at,B);
 assert.equal(r.diagnostics['ETH/USDT'].collection.completedAt,B+2500);
 assert.equal(r.markets['ETH/USDT'].version,FLOW_VERSION);
});

test('fixed cadence retains five-second recovery floor and full rate-limit backoff',()=>{
 assert.equal(nextFlowSampleDelay(1200),8800);
 assert.equal(nextFlowSampleDelay(9000),5000);
 assert.equal(nextFlowSampleDelay(21000),5000);
 assert.equal(nextFlowSampleDelay(21000,true),60000);
});

test('clock rollback is rejected and an exchange clock ahead never bypasses future-tape protection',async()=>{
 let calls=0;
 await assert.rejects(sampleOrderFlow({mode:'demo',pairs:[]},{},{now:()=>calls++===0?B:B-1,fetchImpl:async()=>response({serverTime:B})}),/FLOW_CLOCK/);
 const previous={mode:'demo',markets:{'ETH/USDT':{books:[book(B-20000,100),book(B-10000,100.001)]}}};
 const r=await sampleOrderFlow({mode:'demo',pairs:['ETH/USDT']},previous,{now:()=>B,fetchImpl:async raw=>{
  if(raw.endsWith('/time'))return response({serverTime:B+2000});
  if(raw.includes('/depth'))return response({lastUpdateId:2,bids:levels(100.002,'bids'),asks:levels(100.002,'asks')});
  return response([0,1,2].map(i=>({a:i+1,T:B-55000+i*25000,p:'100',q:'1',m:false})));
 }});
 assert.equal(r.diagnostics['ETH/USDT'].eligible,false);
 assert.equal(r.diagnostics['ETH/USDT'].reason,'FLOW_STALE');
});

test('a round cannot dispatch with a rolled-back or expired exchange-clock anchor',async()=>{
 for(const delta of [-1,15001]){
  let calls=0,marketRequests=0;
  const r=await sampleOrderFlow({mode:'demo',pairs:['ETH/USDT']},{},{now:()=>++calls<=2?B:B+delta,fetchImpl:async raw=>{
   if(!raw.endsWith('/time'))marketRequests++;
   return response({serverTime:B});
  }});
  assert.deepEqual(r.markets,{});assert.equal(marketRequests,0);
 }
});

// Run the real collector and its publication boundary with synthetic exchange
// responses, an explicit clock, no filesystem and no live timers or network.
async function recoveryHarness(){
 let at=B,fault=null,next=null,ready=null,clockReads=0;
 const published=[],observed=[],delays=[];
 const fetchImpl=async raw=>{
  const u=new URL(raw);
  if(u.pathname.endsWith('/time')){
   clockReads++;
   if(fault==='rate-limit')return {ok:false,status:429};
   if(fault==='private-error')throw Error('private upstream detail');
   return response({serverTime:at+(fault==='clock'?2001:0)});
  }
  if(u.pathname.endsWith('/depth')){
   const mid=100+(at-B)/1000000;
   return response({lastUpdateId:fault==='regressed-id'?0:1+(at-B)/1000,bids:levels(mid,'bids'),asks:levels(mid,'asks')});
  }
  const end=Number(u.searchParams.get('endTime'));
  return response([0,1,2].map(i=>({a:i+1,T:end-(fault==='stale-tape'?55000:50000)+i*(fault==='stale-tape'?10000:24000),p:'100',q:'1',m:false})));
 };
 const waitScheduled=async()=>{if(!next)await new Promise(resolve=>{ready=resolve;});};
 const stop=startOrderFlowSampler({mode:'demo',pairs:['ETH/USDT']},'/unused',{
  now:()=>at,hasStop:async()=>false,
  sampleRound:(policy,previous)=>sampleOrderFlow(policy,previous,{fetchImpl,now:()=>at}),
  publish:async(_path,sample)=>{published.push(structuredClone(sample));},
  observe:async sample=>{observed.push(structuredClone(sample));},
  schedule:(callback,delay)=>{next=callback;delays.push(delay);if(ready){ready();ready=null;}return 1;},unschedule:()=>{}
 });
 await waitScheduled();
 return {published,observed,delays,stop,clockReads:()=>clockReads,
  async tick(offset,nextFault=null){at=B+offset;fault=nextFault;const callback=next;next=null;callback();await waitScheduled();return published.at(-1);}};
}

test('failed clock publishes unavailable to entries and observer; fresh recovery revalidates retained books',async()=>{
 const h=await recoveryHarness();
 try{
  await h.tick(10000);const before=await h.tick(20000);
  assert.equal(before.diagnostics['ETH/USDT'].eligible,true);
  const failed=await h.tick(30000,'clock');
  assert.deepEqual(failed.markets,{});assert.equal(failed.error,'FLOW_SAMPLE_UNAVAILABLE');
  assert.equal(failed.failureReason,'FLOW_CLOCK');assert.deepEqual(h.observed.at(-1).markets,{});
  const recovered=await h.tick(40000);
  assert.equal(h.clockReads(),5);assert.equal(recovered.diagnostics['ETH/USDT'].eligible,true);
  assert.deepEqual(recovered.markets['ETH/USDT'].books.map(b=>b.at),[B+10000,B+20000,B+40000]);
  assert.equal(recovered.markets['ETH/USDT'].endTime,B+40000-1500);
  assert.deepEqual(before.markets['ETH/USDT'].books.map(b=>b.at),[B,B+10000,B+20000]);
 }finally{await h.stop();}
});

test('cached recovery never relaxes maximum book gap, age, exchange IDs or tape freshness',async()=>{
 for(const [offset,fault,reason] of [[41000,null,'FLOW_BOOK_GAP'],[90000,null,'FLOW_INCOMPLETE'],
  [40000,'regressed-id','FLOW_BOOK_GAP'],[40000,'stale-tape','FLOW_TAPE_STALE']]){
  const h=await recoveryHarness();
  try{
   await h.tick(10000);await h.tick(20000);await h.tick(30000,'clock');
   const recovered=await h.tick(offset,fault);
   assert.equal(recovered.diagnostics['ETH/USDT'].eligible,false);
   assert.equal(recovered.diagnostics['ETH/USDT'].reason,reason);
  }finally{await h.stop();}
 }
});

test('failure classification preserves rate-limit backoff without exposing raw upstream messages',async()=>{
 const h=await recoveryHarness();
 try{
  const limited=await h.tick(10000,'rate-limit');
  assert.equal(limited.failureReason,'HTTP_429');assert.deepEqual(limited.markets,{});assert.equal(h.delays.at(-1),60000);
  const privateFailure=await h.tick(70000,'private-error');
  assert.equal(privateFailure.failureReason,'FLOW_FETCH_OR_PUBLISH_FAILED');
  assert.equal(JSON.stringify(privateFailure).includes('private upstream detail'),false);
 }finally{await h.stop();}
});
