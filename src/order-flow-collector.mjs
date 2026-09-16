import {join} from 'node:path';
import {ROOT} from './paths.mjs';
import {readJson,writeJson,exists} from './io.mjs';
import {jsonFetch} from './http.mjs';
import {FLOW_VERSION,assessOrderFlow} from './order-flow.mjs';
import {createSpotFlowStore} from './spot-flow-store.mjs';
export const FLOW_COLLECTOR_VERSION='per-pair-clock-v2';
export const nextFlowSampleDelay=(elapsed,rateLimited=false)=>rateLimited?60000:Math.max(5000,10000-Math.max(0,elapsed));
export async function sampleOrderFlow(policy,previous={}, {fetchImpl=fetch,now=()=>Date.now()}={}){
 const mode=policy.mode,base=mode==='demo'?'https://demo-api.binance.com':mode==='demo-futures'?'https://demo-fapi.binance.com':null;
 if(!base)throw Error('FLOW_DEMO_ONLY');
 const prefix=mode==='demo'?'/api/v3':'/fapi/v1',started=now();
 const clock=await jsonFetch(base+prefix+'/time',{fetchImpl,timeoutMs:3000});
 const received=now();if(!Number.isSafeInteger(started)||!Number.isSafeInteger(received)||received<started||!Number.isSafeInteger(clock.serverTime)||received-started>1500||Math.abs(clock.serverTime-received)>2000)throw Error('FLOW_CLOCK');
 const result={version:FLOW_VERSION,collectorVersion:FLOW_COLLECTOR_VERSION,mode,observedAt:received,pid:process.pid,markets:{},diagnostics:{}};
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(3,policy.pairs.length)},async()=>{
  while(cursor<policy.pairs.length){const pair=policy.pairs[cursor++];
   try{
    if(!(mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/).test(pair))throw Error('FLOW_PAIR');
    // Advance this round's checked exchange clock to this pair's dispatch time.
    // A slow earlier batch must not age every later pair's 60-second tape.
    const dispatched=now(),elapsed=dispatched-received;
    if(!Number.isSafeInteger(elapsed)||elapsed<0||elapsed>15000)throw Error('FLOW_CLOCK');
    const query='?symbol='+pair.split(':')[0].replace('/',''),endTime=clock.serverTime+elapsed-1500,startTime=endTime-60000;
    const [depth,trades]=await Promise.all([
     jsonFetch(base+prefix+'/depth'+query+'&limit=5',{fetchImpl,timeoutMs:3000}).then(book=>({book,at:now()})),
     jsonFetch(base+prefix+'/aggTrades'+query+'&startTime='+startTime+'&endTime='+endTime+'&limit=1000',{fetchImpl,timeoutMs:3000})]);
    // Stamp depth when depth arrives, never when a slower tape request finishes.
    const {book,at}=depth,completed=now(),old=previous.mode===mode?previous.markets?.[pair]:null;
    const books=[...(old?.books??[]),{at,requestAt:dispatched,updateId:book.lastUpdateId,bids:book.bids,asks:book.asks}].filter(b=>completed-b.at<=60000).slice(-3);
    const proof={version:FLOW_VERSION,mode,pair,source:base,books,startTime,endTime,trades:Array.isArray(trades)?trades.map(({a,p,q,T,m})=>({a,p,q,T,m})):null};
    result.markets[pair]=proof;
    result.diagnostics[pair]={...assessOrderFlow(proof,{mode,pair,long:true,now:completed}),collection:{dispatchedAt:dispatched,depthReceivedAt:at,completedAt:completed,depthRequestMs:at-dispatched,bookMinusTapeMs:at-endTime,tradeCount:proof.trades?.length??null,saturated:proof.trades?.length===1000}};
   }catch(error){result.diagnostics[pair]={status:'unavailable',reason:/^HTTP_(429|418)$/.test(error.message)?'FLOW_RATE_LIMIT':'FLOW_FETCH_FAILED'};}
  }
 }));
 result.completedAt=now();
 return result;
}
export async function readOrderFlow(mode,pair){
 try{return (await readJson(join(ROOT,'local',mode,'order-flow.json'))).markets?.[pair]??null;}catch{return null;}
}
export function startOrderFlowSampler(policy,local,{sampleRound=sampleOrderFlow,publish=writeJson,hasStop=exists,
 now=()=>Date.now(),schedule=setTimeout,unschedule=clearTimeout,
 observe=policy.mode==='demo'?createSpotFlowStore(local):null}={}){
 let stopped=false,timer=null,pending=Promise.resolve(),previous={},observerPending=null,observerSkippedBusy=0;
 const tick=async()=>{
  if(stopped||await hasStop(join(local,'STOP')))return;
  const tickStarted=now();let rateLimited=false,visible;
  try{const sampled=await sampleRound(policy,previous);sampled.research={usedForEntries:false,skippedBusySamples:observerSkippedBusy};await publish(join(local,'order-flow.json'),sampled);
   previous=sampled;visible=sampled;
   if(Object.values(sampled.diagnostics).some(d=>d.reason==='FLOW_RATE_LIMIT'))rateLimited=true;
  }catch(error){
   const code=typeof error?.message==='string'?error.message:'';
   rateLimited=/^HTTP_(429|418)$/.test(code);
   // Keep the last successfully published raw books only inside the collector.
   // The next successful round fetches a new clock, book and tape, then applies
   // the unchanged age/gap/ID checks. Never republish the cached proof as fresh.
   visible={version:FLOW_VERSION,mode:policy.mode,observedAt:now(),pid:process.pid,markets:{},error:'FLOW_SAMPLE_UNAVAILABLE',
    failureReason:/^(FLOW_CLOCK|HTTP_\d{3}|INVALID_JSON_RESPONSE|RESPONSE_TOO_LARGE|UPSTREAM_ERROR)$/.test(code)?code:'FLOW_FETCH_OR_PUBLISH_FAILED'};
   try{await publish(join(local,'order-flow.json'),visible);}catch{}
  }
  // Observer failures are visible but never add an entry gate or erase valid flow.
  if(observe){
   if(observerPending)observerSkippedBusy++;
   else {
    const sample=visible??{mode:policy.mode,markets:{}};
    observerPending=observe(sample).catch(async()=>{try{await writeJson(join(local,'spot-flow-research/status.json'),{status:'unavailable',usedForEntries:false,reason:'OBSERVER_WRITE_OR_STATE_FAILED',observedAt:new Date().toISOString()});}catch{}}).finally(()=>{observerPending=null;});
   }
  }
  if(!stopped)timer=schedule(()=>{pending=tick();},nextFlowSampleDelay(now()-tickStarted,rateLimited));
 };
 pending=tick();return async()=>{stopped=true;unschedule(timer);await pending;if(observerPending)await observerPending;};
}
