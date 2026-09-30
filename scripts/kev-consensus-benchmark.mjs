// Detached, read-only quote research. No runtime strategy imports, orders or network.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import DecimalBase from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {buildSpotFlowReview} from './spot-flow-review.mjs';
import {SPOT_FLOW_HORIZONS_MS as HORIZONS} from '../src/spot-flow-observer.mjs';

const Decimal=DecimalBase.clone({precision:40});
const DAY=86400000, COSTS=[0,20,30];
const GROUPS=['strict_single_window','tape_price','book_price'];
export const BENCHMARK_VERSION='kev-consensus-quote-benchmark-v1';
const day=t=>new Date(t).toISOString().slice(0,10);
const hash=s=>createHash('sha256').update(s).digest('hex');
function dateStart(date){const t=Date.parse(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||!Number.isFinite(t)||day(t)!==date)throw Error('BENCHMARK_DATE_INVALID');return t;}
function decimal(v){if(!['number','string'].includes(typeof v)||String(v).length>100)throw Error();const d=new Decimal(v);if(!d.isFinite()||(!d.isZero()&&Math.abs(d.e)>50))throw Error();return d;}

// Bounds validate retained feature summaries, not the unavailable raw tape/book.
// In particular the original proof hash is not a substitute for that raw proof.
export function classifyConsensusFeatures(anchor){
 try{
  const f=anchor?.features,share=decimal(f?.takerBuyNotionalShare),move=decimal(f?.midChangeBps),spread=decimal(f?.spreadBps);
  if(share.lt(0)||share.gt(1)||move.lte(-10000)||!Array.isArray(f.top5Imbalances)||f.top5Imbalances.length!==3)throw Error();
  const books=f.top5Imbalances.map(decimal);if(books.some(v=>v.lte(-1)||v.gte(1)))throw Error();
  const bid=decimal(anchor.bid),ask=decimal(anchor.ask),mid=decimal(anchor.mid);
  if(bid.lte(0)||ask.lte(bid)||!mid.eq(bid.plus(ask).div(2))||spread.lt(0)||spread.gt(20000)
   ||spread.minus(ask.minus(bid).div(mid).mul(10000)).abs().gt('0.000000000001'))throw Error();
  if(anchor.checks&&(anchor.checks.tape!==share.gte('.55')||anchor.checks.depth!==books.every(v=>v.gt(0))||anchor.checks.mid!==move.gt(0)))throw Error();
  const common=move.gte('.25')&&books.every(v=>v.abs().lte('.7'));
  const tape=share.gte('.55'),book=books.slice(-2).every(v=>v.gt(0));
  return {status:'ok',groups:{strict_single_window:common&&tape&&book,tape_price:common&&tape,book_price:common&&book}};
 }catch{return {status:'invalid',reason:'FEATURES_INVALID',groups:null};}
}

function blankRow(policy,group,horizonMs){return {policy,group,horizonMs,qualifiedAnchors:0,overlappingExcluded:0,nonOverlappingSelected:0,
 observed:0,missing:0,pending:0,unresolvedEvidence:0,raw:[],mid:[]};}
const sum=xs=>xs.reduce((s,x)=>s.plus(x),new Decimal(0));
function summarizeRow({raw,mid,...row}){
 const total=sum(raw),mean=raw.length?total.div(raw.length):null;
 return {...row,averageRawQuoteMarkoutBps:mean?.toFixed()??null,averageMidMarkoutBps:mid.length?sum(mid).div(mid.length).toFixed():null,
  additionalCostScenarios:COSTS.map(extraCostBps=>({extraCostBps,observed:raw.length,
   averageAfterAdditionalCostBps:mean?.minus(extraCostBps).toFixed()??null,
   sumAfterAdditionalCostBps:raw.length?total.minus(new Decimal(extraCostBps).mul(raw.length)).toFixed():null,
   positiveQuoteCount:raw.filter(v=>v.gt(extraCostBps)).length,nonpositiveQuoteCount:raw.filter(v=>v.lte(extraCostBps)).length,
   positiveQuoteFraction:raw.length?new Decimal(raw.filter(v=>v.gt(extraCostBps)).length).div(raw.length).toFixed():null}))};
}

// The existing auditor owns record identity, quote arithmetic, anchor/markout
// joins, dates, future exclusion, pending evidence and duplicate validation.
// A corrupt day is suppressed altogether. Missing labels are valid evidence of
// unavailable outcomes; they remain denominators and never become zero returns.
export function buildConsensusBenchmarkDay({date,observedAt,files=[],state=null,stateFile=null}={}){
 const review=buildSpotFlowReview({date,observedAt,files,state,stateFile});
 const start=dateStart(date),now=Date.parse(observedAt),records=new Map();
 const result={date,observedAt,status:review.evidenceComplete?'observed':'excluded_incomplete_evidence',evidenceComplete:review.evidenceComplete,
  excludedDay:!review.evidenceComplete,inputFiles:review.inputFiles,structuralIssueCount:review.issues.length,issues:review.issues.slice(0,100),
  futureRecordsExcluded:review.futureRecordsExcluded,identicalDuplicates:review.identicalDuplicates,
  totalAnchors:review.anchors,validFeatureAnchors:0,invalidFeatureAnchors:0,featuresIssues:[],
  structuralOutcomeCoverage:review.cohorts.map(({policy,horizonMs,anchorEligible,observed,missing,pending,overlappingExcluded,unresolvedEvidence})=>
   ({policy,horizonMs,anchorEligible,observed,missing,pending,overlappingExcluded,unresolvedEvidence})),rows:[]};
 if(!review.evidenceComplete)return result;
 if(review.anchors===0){result.status='no_observations';result.evidenceComplete=false;result.excludedDay=true;
  result.issues.push({code:'NO_ANCHORS_ON_REQUESTED_DAY',date});return result;}
 const allowedFileDates=new Set([day(start-DAY),date,day(start+DAY)]);
 for(const f of files){if(f.status!=='ok'||!allowedFileDates.has(f.date))continue;for(const line of f.text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim())continue;const r=JSON.parse(line);if(r.recordedAt<=now)records.set(r.recordId,r);
 }}
 const anchors=[...records.values()].filter(r=>r.kind==='spot-flow-anchor').sort((a,b)=>a.sampledAt-b.sampledAt||a.anchorId.localeCompare(b.anchorId));
 const pending=new Map((state?.observer?.pending??[]).map(p=>[`${p.anchorId}:${p.horizonMs}`,p]));
 const priorNonOverlap=new Map(),proofs=new Map(),nonOverlapErrors=[];
 // Check the persisted common subsample before classification. We do not allow
 // a group-specific resampling to reward one arm with more favorable anchors.
 for(const a of anchors)for(const horizonMs of HORIZONS){
  const key=`${a.anchorId}:${horizonMs}`,m=records.get(`markout:${key}`),proof=m??pending.get(key);
  if(!proof)continue;proofs.set(key,proof);
  const stream=`${a.policy}|${a.pair}|${horizonMs}`,prior=priorNonOverlap.get(stream);
  if(!proof.nonOverlap){
   if(prior!==undefined&&a.sampledAt-prior>=horizonMs)nonOverlapErrors.push({code:'FALSE_NONOVERLAP_FLAG_HIDES_AVAILABLE_SAMPLE',anchorId:a.anchorId,horizonMs});
   // An adjacent day's first false flag can refer to a retained state anchor
   // before the read window. Do not invent that prior anchor. If a requested
   // day's sample is similarly unprovable, suppress that day's comparison.
   if(prior===undefined&&a.sampledAt>=start&&a.sampledAt<start+DAY)nonOverlapErrors.push({code:'NONOVERLAP_FLAG_UNVERIFIABLE',anchorId:a.anchorId,horizonMs});
   continue;
  }
  if(prior!==undefined&&a.sampledAt-prior<horizonMs)nonOverlapErrors.push({code:'OVERLAPPING_NONOVERLAP_FLAG',anchorId:a.anchorId,horizonMs});
  priorNonOverlap.set(stream,a.sampledAt);
 }
 if(nonOverlapErrors.length){result.evidenceComplete=false;result.excludedDay=true;result.status='excluded_incomplete_evidence';
  result.structuralIssueCount+=nonOverlapErrors.length;result.issues.push(...nonOverlapErrors.slice(0,100));return result;}
 const rows=new Map(),versions=new Set();
 const rowFor=(a,group,horizonMs)=>{const k=`${a.policy}|${group}|${horizonMs}`;if(!rows.has(k))rows.set(k,blankRow(a.policy,group,horizonMs));return rows.get(k);};
 for(const a of anchors){if(a.sampledAt<start||a.sampledAt>=start+DAY||a.sampledAt>now)continue;
  versions.add(a.signalCohort?.executionQualityVersion??'unrecorded');
  for(const group of GROUPS)for(const h of HORIZONS)rowFor(a,group,h);
  const classified=classifyConsensusFeatures(a);
  if(classified.status!=='ok'){result.invalidFeatureAnchors++;if(result.featuresIssues.length<100)result.featuresIssues.push({anchorId:a.anchorId,reason:classified.reason});continue;}
  result.validFeatureAnchors++;
  for(const group of GROUPS){if(!classified.groups[group])continue;for(const horizonMs of HORIZONS){
   const row=rowFor(a,group,horizonMs),proof=proofs.get(`${a.anchorId}:${horizonMs}`);row.qualifiedAnchors++;
   if(!proof){row.unresolvedEvidence++;continue;}
   if(!proof.nonOverlap){row.overlappingExcluded++;continue;}row.nonOverlappingSelected++;
   if(proof.kind==='hypotheticalQuoteMarkout'){
    row[proof.status]++;if(proof.status==='observed'){row.raw.push(decimal(proof.rawQuoteMarkoutBps));row.mid.push(decimal(proof.midMarkoutBps));}
   }else row.pending++;
  }}
 }
 result.inputExecutionQualityVersions=[...versions].sort();result.rows=[...rows.values()].map(summarizeRow);
 if(result.invalidFeatureAnchors){result.evidenceComplete=false;result.status='partial_feature_evidence';}
 return result;
}

export function combineConsensusBenchmarkDays({from,to,days=[]}={}){
 const start=dateStart(from),end=dateStart(to);if(end<start||end-start>366*DAY)throw Error('BENCHMARK_RANGE_INVALID');
 const expected=[];for(let t=start;t<=end;t+=DAY)expected.push(day(t));
 if(days.length!==expected.length||days.some((d,i)=>d.date!==expected[i]))throw Error('BENCHMARK_DAY_SEQUENCE_INVALID');
 const rows=new Map();
 for(const d of days){if(d.excludedDay)continue;for(const r of d.rows){
  const key=`${r.policy}|${r.group}|${r.horizonMs}`;
  if(!rows.has(key))rows.set(key,{policy:r.policy,group:r.group,horizonMs:r.horizonMs,includedDays:0,qualifiedAnchors:0,overlappingExcluded:0,nonOverlappingSelected:0,
   observed:0,missing:0,pending:0,unresolvedEvidence:0,rawSum:new Decimal(0),midSum:new Decimal(0),scenarios:COSTS.map(extraCostBps=>({extraCostBps,positiveQuoteCount:0,nonpositiveQuoteCount:0}))});
  const dest=rows.get(key);dest.includedDays++;
  for(const k of ['qualifiedAnchors','overlappingExcluded','nonOverlappingSelected','observed','missing','pending','unresolvedEvidence'])dest[k]+=r[k];
  if(r.observed){dest.rawSum=dest.rawSum.plus(decimal(r.averageRawQuoteMarkoutBps).mul(r.observed));dest.midSum=dest.midSum.plus(decimal(r.averageMidMarkoutBps).mul(r.observed));}
  for(let i=0;i<COSTS.length;i++){dest.scenarios[i].positiveQuoteCount+=r.additionalCostScenarios[i].positiveQuoteCount;dest.scenarios[i].nonpositiveQuoteCount+=r.additionalCostScenarios[i].nonpositiveQuoteCount;}
 }}
 const complete=days.every(d=>d.evidenceComplete);
 return {schemaVersion:1,version:BENCHMARK_VERSION,mode:'demo',side:'long',from,to,anchorTimezone:'UTC',
  observedAt:days.at(-1)?.observedAt??null,evidenceComplete:complete,status:complete?'quote_research_only':'incomplete_quote_research_only',
  automaticPromotion:false,recommendedStrategy:null,actualTradeWinRate:null,
  frozenHypotheses:{common:{minMidChangeBps:'0.25',maxAbsAllThreeBookImbalances:'0.7'},
   strict_single_window:{minTakerBuyShare:'0.55',latestTwoBookSigns:'positive'},tape_price:{minTakerBuyShare:'0.55',bookDirectionVeto:false},
   book_price:{tapeShareVeto:false,latestTwoBookSigns:'positive'}},
  excludedDays:days.filter(d=>d.excludedDay).map(d=>d.date),invalidFeatureAnchors:days.reduce((n,d)=>n+d.invalidFeatureAnchors,0),
  aggregateRows:[...rows.values()].map(({rawSum,midSum,scenarios,...r})=>({...r,
   averageRawQuoteMarkoutBps:r.observed?rawSum.div(r.observed).toFixed():null,averageMidMarkoutBps:r.observed?midSum.div(r.observed).toFixed():null,
   additionalCostScenarios:scenarios.map(s=>({...s,observed:r.observed,
    averageAfterAdditionalCostBps:r.observed?rawSum.div(r.observed).minus(s.extraCostBps).toFixed():null,
    sumAfterAdditionalCostBps:r.observed?rawSum.minus(new Decimal(s.extraCostBps).mul(r.observed)).toFixed():null,
    positiveQuoteFraction:r.observed?new Decimal(s.positiveQuoteCount).div(r.observed).toFixed():null}))})),days,
  limitations:[
   'Exploratory comparisons on retained prospective Spot observations, not new untouched out-of-sample evidence. No threshold fitting or strategy promotion.',
   'Strict single-window classification is not the full current Kev policy: no rolling confirmation, approval latency, costs, native risk, positions or capacity replay.',
   'Raw ask-to-future-bid markout already includes spread. Extra 0/20/30 bps are scenarios for commissions and other additional costs, not per-anchor verified fees; spread is not deducted twice.',
   'Displayed best quotes are not quantity-aware executable fills. Returns are quote markouts, not actual PnL, profit factor, drawdown or trade win rate.',
   'Stored raw-proof hashes do not reconstruct unavailable raw tape. Input SHA256 binds exact retained files; numeric feature checks cannot prove original market authenticity.',
   'All arms share the same persisted non-overlap subsample per policy/pair/horizon, checked for overlapping true flags. Pairs and day blocks can remain correlated.',
   'Only observed outcomes enter means. Missing, pending, corrupt days and invalid features are explicit; invalid-feature exclusions may bias partial results.',
   'Chronological daily rows are provided without a hindsight-selected winning variant. A fresh frozen prospective comparison is required before any promotion.'
  ]};
}

export async function readConsensusBenchmark({from,to,directory=join(ROOT,'local/demo/spot-flow-research')}={}){
 const start=dateStart(from),end=dateStart(to);if(end<start||end-start>366*DAY)throw Error('BENCHMARK_RANGE_INVALID');
 const days=[];
 for(let t=start;t<=end;t+=DAY){
  const files=[];
  for(const stamp of [t-DAY,t,t+DAY]){
   const date=day(stamp),path=join(directory,`observations-${date}.jsonl`);
   try{files.push({date,path,status:'ok',text:await readFile(path,'utf8')});}catch(e){files.push({date,path,status:e.code==='ENOENT'?'missing':'error'});}
  }
  const path=join(directory,'state.json');let state=null,stateFile={path,status:'missing',sha256:null};
  try{const text=await readFile(path,'utf8');stateFile={path,status:'ok',sha256:hash(text)};state=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(e){stateFile.status=e.code==='ENOENT'?'missing':'invalid_or_unreadable';}
  // Timestamp after all reads: a live state update cannot be from our future.
  days.push(buildConsensusBenchmarkDay({date:day(t),observedAt:new Date().toISOString(),files,state,stateFile}));
 }
 return combineConsensusBenchmarkDays({from,to,days});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length!==4||args[0]!=='--from'||args[2]!=='--to'){console.error('Usage: node scripts/kev-consensus-benchmark.mjs --from YYYY-MM-DD --to YYYY-MM-DD');process.exitCode=2;}
 else try{console.log(JSON.stringify(await readConsensusBenchmark({from:args[1],to:args[3]}),null,2));}
 catch(e){console.error(/^BENCHMARK_/.test(e.message)?e.message:'CONSENSUS_BENCHMARK_FAILED');process.exitCode=1;}
}
