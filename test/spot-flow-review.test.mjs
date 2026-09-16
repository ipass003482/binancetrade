import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Decimal from 'decimal.js';
import {buildSpotFlowReview,readSpotFlowReview} from '../scripts/spot-flow-review.mjs';
import {SPOT_FLOW_COHORT_VERSION} from '../src/spot-flow-observer.mjs';
import {FLOW_VERSION,SPOT_FLOW_CONTINUATION_VERSION,SPOT_FLOW_QUALITY_VERSION} from '../src/order-flow.mjs';
const VERSION='spot-flow-observer-v1',H=[60000,300000,900000],DATE='2026-09-15',B=Date.parse(DATE+'T06:00:00Z');
const hex=n=>String(n).padStart(64,'0'),day=t=>new Date(t).toISOString().slice(0,10);
function anchor({at=B,eligible=true,pair='ETH/USDT',id=1,policy='order-flow-only-v1'}={}){
 return {kind:'spot-flow-anchor',version:VERSION,mode:'demo',status:'ok',anchorId:hex(id),recordId:'anchor:'+hex(id),proofSha256:hex(id+100),
  policy,pair,source:'https://demo-api.binance.com',sampledAt:at,observedAt:at,recordedAt:at,eligible,bid:'100',ask:'100.02',mid:'100.01',horizonsMs:H};
}
function pending(a,horizonMs=60000,nonOverlap=true){return {anchorId:a.anchorId,anchorAt:a.sampledAt,proofSha256:a.proofSha256,policy:a.policy,pair:a.pair,
 eligible:a.eligible,bid:a.bid,ask:a.ask,mid:a.mid,horizonMs,nonOverlap,...(a.signalCohort===undefined?{}:{signalCohort:structuredClone(a.signalCohort)})};}
function mark(a,{horizonMs=60000,status='observed',nonOverlap=true,bid='101',ask='101.02',lag=0}={}){
 const targetAt=a.sampledAt+horizonMs,sampledAt=targetAt+lag,mid=new Decimal(bid).plus(ask).div(2).toFixed();
 const base={kind:'hypotheticalQuoteMarkout',version:VERSION,mode:'demo',anchorId:a.anchorId,recordId:`markout:${a.anchorId}:${horizonMs}`,
  anchorAt:a.sampledAt,anchorProofSha256:a.proofSha256,policy:a.policy,pair:a.pair,anchorEligible:a.eligible,horizonMs,targetAt,nonOverlap,status,
  ...(a.signalCohort===undefined?{}:{anchorSignalCohort:structuredClone(a.signalCohort)})};
 return status==='missing'?{...base,recordedAt:targetAt+20001,observedAt:null,sampledAt:null,rawQuoteMarkoutBps:null,midMarkoutBps:null}:
  {...base,recordedAt:sampledAt,observedAt:sampledAt,sampledAt,elapsedMs:horizonMs+lag,lateByMs:lag,observationProofSha256:hex(999),bid,ask,mid,
   rawQuoteMarkoutBps:new Decimal(bid).div(a.ask).minus(1).mul(10000).toFixed(),midMarkoutBps:new Decimal(mid).div(a.mid).minus(1).mul(10000).toFixed()};
}
function build(records,{date=DATE,now=B+60000,pendingRows,anchors=[anchor()],files,state}={}){
 const groups=new Map();for(const r of records){const d=day(r.recordedAt);groups.set(d,[...(groups.get(d)??[]),r]);}
 const inputFiles=files??[...groups].map(([date,rs])=>({date,path:`observations-${date}.jsonl`,status:'ok',text:rs.map(r=>JSON.stringify(r)).join('\n')+'\n'}));
 return buildSpotFlowReview({date,observedAt:new Date(now).toISOString(),files:inputFiles,
  state:state??{schemaVersion:1,observer:{version:VERSION,lastNow:now,pending:pendingRows??anchors.flatMap(a=>H.map(h=>pending(a,h)))}}});
}
const row=(r,h=60000,eligible=true,policy='order-flow-only-v1')=>r.cohorts.find(c=>c.horizonMs===h&&c.anchorEligible===eligible&&c.policy===policy);

test('fixed horizons and eligibility cohorts preserve pending, quote-only means and correlated sample warning',()=>{
 const a=anchor(),b=anchor({id:2,eligible:false,pair:'SOL/USDT'}),ma=mark(a),mb=mark(b,{bid:'99',ask:'99.02'});
 const r=build([a,b,ma,mb],{anchors:[a,b]});
 assert.equal(r.status,'observed');assert.equal(r.cohorts.length,6);assert.equal(r.anchors,2);
 assert.equal(row(r).observed,1);assert.equal(row(r).averageRawQuoteMarkoutBps,ma.rawQuoteMarkoutBps);
 assert.equal(row(r,60000,false).averageMidMarkoutBps,mb.midMarkoutBps);
 assert.equal(row(r,300000).pending,1);assert.equal(row(r,300000).averageRawQuoteMarkoutBps,null);
 assert.match(r.notes.join(' '),/correlated/);assert.match(r.notes.join(' '),/not fills, realized PnL, win rate/);
 assert.equal('winRate' in row(r),false);assert.equal(r.inputFiles[0].sha256.length,64);
});

test('identical record IDs including reordered object keys dedupe, conflicting IDs never silently win',()=>{
 const a=anchor(),m=mark(a),reordered=Object.fromEntries(Object.entries(m).reverse());
 const good=build([a,a,m,reordered]);assert.equal(good.status,'observed');assert.equal(good.identicalDuplicates,2);assert.equal(row(good).observed,1);
 const bad=build([a,m,{...m,bid:'999'}]);assert.equal(bad.status,'incomplete_evidence');assert.deepEqual(bad.conflictingRecordIds,[m.recordId]);
 assert.equal(row(bad).observed,0);assert.equal(row(bad).averageRawQuoteMarkoutBps,null);
});

test('missing outcomes stay missing and incomplete expired pending never becomes a zero return',()=>{
 const a=anchor(),m=mark(a,{status:'missing'}),now=B+80001;
 const observed=build([a,m],{now});assert.equal(observed.status,'observed');assert.equal(row(observed).missing,1);assert.equal(row(observed).observed,0);
 assert.equal(row(observed).averageRawQuoteMarkoutBps,null);
 const lost=build([a],{now});assert.equal(lost.status,'incomplete_evidence');assert.equal(row(lost).missing,0);assert.equal(row(lost).pending,0);
 assert.equal(row(lost).unresolvedEvidence,1);assert.ok(lost.issues.some(i=>i.code==='EXPIRED_PENDING_WITHOUT_MARKOUT'));
 const justBefore=build([a],{now:B+80000});assert.equal(row(justBefore).pending,1);assert.equal(justBefore.evidenceComplete,true);
});

test('only non-overlap records enter means and separate policies are not pooled',()=>{
 const a=anchor(),b=anchor({id:2,at:B+1000}),c=anchor({id:3,policy:'research-v2'});
 const records=[a,b,c,mark(a),mark(b,{nonOverlap:false,bid:'999',ask:'999.02'}),mark(c,{bid:'102',ask:'102.02'})];
 const ps=[...H.map(h=>pending(a,h)),...H.map(h=>pending(b,h,false)),...H.map(h=>pending(c,h))];
 const r=build(records,{now:B+61000,pendingRows:ps,anchors:[a,b,c]});
 assert.equal(r.status,'observed');assert.equal(r.cohorts.length,12);assert.equal(row(r).observed,1);assert.equal(row(r).overlappingExcluded,1);
 assert.equal(row(r).averageRawQuoteMarkoutBps,mark(a).rawQuoteMarkoutBps);assert.equal(row(r,60000,true,'research-v2').observed,1);
});

test('UTC anchor day joins next-day markouts without counting prior-day anchors',()=>{
 const midnight=Date.parse('2026-09-16T00:00:00Z'),a=anchor({at:midnight-60000}),previous=anchor({at:Date.parse('2026-09-14T23:59:00Z'),id:2});
 const r=build([previous,a,mark(a),mark(previous)],{now:midnight,anchors:[a],date:DATE});
 assert.equal(r.status,'observed');assert.equal(r.anchors,1);assert.equal(row(r).observed,1);assert.equal(row(r,300000).pending,1);
 assert.deepEqual(r.inputFiles.map(f=>f.date).sort(),['2026-09-14','2026-09-15','2026-09-16']);
});

test('future records and future quotes cannot mature outcomes before the requested as-of',()=>{
 const a=anchor(),future=anchor({at:B+90000,id:2});
 const r=build([a,mark(a),future],{now:B+30000});assert.equal(r.futureRecordsExcluded,2);assert.equal(r.anchors,1);
 assert.equal(row(r).observed,0);assert.equal(row(r).pending,1);assert.equal(row(r).averageRawQuoteMarkoutBps,null);
 const forged=mark(a);forged.recordedAt=B+30000;
 const bad=build([a,forged],{now:B+30000});assert.equal(bad.evidenceComplete,false);assert.equal(row(bad).observed,0);
});

test('missing target/state, corrupt tail, orphan markout and fabricated markout are incomplete',()=>{
 const a=anchor(),m=mark(a);
 const absent=build([],{files:[{date:DATE,path:'missing.jsonl',status:'missing'}]});assert.equal(absent.evidenceComplete,false);
 const tail=build([a,m],{files:[{date:DATE,path:'bad.jsonl',status:'ok',text:JSON.stringify(a)+'\n'+JSON.stringify(m)+'\n{"cut":'}]});
 assert.equal(tail.status,'incomplete_evidence');assert.ok(tail.issues.some(i=>i.code==='CORRUPT_JSONL'));assert.equal(row(tail).observed,1);
 const validButTorn=build([a,m],{files:[{date:DATE,path:'torn.jsonl',status:'ok',text:JSON.stringify(a)+'\n'+JSON.stringify(m)}]});
 assert.equal(validButTorn.evidenceComplete,false);assert.ok(validButTorn.issues.some(i=>i.code==='TORN_JSONL_TAIL'));
 const orphan=build([m],{anchors:[]});assert.ok(orphan.issues.some(i=>i.code==='MARKOUT_ANCHOR_MISSING'));
 const forged=build([a,{...m,rawQuoteMarkoutBps:'100000'}]);assert.equal(row(forged).observed,0);assert.equal(forged.evidenceComplete,false);
 const noState=buildSpotFlowReview({date:DATE,observedAt:new Date(B).toISOString(),files:[{date:DATE,path:'empty',status:'ok',text:''}]});
 assert.equal(noState.evidenceComplete,false);
});

test('conflicting pending/non-overlap attribution and unmatched horizons cannot look complete',()=>{
 const a=anchor(),m=mark(a),ps=H.map(h=>pending(a,h));ps[0].nonOverlap=false;
 const bad=build([a,m],{pendingRows:ps});assert.equal(bad.evidenceComplete,false);assert.equal(row(bad).observed,0);
 const lost=build([a],{pendingRows:[]});assert.equal(lost.evidenceComplete,false);assert.equal(lost.unresolved.length,3);
 assert.equal(row(lost).unresolvedEvidence,1);
 assert.equal(row(lost).averageRawQuoteMarkoutBps,null);
});

test('read wrapper hashes persisted files, accepts absent optional adjacent days and exposes invalid state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'spot-flow-review-'));
 try{
  const a=anchor(),state={schemaVersion:1,observer:{version:VERSION,lastNow:B,pending:H.map(h=>pending(a,h))}};
  await writeFile(join(directory,`observations-${DATE}.jsonl`),JSON.stringify(a)+'\n');await writeFile(join(directory,'state.json'),JSON.stringify(state));
  const r=await readSpotFlowReview({date:DATE,directory,observedAt:new Date(B).toISOString()});
  assert.equal(r.evidenceComplete,true);assert.equal(row(r).pending,1);assert.equal(r.inputFiles.filter(f=>f.status==='missing').length,2);
  assert.ok(r.inputFiles.filter(f=>f.status==='ok').every(f=>f.sha256.length===64));
  await writeFile(join(directory,'state.json'),'{');const bad=await readSpotFlowReview({date:DATE,directory,observedAt:new Date(B).toISOString()});
  assert.equal(bad.evidenceComplete,false);assert.equal(bad.inputFiles.at(-1).status,'invalid_or_unreadable');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('invalid calendar dates fail clearly',()=>{
 for(const date of ['2026-02-30','2026-9-15','../secrets'])assert.throws(()=>buildSpotFlowReview({date,observedAt:new Date(B).toISOString()}),/DATE_INVALID/);
});

function classified(a,continued=true,executionQualityVersion=SPOT_FLOW_QUALITY_VERSION){
 return {...a,signalCohort:{version:SPOT_FLOW_COHORT_VERSION,entryPolicyVersion:a.policy,executionQualityVersion,baseFlowVersion:FLOW_VERSION,
  baseFlowEligible:a.eligible,priceContinuationVersion:SPOT_FLOW_CONTINUATION_VERSION,priceContinuationEligible:continued,
  baseAndContinuationEligible:a.eligible&&continued,quoteBasis:'last_sampled_book',originQuoteAt:a.sampledAt-20000,
  originAsk:continued?'100':a.ask,quoteAt:a.sampledAt,quoteBid:a.bid,quoteAsk:a.ask,costsEvaluated:false,capacityEvaluated:false,orderEligibility:null}};
}
const signal=(r,{base=true,continued=true,horizon=60000,version=SPOT_FLOW_QUALITY_VERSION}={})=>r.signalCohorts.find(c=>
 c.baseFlowEligible===base&&c.priceContinuationEligible===continued&&c.horizonMs===horizon&&c.executionQualityVersion===version);

test('signal cohorts cross original base and sampled continuation, and legacy unknown remains distinct from false',()=>{
 const as=[classified(anchor({id:1}),true),classified(anchor({id:2}),false),classified(anchor({id:3,eligible:false}),true),
  classified(anchor({id:4,eligible:false}),false),anchor({id:5})];
 const r=build(as.flatMap(a=>[a,mark(a)]),{anchors:as});
 assert.equal(r.evidenceComplete,true);assert.equal(r.signalCohortEvidenceComplete,false);
 assert.deepEqual(r.signalCohortCoverage,{recordedAnchors:4,missingAnchors:1});
 for(const base of [true,false])for(const continued of [true,false]){
  const c=signal(r,{base,continued});assert.equal(c.observed,1);assert.equal(c.baseAndContinuationEligible,base&&continued);
  assert.equal(c.signalCohortVersion,SPOT_FLOW_COHORT_VERSION);assert.equal(c.quoteBasis,'last_sampled_book');
 }
 const missing=signal(r,{continued:null,version:null});assert.equal(missing.observed,1);assert.equal(missing.classificationEvidence,'missing');
 assert.equal(missing.baseAndContinuationEligible,null);assert.equal(missing.priceContinuationVersion,null);
 assert.equal(row(r).observed,3);assert.match(r.cohortsDefinition,/base_flow_only/);
 assert.match(r.notes.join(' '),/Costs, ATR risk, positions and capacity are not evaluated/);
});

test('recorded versions stay separate and pending/missing never become zero markout averages',()=>{
 const a=classified(anchor()),b=classified(anchor({id:2}),true,'flow-strength-exit-v1');
 const r=build([a,b,mark(a),mark(b,{status:'missing'})],{now:B+80001,anchors:[a,b]});
 assert.equal(r.signalCohortEvidenceComplete,true);assert.equal(signal(r).observed,1);
 assert.equal(signal(r,{version:'flow-strength-exit-v1'}).missing,1);
 assert.equal(signal(r,{version:'flow-strength-exit-v1'}).averageRawQuoteMarkoutBps,null);
 assert.equal(signal(r,{horizon:900000}).pending,1);assert.equal(signal(r,{horizon:900000}).averageMidMarkoutBps,null);
});

test('new cohort must revalidate sampled quotes and preserve identical anchor attribution in marks and pending',()=>{
 const a=classified(anchor()),m=mark(a);
 const inconsistent=structuredClone(a);inconsistent.signalCohort.priceContinuationEligible=false;
 const bad=build([inconsistent,m],{anchors:[inconsistent]});assert.equal(bad.evidenceComplete,false);
 assert.ok(bad.issues.some(i=>i.code==='INVALID_ANCHOR'));assert.equal(row(bad).observed,0);
 const changedMark=structuredClone(m);changedMark.anchorSignalCohort.executionQualityVersion='another-version';
 const changed=build([a,changedMark],{anchors:[a]});assert.equal(changed.evidenceComplete,false);assert.equal(signal(changed).observed,0);
 const omitted=structuredClone(m);delete omitted.anchorSignalCohort;
 assert.equal(build([a,omitted],{anchors:[a]}).evidenceComplete,false);
 const ps=H.map(h=>pending(a,h));delete ps[1].signalCohort;
 const lost=build([a,m],{anchors:[a],pendingRows:ps});assert.equal(lost.evidenceComplete,false);
 assert.equal(signal(lost,{horizon:300000}).unresolvedEvidence,1);
});

test('cross-day review uses original cohort instead of the next-day quote or current quality version',()=>{
 const midnight=Date.parse('2026-09-16T00:00:00Z'),a=classified(anchor({at:midnight-60000}),false,'flow-strength-exit-v1');
 const r=build([a,mark(a,{bid:'105',ask:'105.02'})],{now:midnight,anchors:[a]});
 assert.equal(r.signalCohortEvidenceComplete,true);assert.equal(signal(r,{continued:false,version:'flow-strength-exit-v1'}).observed,1);
 assert.equal(signal(r,{continued:true,version:SPOT_FLOW_QUALITY_VERSION}),undefined);
});
