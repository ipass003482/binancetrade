import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Decimal from 'decimal.js';
import {buildConsensusBenchmarkDay,combineConsensusBenchmarkDays,classifyConsensusFeatures,readConsensusBenchmark} from '../scripts/kev-consensus-benchmark.mjs';

const DATE='2026-09-16',B=Date.parse(DATE+'T06:00:00Z'),H=[60000,300000,900000],V='spot-flow-observer-v1';
const hex=n=>String(n).padStart(64,'0'),day=t=>new Date(t).toISOString().slice(0,10);
function anchor({id=1,at=B,pair='ETH/USDT',share='.6',books=['.1','.2','.3'],move='1'}={}){
 const bid='100',ask='100.02',mid='100.01';
 return {kind:'spot-flow-anchor',version:V,mode:'demo',status:'ok',policy:'order-flow-only-v1',pair,
  anchorId:hex(id),recordId:'anchor:'+hex(id),proofSha256:hex(id+100),source:'https://demo-api.binance.com',
  sampledAt:at,observedAt:at,recordedAt:at,eligible:true,bid,ask,mid,horizonsMs:H,
  features:{takerBuyNotionalShare:share,top5Imbalances:books,midChangeBps:move,
   spreadBps:new Decimal(ask).minus(bid).div(mid).mul(10000).toFixed()}};
}
function pending(a,h,nonOverlap=true){return {anchorId:a.anchorId,anchorAt:a.sampledAt,proofSha256:a.proofSha256,policy:a.policy,pair:a.pair,
 eligible:a.eligible,bid:a.bid,ask:a.ask,mid:a.mid,horizonMs:h,nonOverlap};}
function mark(a,h=60000,{bid='100.12',ask='100.14',status='observed',nonOverlap=true,lag=0}={}){
 const t=a.sampledAt+h,at=t+lag,mid=new Decimal(bid).plus(ask).div(2).toFixed();
 const base={kind:'hypotheticalQuoteMarkout',version:V,mode:'demo',policy:a.policy,pair:a.pair,
  anchorId:a.anchorId,recordId:`markout:${a.anchorId}:${h}`,anchorAt:a.sampledAt,anchorProofSha256:a.proofSha256,
  horizonMs:h,targetAt:t,nonOverlap,anchorEligible:a.eligible,status};
 if(status==='missing')return {...base,recordedAt:t+20001,observedAt:null,sampledAt:null,rawQuoteMarkoutBps:null,midMarkoutBps:null};
 return {...base,recordedAt:at,observedAt:at,sampledAt:at,elapsedMs:h+lag,lateByMs:lag,observationProofSha256:hex(999),bid,ask,mid,
  rawQuoteMarkoutBps:new Decimal(bid).div(a.ask).minus(1).mul(10000).toFixed(),
  midMarkoutBps:new Decimal(mid).div(a.mid).minus(1).mul(10000).toFixed()};
}
function build(records,{now=B+920001,date=DATE,pendingRows=[],files}={}){
 const groups=new Map();for(const r of records){const d=day(r.recordedAt);groups.set(d,[...(groups.get(d)??[]),r]);}
 const input=files??[...groups].map(([date,rs])=>({date,path:`observations-${date}.jsonl`,status:'ok',text:rs.map(r=>JSON.stringify(r)).join('\n')+'\n'}));
 return buildConsensusBenchmarkDay({date,observedAt:new Date(now).toISOString(),files:input,
  state:{schemaVersion:1,observer:{version:V,lastNow:now,pending:pendingRows}}});
}
const all=(a,options)=>[a,...H.map(h=>mark(a,h,options))];
const row=(r,g='strict_single_window',h=60000)=>r.rows.find(x=>x.group===g&&x.horizonMs===h);

test('frozen arms isolate tape/book direction votes and preserve common movement/depth limits',()=>{
 assert.deepEqual(classifyConsensusFeatures(anchor()).groups,{strict_single_window:true,tape_price:true,book_price:true});
 assert.deepEqual(classifyConsensusFeatures(anchor({books:['.2','-.1','-.2']})).groups,{strict_single_window:false,tape_price:true,book_price:false});
 assert.deepEqual(classifyConsensusFeatures(anchor({share:'.4'})).groups,{strict_single_window:false,tape_price:false,book_price:true});
 assert.deepEqual(classifyConsensusFeatures(anchor({books:['-.7','.1','.2'],move:'.25',share:'.55'})).groups,{strict_single_window:true,tape_price:true,book_price:true});
 for(const a of [anchor({move:'.249'}),anchor({books:['.70000001','.1','.2']})])assert.ok(Object.values(classifyConsensusFeatures(a).groups).every(v=>!v));
 // Decisions use retained features, not the original policy's eligible flag.
 const a=anchor();a.eligible=false;assert.equal(classifyConsensusFeatures(a).groups.strict_single_window,true);
});

test('ask-to-future-bid includes spread once and extra-cost scenarios cannot be misreported as wins',()=>{
 const a=anchor(),r=build(all(a));assert.equal(r.evidenceComplete,true);assert.equal(row(r).observed,1);
 const raw=new Decimal(mark(a).rawQuoteMarkoutBps);
 assert.equal(row(r).averageRawQuoteMarkoutBps,raw.toFixed());
 assert.equal(row(r).additionalCostScenarios[1].averageAfterAdditionalCostBps,raw.minus(20).toFixed());
 assert.equal(row(r).additionalCostScenarios[0].positiveQuoteCount,1);
 assert.equal(row(r).additionalCostScenarios[1].positiveQuoteCount,0);
 assert.equal('winRate' in row(r),false);
 const combined=combineConsensusBenchmarkDays({from:DATE,to:DATE,days:[r]});
 assert.equal(combined.actualTradeWinRate,null);assert.equal(combined.recommendedStrategy,null);assert.equal(combined.automaticPromotion,false);
 assert.match(combined.limitations.join(' '),/spread is not deducted twice/);
 assert.equal(r.inputFiles[0].sha256.length,64);
});

test('all arms share non-overlap sample and reject conflicting or overlapping persisted flags',()=>{
 const a=anchor(),b=anchor({id:2,at:B+1000,books:['.1','-.1','-.1']});
 const r=build([...all(a),...all(b,{nonOverlap:false,bid:'999',ask:'999.02'})],{now:B+921001});
 assert.equal(r.evidenceComplete,true);assert.equal(row(r,'tape_price').qualifiedAnchors,2);
 assert.equal(row(r,'tape_price').overlappingExcluded,1);assert.equal(row(r,'tape_price').observed,1);
 assert.equal(row(r,'tape_price').averageRawQuoteMarkoutBps,row(r).averageRawQuoteMarkoutBps);
 const bad=build([...all(a),...all(b)],{now:B+921001});assert.equal(bad.excludedDay,true);
 assert.ok(bad.issues.some(i=>i.code==='OVERLAPPING_NONOVERLAP_FLAG'));assert.equal(bad.rows.length,0);
 const conflict=build([...all(a),{...mark(a),nonOverlap:false}]);assert.equal(conflict.excludedDay,true);assert.equal(conflict.rows.length,0);
});

test('false non-overlap flags cannot hide a mature independent sample and unknown first flags remain unknown',()=>{
 const a=anchor(),b=anchor({id:2,at:B+1000000});
 const bad=build([...all(a),...all(b,{nonOverlap:false})],{now:B+2000000});
 assert.equal(bad.excludedDay,true);assert.equal(bad.rows.length,0);
 assert.ok(bad.issues.some(i=>i.code==='FALSE_NONOVERLAP_FLAG_HIDES_AVAILABLE_SAMPLE'));
 const unknown=build(all(a,{nonOverlap:false}));
 assert.equal(unknown.excludedDay,true);assert.ok(unknown.issues.some(i=>i.code==='NONOVERLAP_FLAG_UNVERIFIABLE'));
 // The leading adjacent-day boundary can be unknown until a genuine true
 // marker appears, after which the requested day's flag becomes verifiable.
 const midnight=Date.parse(DATE+'T00:00:00Z'),prior=anchor({id:3,at:midnight-1800000}),known=anchor({id:4,at:midnight-900000});
 const good=build([...all(prior,{nonOverlap:false}),...all(known),...all(a)]);
 assert.equal(good.evidenceComplete,true);assert.equal(row(good).observed,1);
});

test('missing and pending are explicit denominators with null means; expired or lost labels exclude day',()=>{
 const a=anchor();
 const r=build([a,mark(a,60000,{status:'missing'})],{now:B+80001,pendingRows:H.slice(1).map(h=>pending(a,h))});
 assert.equal(r.evidenceComplete,true);assert.equal(row(r).missing,1);assert.equal(row(r).observed,0);
 assert.equal(row(r).averageRawQuoteMarkoutBps,null);assert.equal(row(r).additionalCostScenarios[0].positiveQuoteFraction,null);
 assert.equal(row(r,'strict_single_window',300000).pending,1);
 assert.equal(row(r).nonOverlappingSelected,1);
 const lost=build([a],{now:B+80001,pendingRows:H.map(h=>pending(a,h))});assert.equal(lost.excludedDay,true);
 assert.ok(lost.issues.some(i=>i.code==='EXPIRED_PENDING_WITHOUT_MARKOUT'));
});

test('future records are excluded; a forged early record cannot introduce future outcome information',()=>{
 const a=anchor(),future=anchor({id:2,at:B+90000});
 const r=build([a,mark(a),future],{now:B+30000,pendingRows:H.map(h=>pending(a,h))});
 assert.equal(r.evidenceComplete,true);assert.equal(r.futureRecordsExcluded,2);assert.equal(r.totalAnchors,1);
 assert.equal(row(r).pending,1);assert.equal(row(r).observed,0);
 const forged={...mark(a),recordedAt:B+30000};
 assert.equal(build([a,forged],{now:B+30000,pendingRows:H.map(h=>pending(a,h))}).excludedDay,true);
});

test('invalid feature bounds/shape/nonfinite/crossed or inconsistent summaries cannot select a research arm',()=>{
 const bads=[anchor({share:'1.1'}),anchor({share:'NaN'}),anchor({move:'Infinity'}),anchor({move:'-10000'}),
  anchor({books:['.1','.2']}),anchor({books:['.1','.2','1']}),anchor({books:['.1','.2',null]})];
 const spread=anchor();spread.features.spreadBps='100';bads.push(spread);
 const check=anchor();check.checks={tape:false,depth:true,mid:true};bads.push(check);
 for(const a of bads){assert.equal(classifyConsensusFeatures(a).status,'invalid');const r=build(all(a));
  assert.equal(r.invalidFeatureAnchors,1);assert.equal(r.validFeatureAnchors,0);assert.equal(r.evidenceComplete,false);
  assert.equal(r.excludedDay,false);assert.equal(r.status,'partial_feature_evidence');assert.equal(row(r).observed,0);assert.equal(row(r).averageRawQuoteMarkoutBps,null);}
});

test('corrupt/ambiguous joins, invented returns and torn tails suppress the day without zero substitution',()=>{
 const a=anchor();
 for(const rs of [[...all(a),{...a,ask:'999'}],[a,...H.map(h=>({...mark(a,h),anchorProofSha256:hex(55)}))],
  [a,...H.map(h=>({...mark(a,h),rawQuoteMarkoutBps:'999999'}))]]){
  const r=build(rs);assert.equal(r.excludedDay,true);assert.equal(r.rows.length,0);
 }
 const text=all(a).map(r=>JSON.stringify(r)).join('\n')+'\n{"torn":';
 const r=build([],{files:[{date:DATE,path:'broken',status:'ok',text}]});assert.equal(r.excludedDay,true);
 assert.ok(r.issues.some(i=>i.code==='TORN_JSONL_TAIL'));
});

test('files ignored by the existing validator cannot overwrite validated anchors or markouts',()=>{
 const a=anchor(),good=all(a),forged={...mark(a),rawQuoteMarkoutBps:'99999'};
 const files=[{date:DATE,path:'valid',status:'ok',text:good.map(r=>JSON.stringify(r)).join('\n')+'\n'},
  {date:'2026-09-01',path:'outside-validation-window',status:'ok',text:JSON.stringify(forged)+'\n'}];
 const r=build([],{files});assert.equal(r.evidenceComplete,true);assert.equal(row(r).averageRawQuoteMarkoutBps,mark(a).rawQuoteMarkoutBps);
 assert.equal(r.inputFiles.some(f=>f.path==='outside-validation-window'),false);
});

test('chronological UTC day joins preserve next-day outcomes and aggregate only observed quote denominators',()=>{
 const next='2026-09-17',midnight=Date.parse(next+'T00:00:00Z'),a=anchor({at:midnight-1000}),b=anchor({at:midnight+1000000,id:2});
 const records=[...all(a),...all(b,{status:'missing'})],now=midnight+2000000;
 const first=build(records,{date:DATE,now}),second=build(records,{date:next,now});
 assert.equal(first.evidenceComplete,true);assert.equal(second.evidenceComplete,true);
 const report=combineConsensusBenchmarkDays({from:DATE,to:next,days:[first,second]});
 assert.deepEqual(report.days.map(d=>d.date),[DATE,next]);
 const r=report.aggregateRows.find(x=>x.group==='strict_single_window'&&x.horizonMs===60000);
 assert.equal(r.observed,1);assert.equal(r.missing,1);assert.equal(r.nonOverlappingSelected,2);
 assert.equal(r.averageRawQuoteMarkoutBps,mark(a).rawQuoteMarkoutBps);
 assert.throws(()=>combineConsensusBenchmarkDays({from:DATE,to:next,days:[second,first]}),/SEQUENCE_INVALID/);
});

test('file wrapper snapshots and hashes local inputs, timestamps after reads and handles invalid ranges',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kev-consensus-benchmark-'));
 try{
  const a=anchor(),text=all(a).map(r=>JSON.stringify(r)).join('\n')+'\n';
  await writeFile(join(directory,`observations-${DATE}.jsonl`),text);
  await writeFile(join(directory,'state.json'),JSON.stringify({schemaVersion:1,observer:{version:V,lastNow:B+1000000,pending:[]}}));
  const r=await readConsensusBenchmark({from:DATE,to:DATE,directory});assert.equal(r.evidenceComplete,true);
  assert.ok(Date.parse(r.observedAt)>=B+1000000);assert.equal(r.days[0].inputFiles.filter(f=>f.status==='ok').length,2);
  assert.ok(r.days[0].inputFiles.filter(f=>f.status==='ok').every(f=>f.sha256.length===64));
  await assert.rejects(readConsensusBenchmark({from:'2026-02-30',to:DATE,directory}),/DATE_INVALID/);
  await assert.rejects(readConsensusBenchmark({from:'2026-09-17',to:DATE,directory}),/RANGE_INVALID/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('an empty recorder day is unavailable coverage, never a complete zero-result trading day',()=>{
 const r=build([],{files:[{date:DATE,path:'empty',status:'ok',text:''}]});
 assert.equal(r.status,'no_observations');assert.equal(r.evidenceComplete,false);assert.equal(r.excludedDay,true);assert.equal(r.rows.length,0);
 const report=combineConsensusBenchmarkDays({from:DATE,to:DATE,days:[r]});
 assert.equal(report.evidenceComplete,false);assert.deepEqual(report.excludedDays,[DATE]);assert.equal(report.aggregateRows.length,0);
});
