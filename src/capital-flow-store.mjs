import {open,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {ROOT} from './paths.mjs';
import {readJson,writeJson,exists} from './io.mjs';
import {jsonFetch} from './http.mjs';
import {loadPolicy} from './config.mjs';
import {modeLocal} from './mode.mjs';
import {FreqtradeClient} from './freqtrade.mjs';
import {CAPITAL_VERSION,CHAIN_NAMES,normalizeSupply,supplyUsable,observeCapitalFlow,attributeTrade,summarizeCapitalTrades} from './capital-flow.mjs';

export const CAPITAL_DIRECTORY=join(ROOT,'local','capital-flow');
const MODES=['demo','demo-futures'];
const iso=at=>new Date(at).toISOString();
const day=at=>iso(at).slice(0,10);
const missing=()=>({status:'unavailable',usedForEntries:false,reason:'CAPITAL_OBSERVER_NOT_READY',sources:[],observations:[],results:[]});
export async function readObservationWindow(directory,{from,to}){
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>to||to-from>120000)throw Error('CAPITAL_WINDOW_INVALID');
 const rows=[];
 for(const date of new Set([day(from),day(to)])){
  let file;try{file=await open(join(directory,'observations-'+date+'.jsonl'),'r');}catch(e){if(e.code==='ENOENT')continue;throw e;}
  try{
   const {size}=await file.stat();if(!size)continue;
   const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);
   if(tail[0]!==10)throw Error('CAPITAL_JOURNAL_INCOMPLETE');
   // Read only the complete byte range observed at open; concurrent appends
   // cannot introduce a torn tail. Stream old days rather than loading them.
   const stream=file.createReadStream({start:0,end:size-1,autoClose:false});
   const lines=createInterface({input:stream,crlfDelay:Infinity});
   try{for await(const line of lines){if(!line)continue;const batch=JSON.parse(line);
    if(batch.version!==CAPITAL_VERSION||!Array.isArray(batch.observations))throw Error('CAPITAL_JOURNAL_SCHEMA');
    rows.push(...batch.observations.filter(o=>Number.isSafeInteger(o.observedAt)&&o.observedAt>=from&&o.observedAt<=to));
   }}finally{lines.close();stream.destroy();}
  }finally{await file.close();}
 }
 return rows;
}
async function saveOnce(path,value){
 await mkdir(join(path,'..'),{recursive:true});
 try{await writeFile(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});return value;}
 catch(e){if(e.code!=='EEXIST')throw e;return readJson(path);}
}
export async function readCapitalView({directory=CAPITAL_DIRECTORY,now=Date.now()}={}){
 try{
  const report=await readJson(join(directory,'report.json'));
  if(report.version!==CAPITAL_VERSION||!Number.isSafeInteger(report.observedAt)||report.observedAt>now||now-report.observedAt>90000)
   return {...missing(),reason:'CAPITAL_OBSERVER_STALE'};
  const historyStale=!Number.isSafeInteger(report.lastResultAt)||report.lastResultAt>now||now-report.lastResultAt>90000;
  return {...report,historyStale,results:historyStale?[]:report.results,sources:report.sources.map(({usable,...source})=>({...source,usable:supplyUsable(source,now)})),
   observations:now-report.flowObservedAt<=20000?report.observations:[],flowStale:now-report.flowObservedAt>20000};
 }catch{return missing();}
}
export async function createCapitalRecorder({directory=CAPITAL_DIRECTORY,now=()=>Date.now(),
 fetchImpl=fetch,flowFor=mode=>readJson(join(modeLocal(mode),'order-flow.json')),
 historyFor=async mode=>new FreqtradeClient(await loadPolicy(mode),await readJson(join(modeLocal(mode),'api-auth.json'))).history()}={}){
 await mkdir(directory,{recursive:true});
 const statePath=join(directory,'state.json');
 const state=await saveOnce(statePath,{version:CAPITAL_VERSION,startedAt:now(),usedForEntries:false});
 if(state.version!==CAPITAL_VERSION||!Number.isSafeInteger(state.startedAt)||state.startedAt>now())throw Error('CAPITAL_STATE_INVALID');
 let sources={},sourceErrors={},observations=[],lastSamples={},results=[],lastResultAt=null,lastResultAttempt=0,
  historyErrors={},lastSourceAttempt=0,sourcePending=null,historyPending=null;
 // Recover only genuine previously recorded observations. A new installation
 // never reconstructs old contexts from today's revised provider history.
 observations=await readObservationWindow(directory,{from:now()-120000,to:now()});
 async function refreshSources(){
  const refreshed=await Promise.allSettled(CHAIN_NAMES.map(async chain=>{
   const raw=await jsonFetch('https://stablecoins.llama.fi/stablecoincharts/'+chain,{fetchImpl,timeoutMs:10000});
   const source=normalizeSupply(raw,{chain,observedAt:now()});
   await saveOnce(join(directory,'sources',source.id+'.json'),source);
   return source;
  }));
  const next={},errors={};
  for(let i=0;i<CHAIN_NAMES.length;i++){
   if(refreshed[i].status==='fulfilled')next[CHAIN_NAMES[i]]=refreshed[i].value;
   else errors[CHAIN_NAMES[i]]='SOURCE_FETCH_OR_VALIDATION_FAILED';
  }
  // A failed refresh does not masquerade as fresh cached data.
  sources=next;sourceErrors=errors;
 }
 async function reconcileHistory(){
  const snapshots=await Promise.allSettled(MODES.map(async mode=>{
   const trades=await historyFor(mode),attributes={};
   for(const trade of trades){
    if(trade.open_timestamp<state.startedAt)continue;
    if(!Number.isInteger(trade.trade_id))throw Error('TRADE_ID_INVALID');
    const path=join(directory,'trades',mode+'-'+trade.trade_id+'.json');
    if(await exists(path))attributes[trade.trade_id]=await readJson(path);
    else{
     // After an API outage or process restart, recover the ORIGINAL recorded
     // pre-entry window. Never fetch historical provider data to fill this gap.
     const original=await readObservationWindow(directory,{from:trade.open_timestamp-45000,to:trade.open_timestamp});
     attributes[trade.trade_id]=await saveOnce(path,{...attributeTrade(trade,original,{mode,startedAt:state.startedAt,now:now()}),recordedAt:now(),usedForEntries:false});
    }
   }
   return summarizeCapitalTrades(trades,attributes,{mode,startedAt:state.startedAt});
  }));
  results=[];historyErrors={};
  for(let i=0;i<MODES.length;i++)if(snapshots[i].status==='fulfilled')results.push(snapshots[i].value);else historyErrors[MODES[i]]='HISTORY_UNAVAILABLE';
  lastResultAt=now();
 }
 async function tick(){
  const at=now();
  if(!sourcePending&&(!lastSourceAttempt||at-lastSourceAttempt>=15*60000)){
   lastSourceAttempt=at;
   sourcePending=refreshSources().catch(()=>{sourceErrors={all:'SOURCE_COLLECTION_FAILED'};sources={};}).finally(()=>{sourcePending=null;});
  }
  const reads=await Promise.allSettled(MODES.map(async mode=>({mode,sample:await flowFor(mode)})));
  const current=[],recorded=[];
  for(const r of reads){
   if(r.status!=='fulfilled')continue;
   const {mode,sample}=r.value;
   if(sample.mode!==mode)continue;
   const rows=observeCapitalFlow(sample,sources,now());current.push(...rows);
   const key=sample.completedAt??sample.observedAt;
   if(Number.isSafeInteger(key)&&key!==lastSamples[mode]){
    lastSamples[mode]=key;recorded.push(...rows);
   }
  }
  if(recorded.length){
   const path=join(directory,'observations-'+day(at)+'.jsonl');
   // Single recorder writer, append only. Read-side rejects incomplete writes.
   await appendFile(path,JSON.stringify({version:CAPITAL_VERSION,observedAt:now(),observations:recorded})+'\n',{mode:0o600});
   observations.push(...recorded);
  }
  if(!historyPending&&(!lastResultAttempt||now()-lastResultAttempt>=30000)){
   lastResultAttempt=now();
   historyPending=reconcileHistory().catch(()=>{results=[];historyErrors={all:'HISTORY_RECONCILIATION_FAILED'};})
    .finally(()=>{historyPending=null;});
  }
  observations=observations.filter(o=>o.observedAt>=now()-120000);
  const report={version:CAPITAL_VERSION,status:'observing',pid:process.pid,startedAt:state.startedAt,observedAt:now(),flowObservedAt:at,
   usedForEntries:false,entryEffect:'none',ranking:'advisory only; no automatic activation',sourceCadenceSeconds:900,
   sources:Object.values(sources).map(s=>({...s,usable:supplyUsable(s,now())})),sourceErrors,
   unavailableFeatures:['exchange-netflow','labeled-whale-transfers'],observations:current,results,historyErrors,lastResultAt,historyPending:historyPending!==null,
   runtimeVersion:'independent-history-recovery-v1',
   interpretation:'Prospective Demo cohorts, not a randomized strategy comparison. Supply is chain/market background, not exchange buying or selling. Missing context never blocks orders.'};
  await writeJson(join(directory,'report.json'),report);return report;
 }
 return {tick,refreshSources,settleSources:async()=>{if(sourcePending)await sourcePending;},settleHistory:async()=>{if(historyPending)await historyPending;},state};
}
// Runs with the local dashboard, independent of browser visits and trade engines.
// Closing/stopping this observer has no effect on existing trading processes.
export function startCapitalObserver(options={}){
 let stopped=false,timer=null,recorder=null;
 const directory=options.directory??CAPITAL_DIRECTORY;
 async function tick(){
  if(stopped)return;
  try{
   if(await exists(join(directory,'STOP'))){stopped=true;return;}
   recorder??=await createCapitalRecorder(options);await recorder.tick();
  }catch{
   try{await writeJson(join(directory,'report.json'),{...missing(),version:CAPITAL_VERSION,observedAt:Date.now(),reason:'CAPITAL_COLLECTION_OR_STORAGE_FAILED'});}catch{}
  }
  if(!stopped){timer=setTimeout(tick,5000);timer.unref();}
 }
 void tick();return ()=>{stopped=true;clearTimeout(timer);};
}
