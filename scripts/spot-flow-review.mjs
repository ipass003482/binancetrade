// Read-only research summary. No account, order, network, or strategy mutation.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {SPOT_FLOW_OBSERVER_VERSION as VERSION,SPOT_FLOW_HORIZONS_MS as HORIZONS,SPOT_FLOW_LATENESS_MS as LATE,validSpotFlowSignalCohort} from '../src/spot-flow-observer.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const id=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const day=t=>new Date(t).toISOString().slice(0,10);
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
function number(v){if(!['string','number'].includes(typeof v)||String(v).length>100)throw Error();const d=new Decimal(v);if(!d.isFinite()||(!d.isZero()&&Math.abs(d.e)>50))throw Error();return d;}
function positive(v){const d=number(v);if(d.lte(0))throw Error();return d;}
function dateStart(date){const t=Date.parse(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||!Number.isFinite(t)||day(t)!==date)throw Error('REVIEW_DATE_INVALID');return t;}
function anchorValid(a){try{return a.kind==='spot-flow-anchor'&&a.version===VERSION&&a.mode==='demo'&&a.status==='ok'
 &&id(a.anchorId)&&a.recordId==='anchor:'+a.anchorId&&id(a.proofSha256)&&typeof a.policy==='string'&&/^[a-z0-9-]+$/.test(a.policy)
 &&/^[A-Z0-9]+\/USDT$/.test(a.pair)&&a.source==='https://demo-api.binance.com'&&integer(a.sampledAt)&&integer(a.observedAt)
 &&a.sampledAt<=a.observedAt&&a.observedAt<=a.recordedAt&&typeof a.eligible==='boolean'
 &&positive(a.bid).lt(positive(a.ask))&&positive(a.mid).eq(positive(a.bid).plus(a.ask).div(2))
 &&canonical(a.horizonsMs)===canonical(HORIZONS)&&validSpotFlowSignalCohort(a);}catch{return false;}}
function sameAnchor(r,a){return r.anchorId===a.anchorId&&r.anchorAt===a.sampledAt&&r.policy===a.policy&&r.pair===a.pair
 &&typeof r.nonOverlap==='boolean'&&HORIZONS.includes(r.horizonMs);}
function markValid(m,a){try{
 if(!sameAnchor(m,a)||m.version!==VERSION||m.mode!=='demo'||m.kind!=='hypotheticalQuoteMarkout'
  ||m.recordId!==`markout:${a.anchorId}:${m.horizonMs}`||m.anchorProofSha256!==a.proofSha256||m.anchorEligible!==a.eligible
  ||m.targetAt!==a.sampledAt+m.horizonMs||canonical(m.anchorSignalCohort)!==canonical(a.signalCohort))return false;
 if(m.status==='missing')return m.recordedAt>m.targetAt+LATE&&m.rawQuoteMarkoutBps===null&&m.midMarkoutBps===null&&m.observedAt===null&&m.sampledAt===null;
 return m.status==='observed'&&integer(m.sampledAt)&&integer(m.observedAt)&&m.sampledAt>=m.targetAt&&m.sampledAt<=m.observedAt
  &&m.observedAt<=m.targetAt+LATE&&m.observedAt<=m.recordedAt&&m.elapsedMs===m.sampledAt-a.sampledAt&&m.lateByMs===m.sampledAt-m.targetAt
  &&id(m.observationProofSha256)&&positive(m.bid).lt(positive(m.ask))&&positive(m.mid).eq(positive(m.bid).plus(m.ask).div(2))
  &&number(m.rawQuoteMarkoutBps).eq(positive(m.bid).div(a.ask).minus(1).mul(10000))
  &&number(m.midMarkoutBps).eq(positive(m.mid).div(a.mid).minus(1).mul(10000));
 }catch{return false;}}

// files: [{date,path,status:'ok'|'missing'|'error',text}]. Adjacent missing days
// are optional until a required join is absent; the requested day's file is not.
export function buildSpotFlowReview({date,observedAt,files=[],state=null,stateFile=null,inputIssues=[]}={}){
 const start=dateStart(date),now=Date.parse(observedAt);
 if(!Number.isFinite(now))throw Error('REVIEW_ASOF_INVALID');
 const issues=[...inputIssues],inputs=[],records=new Map(),conflicts=new Set();
 let identicalDuplicates=0,futureRecordsExcluded=0;
 const issue=(code,detail)=>issues.push({code,...detail});
 const days=[day(start-86400000),date,day(start+86400000)];
 if(!files.some(f=>f.date===date))issue('TARGET_FILE_MISSING',{date});
 for(const f of files){
  if(!days.includes(f.date))continue;
  inputs.push({path:f.path,date:f.date,status:f.status,sha256:f.status==='ok'?hash(f.text):null});
  if(f.status!=='ok'){if(f.date===date||f.status!=='missing')issue('INPUT_FILE_UNAVAILABLE',{path:f.path,status:f.status});continue;}
  if(f.text.length&&!f.text.endsWith('\n'))issue('TORN_JSONL_TAIL',{path:f.path});
  for(const [i,line] of f.text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
   if(!line.trim())continue;
   let r;try{r=JSON.parse(line);}catch{issue('CORRUPT_JSONL',{path:f.path,line:i+1});continue;}
   if(!r||typeof r.recordId!=='string'||!integer(r.recordedAt)){issue('INVALID_RECORD',{path:f.path,line:i+1});continue;}
   if(r.recordedAt>now){futureRecordsExcluded++;continue;}
   if(day(r.recordedAt)!==f.date){issue('RECORD_FILE_DATE_MISMATCH',{recordId:r.recordId,path:f.path});continue;}
   if(records.has(r.recordId)){
    if(canonical(records.get(r.recordId))===canonical(r))identicalDuplicates++;
    else{conflicts.add(r.recordId);issue('CONFLICTING_RECORD_ID',{recordId:r.recordId});}
   }else records.set(r.recordId,r);
  }
 }
 for(const key of conflicts)records.delete(key);
 const anchors=new Map(),marks=new Map();
 for(const r of records.values()){
  if(r.kind==='spot-flow-anchor'){
   if(!anchorValid(r)){issue('INVALID_ANCHOR',{recordId:r.recordId});continue;}
   anchors.set(r.anchorId,r);
  }else if(r.kind==='hypotheticalQuoteMarkout'&&id(r.anchorId)&&integer(r.anchorAt)&&HORIZONS.includes(r.horizonMs))marks.set(`${r.anchorId}:${r.horizonMs}`,r);
  else issue('INVALID_RECORD_KIND_OR_ID',{recordId:r.recordId});
 }
 const pending=new Map();
 if(stateFile)inputs.push({...stateFile});
 const observer=state?.observer;
 if(state?.schemaVersion!==1||observer?.version!==VERSION||!Array.isArray(observer?.pending)||!integer(observer?.lastNow))issue('STATE_UNAVAILABLE_OR_INVALID',{});
 else if(observer.lastNow>now)issue('STATE_AFTER_ASOF',{stateAt:observer.lastNow});
 else for(const p of observer.pending){
  if(!id(p.anchorId)||!HORIZONS.includes(p.horizonMs)){issue('INVALID_PENDING',{});continue;}
  const key=`${p.anchorId}:${p.horizonMs}`;
  if(pending.has(key)&&canonical(pending.get(key))!==canonical(p)){pending.delete(key);issue('CONFLICTING_PENDING',{key});}
  else pending.set(key,p);
 }
 const scoped=[...anchors.values()].filter(a=>a.sampledAt>=start&&a.sampledAt<start+86400000&&a.sampledAt<=now);
 const policies=[...new Set(scoped.map(a=>a.policy))].sort();if(!policies.length)policies.push('order-flow-only-v1');
 const cohorts=policies.flatMap(policy=>HORIZONS.flatMap(horizonMs=>[true,false].map(anchorEligible=>({policy,horizonMs,anchorEligible,
  observed:0,missing:0,pending:0,overlappingExcluded:0,unresolvedEvidence:0,raw:[],mid:[]}))));
 const signalGroups=new Map();
 const signalGroup=(a,horizonMs)=>{
  const c=a.signalCohort,identity={policy:a.policy,horizonMs,classificationEvidence:c?'recorded':'missing',
   signalCohortVersion:c?.version??null,executionQualityVersion:c?.executionQualityVersion??null,
   baseFlowVersion:c?.baseFlowVersion??null,baseFlowEligible:a.eligible,priceContinuationVersion:c?.priceContinuationVersion??null,
   priceContinuationEligible:c?.priceContinuationEligible??null,baseAndContinuationEligible:c?.baseAndContinuationEligible??null,
   quoteBasis:c?.quoteBasis??null};
  const key=canonical(identity);
  if(!signalGroups.has(key))signalGroups.set(key,{...identity,observed:0,missing:0,pending:0,overlappingExcluded:0,unresolvedEvidence:0,raw:[],mid:[]});
  return signalGroups.get(key);
 };
 const unresolved=[];
 for(const m of marks.values())if(m.anchorAt>=start&&m.anchorAt<start+86400000&&!anchors.has(m.anchorId))issue('MARKOUT_ANCHOR_MISSING',{recordId:m.recordId});
 for(const p of pending.values())if(p.anchorAt>=start&&p.anchorAt<start+86400000&&!anchors.has(p.anchorId))issue('PENDING_ANCHOR_MISSING',{anchorId:p.anchorId});
 for(const a of scoped)for(const horizonMs of HORIZONS){
  const key=`${a.anchorId}:${horizonMs}`,m=marks.get(key),p=pending.get(key),cohort=cohorts.find(c=>c.policy===a.policy&&c.horizonMs===horizonMs&&c.anchorEligible===a.eligible);
  const groups=[cohort,signalGroup(a,horizonMs)],increment=field=>groups.forEach(c=>c[field]++);
  const pendingValid=p&&sameAnchor(p,a)&&p.eligible===a.eligible&&p.proofSha256===a.proofSha256&&p.bid===a.bid&&p.ask===a.ask&&p.mid===a.mid
   &&canonical(p.signalCohort)===canonical(a.signalCohort);
  const markOkay=m&&markValid(m,a);
  if(m&&!markOkay)issue('INVALID_MARKOUT',{recordId:m.recordId});
  if(p&&!pendingValid)issue('PENDING_ANCHOR_MISMATCH',{key});
  if(markOkay&&pendingValid&&m.nonOverlap!==p.nonOverlap){issue('NONOVERLAP_CONFLICT',{key});increment('unresolvedEvidence');continue;}
  const proof=markOkay?m:pendingValid?p:null;
  if(!proof){increment('unresolvedEvidence');unresolved.push({anchorId:a.anchorId,horizonMs,reason:'NO_VALID_MARKOUT_OR_PENDING'});issue('HORIZON_EVIDENCE_MISSING',{key});continue;}
  if(!proof.nonOverlap){increment('overlappingExcluded');continue;}
  if(markOkay){
   increment(m.status);
   if(m.status==='observed')for(const c of groups){c.raw.push(number(m.rawQuoteMarkoutBps));c.mid.push(number(m.midMarkoutBps));}
  }else if(now<=a.sampledAt+horizonMs+LATE)increment('pending');
  else{increment('unresolvedEvidence');issue('EXPIRED_PENDING_WITHOUT_MARKOUT',{key});}
 }
 const mean=xs=>xs.length?xs.reduce((s,v)=>s.plus(v),new Decimal(0)).div(xs.length).toFixed():null;
 const summarize=({raw,mid,...c})=>({...c,averageRawQuoteMarkoutBps:mean(raw),averageMidMarkoutBps:mean(mid)});
 return {schemaVersion:1,source:'spot-flow-observation-review',mode:'demo',date,anchorTimezone:'UTC',observedAt,
  status:issues.length?'incomplete_evidence':scoped.length?'observed':'no_observations',evidenceComplete:issues.length===0,
  inputFiles:inputs,anchors:scoped.length,uniqueRecords:records.size,identicalDuplicates,conflictingRecordIds:[...conflicts],futureRecordsExcluded,
  cohortsDefinition:'base_flow_only_not_current_executable_strategy',cohorts:cohorts.map(summarize),
  signalCohortEvidenceComplete:issues.length===0&&scoped.length>0&&scoped.every(a=>a.signalCohort!==undefined),
  signalCohortCoverage:{recordedAnchors:scoped.filter(a=>a.signalCohort!==undefined).length,missingAnchors:scoped.filter(a=>a.signalCohort===undefined).length},
  signalCohorts:[...signalGroups.values()].map(summarize),unresolved,issues,
  notes:['Only stored prospective records are used; no network, order, backfill or actual trade-goal merge.',
   'Raw quote markout is anchor ask to future bid: spread is already represented; fees and other execution costs are not deducted. Mid markout is mid-to-mid.',
   'These are market quote reactions, not fills, realized PnL, win rate, or proof of profitability.',
   'cohorts retains the original base-flow grouping. signalCohorts separately groups base flow, sampled-quote continuation and recorded versions; neither is executable strategy eligibility.',
   'Continuation uses the anchor sampled book, not a later bridge quote. Costs, ATR risk, positions and capacity are not evaluated here.',
   'Legacy anchors without signalCohort remain in a missing/null continuation group; later quotes or current policy versions never backfill their classification.',
   'Non-overlap is per policy, pair and horizon. Pairs sharing time windows remain correlated; sample counts are not independent trials.',
   'Pending and missing horizons never contribute zero to averages. Mature horizons without persisted evidence are incomplete, not invented outcomes.']};
}

export async function readSpotFlowReview({date,observedAt=new Date().toISOString(),directory=join(ROOT,'local/demo/spot-flow-research')}={}){
 const start=dateStart(date),files=[];
 for(const stamp of [start-86400000,start,start+86400000]){
  const d=day(stamp),path=join(directory,`observations-${d}.jsonl`);
  try{files.push({date:d,path,status:'ok',text:await readFile(path,'utf8')});}
  catch(e){files.push({date:d,path,status:e.code==='ENOENT'?'missing':'error'});}
 }
 const path=join(directory,'state.json');let state=null,stateFile={path,status:'missing',sha256:null};
 try{const text=await readFile(path,'utf8');stateFile={path,status:'ok',sha256:hash(text)};state=JSON.parse(text.replace(/^\uFEFF/,''));}
 catch(e){stateFile.status=e.code==='ENOENT'?'missing':'invalid_or_unreadable';}
 return buildSpotFlowReview({date,observedAt,files,state,stateFile});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--date'){console.error('Usage: node scripts/spot-flow-review.mjs --date YYYY-MM-DD');process.exitCode=2;}
 else try{console.log(JSON.stringify(await readSpotFlowReview({date:args[1]}),null,2));}
 catch(e){console.error(e.message==='REVIEW_DATE_INVALID'?'REVIEW_DATE_INVALID':'SPOT_FLOW_REVIEW_FAILED');process.exitCode=1;}
}
