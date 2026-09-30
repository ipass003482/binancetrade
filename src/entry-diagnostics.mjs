import { readdir,stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { readJson } from './io.mjs';
import { isEntry } from './mode.mjs';

const WINDOW_MS=86400000,MAX_CYCLES=288;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=value=>Array.isArray(value)?value:[];
const codes=values=>[...new Set((Array.isArray(values)?values:[]).filter(value=>
 typeof value==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/.test(value)))];
const finite=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))?value:null;
const fields=(value,names)=>object(value)?Object.fromEntries(names.map(name=>[name,finite(value[name])])):null;
const metrics=value=>fields(value,['lastClose','sma8','sma20','return1hPct','return4hPct','volumeVsPrior19','relativeVolumeMinimum']);
const breakout=value=>fields(value,['level','trigger','close','atr','bufferAtr','lookbackBars','signalClose','signalAt','confirmationAt','confirmationBars']);
const cost=value=>object(value)?{status:typeof value.status==='string'?value.status:null,
 ...fields(value,['estimatedRoundTripCostBps','requiredPriceSpaceBps','targetBps','requiredBps'])}:null;
const increment=(map,reason,extra={})=>map.set(reason,{reason,count:(map.get(reason)?.count??0)+1,...extra});
const sorted=map=>[...map.values()].sort((a,b)=>b.count-a.count||a.reason.localeCompare(b.reason));
const probe=run=>[run.snapshot,run.rules,run.rules?.metadata,run.outcome,run.outcome?.result].some(value=>
 value?.purpose==='execution_probe'||value?.ruleVersion==='demo-execution-probe-v1');
const runVersion=run=>run.rules?.metadata?.ruleVersion??run.rules?.version??run.snapshot?.ruleVersion;

function candidateView(candidate,snapshot){
 const checks=(Array.isArray(candidate.directionChecks)?candidate.directionChecks:[]).filter(object).map(check=>({
  action:typeof check.action==='string'?check.action:null,eligible:check.eligible===true,
  reasons:codes(check.reasons),metrics:metrics(check.metrics),breakout:breakout(check.breakout),costSpace:cost(check.costSpace),
 }));
 const selected=checks.find(check=>check.action===candidate.action)??checks[0];
 const market=snapshot.markets?.find(m=>m?.pair===candidate.pair);
 const reasons=codes([...array(candidate.reasons),...checks.flatMap(check=>check.reasons),candidate.sizingReason,
  ...array(candidate.sizing?.reasons)]);
 return {pair:candidate.pair,action:typeof candidate.action==='string'?candidate.action:null,
  eligible:isEntry(candidate.action),reasons,sizingReason:typeof candidate.sizingReason==='string'?candidate.sizingReason:null,
  directionChecks:checks,metrics:selected?.metrics??null,trigger:finite(candidate.trigger??selected?.breakout?.trigger),
  cost:cost(market?.entryCost),stakeUsdt:finite(candidate.stakeUsdt)};
}

export function buildEntryDiagnostics({mode,ruleVersion,runs,allowance=null,asOf=new Date().toISOString(),since=null}={}){
 const now=typeof asOf==='number'?asOf:Date.parse(asOf);
 if(!Number.isFinite(now)||typeof mode!=='string'||typeof ruleVersion!=='string'||!ruleVersion||!Array.isArray(runs))
  throw Error('ENTRY_DIAGNOSTICS_INPUT_INVALID');
 if(since!==null&&(!Number.isFinite(Date.parse(since))||Date.parse(since)>now))throw Error('ENTRY_DIAGNOSTICS_INPUT_INVALID');
 const from=Math.max(now-WINDOW_MS,since===null?0:Date.parse(since)),exclusions={outsideWindow:0,versionMismatch:0,modeMismatch:0,probe:0,invalid:0,duplicate:0,limited:0};
 const eligible=[];
 for(const run of runs){
  const snapshot=run?.snapshot,time=Date.parse(snapshot?.createdAt);
  if(!object(run)||!object(snapshot)||typeof snapshot.id!=='string'||!Number.isFinite(time)){exclusions.invalid++;continue;}
  if(snapshot.mode!==mode){exclusions.modeMismatch++;continue;}
  if(time<from||time>now){exclusions.outsideWindow++;continue;}
  if(probe(run)){exclusions.probe++;continue;}
  if(runVersion(run)!==ruleVersion||snapshot.ruleVersion!==undefined&&snapshot.ruleVersion!==ruleVersion){exclusions.versionMismatch++;continue;}
  if(run.outcome?.snapshotId!==undefined&&run.outcome.snapshotId!==snapshot.id||
   run.outcome?.mode!==undefined&&run.outcome.mode!==mode){exclusions.invalid++;continue;}
  eligible.push(run);
 }
 eligible.sort((a,b)=>Date.parse(b.snapshot.createdAt)-Date.parse(a.snapshot.createdAt)||a.snapshot.id.localeCompare(b.snapshot.id));
 const selected=[],seen=new Set();
 for(const run of eligible){
  if(seen.has(run.snapshot.id)){exclusions.duplicate++;continue;}
  seen.add(run.snapshot.id);
  if(selected.length===MAX_CYCLES){exclusions.limited++;continue;}
  selected.push(run);
 }
 const cycles={total:selected.length,completed:0,waiting:0,failed:0,aborted:0,incomplete:0,submitted:0,hold:0,filtered:0};
 const candidates={total:0,eligible:0,blocked:0},signal=new Map(),global=new Map(),fault=new Map(),warnings=[];
 // These are observed cycle counts, not fills or sums of overlapping reasons.
 const funnel={observedCycles:selected.length,withCandidates:0,signalAndCostPassed:0,sizePassed:0,
  entryProposed:0,eligibleWithoutProposal:0,submitted:0};
 let latest=null;
 for(const run of selected){
  const outcome=run.outcome,status=['completed','waiting','failed','aborted'].includes(outcome?.status)?outcome.status:'incomplete';
  cycles[status]++;
  if(status==='completed'&&['submitted','hold','filtered'].includes(outcome.result?.status))cycles[outcome.result.status]++;
  const wait=status==='waiting'?{reason:codes([outcome.reason??outcome.result?.reason])[0]??'UNKNOWN_RISK_WAIT',
   resetAt:Number.isFinite(Date.parse(outcome.resetAt??outcome.result?.resetAt))?outcome.resetAt??outcome.result.resetAt:null,
   reviewRequired:outcome.reviewRequired===true||outcome.result?.reviewRequired===true}:null;
  if(wait)increment(global,wait.reason,{resetAt:wait.resetAt,reviewRequired:wait.reviewRequired});
  const error=status==='failed'||status==='aborted'?codes([outcome.code])[0]??'UNKNOWN_CYCLE_FAILURE':null;
  if(error)increment(fault,error);
  const rows=Array.isArray(run.rules?.candidates)?run.rules.candidates:[];
  if(!Array.isArray(run.rules?.candidates))warnings.push({code:'CYCLE_CANDIDATES_UNAVAILABLE',snapshotId:run.snapshot.id});
  const pairs=[],pairSeen=new Set();
  for(const candidate of rows){
   if(!object(candidate)||typeof candidate.pair!=='string'||pairSeen.has(candidate.pair)||
    candidate.version!==undefined&&candidate.version!==ruleVersion)continue;
   pairSeen.add(candidate.pair);
   const row=candidateView(candidate,run.snapshot);pairs.push(row);candidates.total++;
   if(row.eligible)candidates.eligible++;else candidates.blocked++;
   // A reason is counted at most once per pair per cycle, even when both
   // long and short directions report it or it appears at multiple layers.
   if(!row.eligible)for(const reason of row.reasons)increment(signal,reason);
  }
  if(pairs.length)funnel.withCandidates++;
  if(pairs.some(row=>row.directionChecks.some(check=>check.eligible)))funnel.signalAndCostPassed++;
  const sized=pairs.some(row=>row.eligible),proposed=isEntry(run.rules?.proposal?.action);
  if(sized)funnel.sizePassed++;
  if(proposed)funnel.entryProposed++;
  if(sized&&!proposed)funnel.eligibleWithoutProposal++;
  if(status==='completed'&&outcome.result?.status==='submitted')funnel.submitted++;
  if(!latest)latest={snapshotId:run.snapshot.id,createdAt:run.snapshot.createdAt,status,
   action:run.rules?.proposal?.action??null,globalWait:wait,fault:error,pairs};
 }
 return {schemaVersion:1,source:'local-demo-entry-diagnostics',mode,ruleVersion,asOf:new Date(now).toISOString(),
  window:{from:new Date(from).toISOString(),to:new Date(now).toISOString(),maxCycles:MAX_CYCLES,
   timeBasis:'snapshot.createdAt',reasonCountBasis:'once_per_candidate_pair_per_cycle'},
  cycles,candidates,funnel,signalReasons:sorted(signal),globalWaitReasons:sorted(global),faultReasons:sorted(fault),
  latest,allowance,exclusions,warnings};
}

// Retain only compact metadata for the actual directory inventory. A FIFO
// smaller than the history rereads every full snapshot on every sweep.
// mtime/size invalidate cached bytes; selection still uses snapshot.createdAt.
export function createEntryDiagnosticsReader({readDirectory=readdir,fileStat=stat,readDocument=readJson,clock=Date.now}={}){
 const directories=new Map(),scopes=new Map();
 async function indexedSnapshot(index,file){
  const info=await fileStat(file),key=info.mtimeMs+':'+info.size,old=index.get(file);
  if(old?.key===key)return old.pending??old.value;
  const entry={key};index.set(file,entry);
  entry.pending=readDocument(file).then(value=>{
   const compact={id:value.id,mode:value.mode,createdAt:value.createdAt,purpose:value.purpose,ruleVersion:value.ruleVersion,
    markets:Array.isArray(value.markets)?value.markets.map(m=>({pair:m?.pair,entryCost:cost(m?.entryCost)})):[]};
   entry.value=compact;delete entry.pending;return compact;
  },error=>{if(index.get(file)===entry)index.delete(file);throw error;});
  return entry.pending;
 }
 async function scan(local,{mode,ruleVersion,now,since}){
  const dir=join(local,'runs');let names;
  try{names=(await readDirectory(dir)).filter(name=>name.endsWith('.snapshot.json'));}
  catch(error){if(error.code!=='ENOENT')throw error;names=[];}
  const index=directories.get(dir)??new Map();directories.set(dir,index);
  const inventory=new Set(names.map(name=>join(dir,name)));
  for(const file of index.keys())if(!inventory.has(file))index.delete(file);
  const runs=[],warnings=[];
  for(let offset=0;offset<names.length;offset+=16){
   const results=await Promise.allSettled(names.slice(offset,offset+16).map(async name=>{
    const snapshot=await indexedSnapshot(index,join(dir,name)),time=Date.parse(snapshot.createdAt);
    if(!Number.isFinite(time)||time<Math.max(now-WINDOW_MS,since===null?0:Date.parse(since))||time>now||snapshot.mode!==mode||snapshot.purpose==='execution_probe')return {snapshot};
    const base=name.slice(0,-'.snapshot.json'.length);
    const values=await Promise.allSettled(['rules','outcome'].map(suffix=>readDocument(join(dir,base+'.'+suffix+'.json'))));
    const run={snapshot};
    for(let i=0;i<values.length;i++){
     if(values[i].status==='fulfilled')run[i===0?'rules':'outcome']=values[i].value;
     else if(values[i].reason.code!=='ENOENT')warnings.push({code:'DIAGNOSTICS_FILE_UNREADABLE',file:base+'.'+(i===0?'rules':'outcome')+'.json'});
    }
    return run;
   }));
   for(const result of results){
    if(result.status==='fulfilled')runs.push(result.value);
    else warnings.push({code:'DIAGNOSTICS_SNAPSHOT_UNREADABLE'});
   }
  }
  const report=buildEntryDiagnostics({mode,ruleVersion,runs,asOf:now,since});
  report.warnings.push(...warnings);return report;
 }
 return async function readDiagnostics(local,{mode,ruleVersion,allowance=null,now=Date.now(),since=null,refreshMs=30000,waitMs=Infinity}={}){
  // Reject an invalid scope before starting any background reads.
  buildEntryDiagnostics({mode,ruleVersion,runs:[],asOf:now,since});
  if(!Number.isFinite(refreshMs)||refreshMs<0||!(waitMs===Infinity||Number.isFinite(waitMs)&&waitMs>=0))throw Error('ENTRY_DIAGNOSTICS_INPUT_INVALID');
  local=resolve(local);since=since===null?null:new Date(since).toISOString();
  const key=JSON.stringify([local,mode,ruleVersion,since]),state=scopes.get(key)??{};
  scopes.set(key,state);
  const observed=typeof now==='number'?now:Date.parse(now),cachedAge=clock()-state.settledAt;
  if(state.pending&&observed<state.asOf)throw Error('ENTRY_DIAGNOSTICS_OBSERVATION_TIME_REVERSED');
  if(!state.pending&&!(cachedAge>=0&&cachedAge<refreshMs&&observed>=state.asOf)){
   state.asOf=observed;
   // Both settlement handlers consume rejection, including when the bounded
   // caller has already returned. No detached rejecting background promise.
   state.pending=scan(local,{mode,ruleVersion,now:observed,since}).then(report=>{
    state.report=report;state.error=null;
   },error=>{state.report=null;state.error=error;}).then(()=>{state.settledAt=clock();state.pending=null;});
  }
  if(state.pending){
   let timer;
   try{
    if(waitMs===Infinity)await state.pending;
    else await Promise.race([state.pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DIAGNOSTICS_INDEX_WARMING')),waitMs);})]);
   }finally{clearTimeout(timer);}
  }
  if(state.error)throw state.error;
  if(Date.parse(state.report?.asOf)>observed)throw Error('ENTRY_DIAGNOSTICS_OBSERVATION_TIME_REVERSED');
  // A completed scan keeps its original observation time, even on a later UI
  // refresh. Never stamp cached diagnostics with current account freshness.
  return {...structuredClone(state.report),allowance};
 };
}
export const readEntryDiagnostics=createEntryDiagnosticsReader();
