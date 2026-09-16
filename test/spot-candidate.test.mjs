import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {makeInitialSpotCandidates,freshSpotCandidateQuotes,newSpotCandidateState,advanceSpotCandidates,reviewSpotCandidates,recoverSpotCandidateState,validateSpotCandidateState,createSpotCandidateReviewAccumulator} from '../src/spot-candidate.mjs';
import {enqueueInitialSpotCandidates,createSpotCandidateStore} from '../src/spot-candidate-store.mjs';
import {readSpotCandidateReview} from '../scripts/spot-candidate-review.mjs';
const B=Date.parse('2026-09-16T01:00:00Z'),pair='ETH/USDT';
function input(now=B+2000){return {now,policy:{mode:'demo',maxExposureUsdt:150,maxOpenTrades:3},account:{trades:[]},strategyVersion:{fingerprint:'test-fingerprint'},snapshot:{id:'snapshot-test-1',mode:'demo',markets:[{pair,fetchedAt:new Date(B).toISOString(),bid:'100',ask:'100.02',orderFlow:{proof:true},entryCost:{status:'ok',mode:'demo',pair,source:'https://demo-api.binance.com',observedAt:new Date(B).toISOString(),buyRate:'.001',sellRate:'.001',slippageBpsPerSide:'5',roundTripFeeBps:'20',spreadBps:'2',fundingReserveBps:'0',estimatedRoundTripCostBps:'32'}}]},reference:{metadata:{snapshotId:'snapshot-test-1'},selected:{pair},candidates:[{pair,action:'buy',stakeUsdt:'50',entryPolicyVersion:'order-flow-only-v1',executionQualityVersion:'flow-confirmed-exit-v2',reasons:[],directionChecks:[{action:'buy',eligible:true,flowDiagnostics:{eligible:true},executionContinuation:{eligible:true}}]}]}};}
function sample(at,bid=100,ask=100.02,p=pair){return {mode:'demo',markets:{[p]:{mode:'demo',pair:p,source:'https://demo-api.binance.com',books:[{at,updateId:1,bids:Array.from({length:5},(_,i)=>[String(bid-i*.001),'1']),asks:Array.from({length:5},(_,i)=>[String(ask+i*.001),'1'])}]}}};}
const quotes=(at,bid=100,ask=100.02,p=pair)=>freshSpotCandidateQuotes(sample(at,bid,ask,p),at);
function anchored(){const c=makeInitialSpotCandidates(input())[0],r=advanceSpotCandidates(newSpotCandidateState(B),{now:B+3000,candidates:[c],quotes:quotes(B+3000)});return {c,...r};}
function mature(){const a=anchored(),r=advanceSpotCandidates(a.state,{now:B+63000,quotes:quotes(B+63000,101,101.02)});return {...r,records:[...a.records,...r.records]};}
test('exact initial snapshot/rules evidence and stages keep bridge/fills unknown; spread is not charged twice',()=>{
 const data=input(),before=JSON.stringify(data),c=makeInitialSpotCandidates(data)[0];assert.equal(JSON.stringify(data),before);
 assert.equal(c.qualifications.initialOrderCandidate,true);assert.equal(c.qualifications.costRisk,true);assert.equal(c.qualifications.size,true);assert.equal(c.qualifications.capacity,true);
 for(const key of ['bridgeExecutionQuote','bridgeQuality','nativeProtection','sharedPortfolio','submitted','filled'])assert.equal(c.qualifications[key],null);
 assert.equal(c.cost.additionalCostBps,'30');assert.equal(c.quote.at,B);assert.match(c.evidence.snapshotJsonSha256,/^[a-f0-9]{64}$/);assert.equal(c.evidence.snapshotPath,'runs/snapshot-test-1.snapshot.json');
 data.account.trades=[{pair,stake_amount:'100'}];let held=makeInitialSpotCandidates(data)[0];assert.equal(held.qualifications.heldPairAllowed,false);assert.equal(held.qualifications.initialOrderCandidate,false);
 data.account.trades=[{pair:'BTC/USDT',stake_amount:'101'}];assert.equal(makeInitialSpotCandidates(data)[0].qualifications.capacity,false);
 data.reference.candidates[0].action='hold';delete data.reference.candidates[0].stakeUsdt;assert.equal(makeInitialSpotCandidates(data)[0].qualifications.size,null);assert.equal(makeInitialSpotCandidates(data)[0].qualifications.capacity,null);
 data.snapshot.markets[0].entryCost.source='https://api.binance.com';assert.equal(makeInitialSpotCandidates(data)[0].cost,null);
});
test('postdecision first quote anchors horizons, predecision ask cannot shorten the horizon',()=>{
 const c=makeInitialSpotCandidates(input())[0];let r=advanceSpotCandidates(newSpotCandidateState(B),{now:B+2000,candidates:[c],quotes:quotes(B+1000)});
 assert.equal(r.records.length,1);assert.equal(r.state.pending[0].anchor,null);
 r=advanceSpotCandidates(r.state,{now:B+3000,quotes:quotes(B+3000)});assert.equal(r.records.length,1);assert.equal(r.records[0].kind,'candidateQuoteAnchor');assert.equal(r.state.pending[0].anchor.quote.at,B+3000);
 let early=advanceSpotCandidates(r.state,{now:B+62000,quotes:quotes(B+62000,101,101.02)});assert.equal(early.records.length,0);
 let good=advanceSpotCandidates(early.state,{now:B+63000,quotes:quotes(B+63000,101,101.02)});assert.equal(good.records[0].targetAt,B+63000);assert.equal(good.records[0].status,'observed');assert.equal(good.records[0].additionalCostBps,'30');
 const repeat=advanceSpotCandidates(good.state,{now:B+63001,quotes:quotes(B+63001,200,200.02)});assert.equal(repeat.records.length,0);
});
test('missing postdecision and future quotes remain unavailable/missing, not zero; late quotes never backfill',()=>{
 const c=makeInitialSpotCandidates(input())[0];let r=advanceSpotCandidates(newSpotCandidateState(B),{now:B+22001,candidates:[c],quotes:quotes(B+22001)});
 assert.equal(r.records.filter(r=>r.status==='unavailable').length,3);assert.equal(r.state.pending.length,0);assert.equal(reviewSpotCandidates(r.records).unavailableHorizons,3);
 const a=anchored();r=advanceSpotCandidates(a.state,{now:B+83001,quotes:quotes(B+83001,102,102.02)});assert.equal(r.records[0].status,'missing');assert.equal(r.records[0].rawQuoteMarkoutBps,null);
 const report=reviewSpotCandidates([...a.records,...r.records]);assert.equal(report.issues.length,0);assert.equal(report.cohorts[0].missing,1);assert.equal(report.cohorts[0].averageRawQuoteMarkoutBps,null);
});
test('future quotes need valid source and book, not positive tape; unknown costs stay null',()=>{
 assert.equal(quotes(B).length,1);const corrupt=sample(B);corrupt.markets[pair].source='https://api.binance.com';assert.equal(freshSpotCandidateQuotes(corrupt,B).length,0);
 assert.equal(freshSpotCandidateQuotes(sample(B+1),B).length,0);assert.equal(freshSpotCandidateQuotes(sample(B,101,100),B).length,0);
 const data=input();delete data.snapshot.markets[0].entryCost;const c=makeInitialSpotCandidates(data)[0];let r=advanceSpotCandidates(newSpotCandidateState(B),{now:B+3000,candidates:[c],quotes:quotes(B+3000)});
 const rows=r.records;r=advanceSpotCandidates(r.state,{now:B+63000,quotes:quotes(B+63000,101,101.02)});assert.equal(r.records[0].additionalCostBps,null);assert.equal(r.records[0].estimatedAfterAdditionalCostBps,null);
 const report=reviewSpotCandidates([...rows,...r.records]);assert.equal(report.issues.length,0);assert.equal(report.cohorts[0].costKnown,0);assert.equal(report.cohorts[0].averageEstimatedAfterAdditionalCostBps,null);
});
test('review rejects early target, illegal horizon, identity, future quote and cost tampering',()=>{
 const valid=mature();assert.equal(reviewSpotCandidates(valid.records).issues.length,0);
 for(const mutation of [r=>r.targetAt=B+4000,r=>r.horizonMs=1000,r=>r.recordId='fake',r=>r.policy='changed',r=>r.pair='BTC/USDT',r=>r.futureQuote.observedAt=r.recordedAt+1,r=>r.estimatedAfterAdditionalCostBps='0',r=>r.additionalCostBps='32',r=>r.nonOverlap=false]){
  const rows=structuredClone(valid.records);mutation(rows.find(r=>r.kind==='hypotheticalCandidateQuoteMarkout'));assert.ok(reviewSpotCandidates(rows).issues.length>0);
 }
 assert.equal(reviewSpotCandidates([...valid.records,...valid.records]).cohorts[0].observed,1);
});
test('journal recovery restores original anchor and pending outcomes, rejects conflicts',()=>{
 const a=anchored();let state=recoverSpotCandidateState(null,a.records,B+1000000);assert.equal(state.pending.length,3);assert.equal(state.pending[0].anchor.quote.at,B+3000);
 let r=advanceSpotCandidates(state,{now:B+1000000,quotes:[]});assert.equal(r.records.length,3);assert.ok(r.records.every(r=>r.status==='missing'));
 const m=mature();state=recoverSpotCandidateState(null,m.records,B+70000);assert.equal(state.pending.length,2);assert.ok(state.pending.every(p=>p.horizonMs!==60000));
 const conflict=structuredClone(a.records[0]);conflict.requestedStakeUsdt='999';assert.throws(()=>recoverSpotCandidateState(null,[...a.records,conflict],B+4000),/JOURNAL_INVALID/);
});
test('nonoverlap is per pair/policy/quality/horizon; duplicate candidates and clocks fail closed',()=>{
 const a=anchored(),data=input(B+10000);data.snapshot.id='snapshot-test-2';data.reference.metadata.snapshotId=data.snapshot.id;
 const second=makeInitialSpotCandidates(data)[0],r=advanceSpotCandidates(a.state,{now:B+10000,candidates:[second],quotes:quotes(B+10000)});assert.ok(r.state.pending.filter(p=>p.candidate.candidateId===second.candidateId).every(p=>p.nonOverlap===false));
 assert.equal(advanceSpotCandidates(a.state,{now:B+3000,candidates:[a.c]}).diagnostics.duplicates,1);
 assert.throws(()=>advanceSpotCandidates(a.state,{now:B+2999}),/STATE_INVALID/);
 const invalid=structuredClone(a.state);invalid.pending[0].horizonMs=1;assert.throws(()=>advanceSpotCandidates(invalid,{now:B+3000}),/PENDING_INVALID/);
});
async function fixture(t){const local=await mkdtemp(join(tmpdir(),'binance-candidate-test-'));t.after(async()=>{assert.ok(resolve(local).startsWith(resolve(tmpdir())+sep));assert.match(basename(local),/^binance-candidate-test-/);await rm(local,{recursive:true,force:true});});return {local,dir:join(local,'spot-candidate-research'),journal:join(local,'spot-candidate-research/candidates-2026-09-16.jsonl')};}
test('store persists queued candidate/anchor and real future quotes, restart keeps first values',async t=>{
 const f=await fixture(t);assert.equal(enqueueInitialSpotCandidates(f.local,input()).accepted,1);let record=createSpotCandidateStore(f.local);
 const first=await record(sample(B+3000),B+3000);assert.equal(first.status,'observing');assert.equal(first.pending,3);
 record=createSpotCandidateStore(f.local);assert.equal((await record(sample(B+63000,101,101.02),B+63000)).recordsThisSample,1);
 const before=await readFile(f.journal,'utf8');record=createSpotCandidateStore(f.local);assert.equal((await record(sample(B+63000,200,200.02),B+63000)).recordsThisSample,0);assert.equal(await readFile(f.journal,'utf8'),before);
});
test('append-before-state-write crash rebuilds pending and original quote; conflicts do not alter journal',async t=>{
 const f=await fixture(t),a=anchored();await mkdir(f.dir,{recursive:true});await writeFile(f.journal,a.records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const r=await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},B+1000000);assert.equal(r.status,'observing');assert.equal(r.recordsThisSample,3);assert.equal(r.pending,0);
 const rows=(await readFile(f.journal,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(reviewSpotCandidates(rows).cohorts.reduce((s,g)=>s+g.missing,0),3);
 const bad=structuredClone(a.records[0]);bad.requestedStakeUsdt='999';await writeFile(f.journal,JSON.stringify(bad)+'\n',{flag:'a'});const before=await readFile(f.journal,'utf8');
 assert.equal((await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},B+1000001)).status,'unavailable');assert.equal(await readFile(f.journal,'utf8'),before);
});
test('research I/O failure returns unavailable and cannot reject trading caller',async t=>{
 const f=await fixture(t);await writeFile(f.dir,'not a directory');enqueueInitialSpotCandidates(f.local,input());const result=await createSpotCandidateStore(f.local)(sample(B+3000),B+3000);assert.equal(result.status,'unavailable');assert.equal(result.usedForEntries,false);
});
test('cost evidence preserves producer Decimal20 rounding while fees and slippage stay separate',()=>{
 const data=input(),cost=data.snapshot.markets[0].entryCost;cost.spreadBps='5.1150895140664961637';cost.estimatedRoundTripCostBps='35.115089514066496164';assert.equal(makeInitialSpotCandidates(data)[0].cost.additionalCostBps,'30');
 cost.estimatedRoundTripCostBps='35.12';assert.equal(makeInitialSpotCandidates(data)[0].cost,null);
});
test('same timestamp candidate anchors preserve original nonoverlap order on restart',()=>{
 const data=input(),a=makeInitialSpotCandidates(data)[0];data.snapshot.id='other-snapshot';data.reference.metadata.snapshotId=data.snapshot.id;const b=makeInitialSpotCandidates(data)[0];
 const candidates=[a,b].sort((x,y)=>y.candidateId.localeCompare(x.candidateId));const first=advanceSpotCandidates(newSpotCandidateState(B),{now:B+3000,candidates,quotes:quotes(B+3000)});
 const restored=recoverSpotCandidateState(null,first.records,B+4000);for(const p of first.state.pending)assert.equal(restored.pending.find(q=>q.candidate.candidateId===p.candidate.candidateId&&q.horizonMs===p.horizonMs).nonOverlap,p.nonOverlap);
});
test('more than two days of downtime preserves journaled first outcome even when state was lost',async t=>{
 const f=await fixture(t),done=mature();await mkdir(f.dir,{recursive:true});await writeFile(f.journal,done.records.map(r=>JSON.stringify(r)).join('\n')+'\n');const before=await readFile(f.journal,'utf8');
 const after=await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},B+3*86400000);assert.equal(after.status,'observing');assert.equal(after.recordsThisSample,2);assert.equal(after.pending,0);assert.equal(await readFile(f.journal,'utf8'),before);
 const report=await readSpotCandidateReview({date:'2026-09-16',directory:f.dir});assert.equal(report.unresolvedHorizons,0);assert.equal(report.cohorts.reduce((n,g)=>n+g.missing,0),2);assert.equal(report.cohorts.reduce((n,g)=>n+g.observed,0),1);
});
test('valid checkpoint preserves greedy phase and replays only still pending outcomes',()=>{
 const first=anchored(),nextInput=input(B+10000);nextInput.snapshot.id='second';nextInput.reference.metadata.snapshotId='second';const second=makeInitialSpotCandidates(nextInput)[0];
 const next=advanceSpotCandidates(first.state,{now:B+10000,candidates:[second],quotes:quotes(B+10000)});
 const done=advanceSpotCandidates(next.state,{now:B+70000,quotes:quotes(B+70000,99,99.02)});
 const restored=recoverSpotCandidateState(next.state,[...first.records,...next.records,...done.records],B+80000);assert.equal(restored.pending.length,4);
 for(const p of restored.pending)assert.equal(p.nonOverlap,p.candidate.candidateId===first.c.candidateId);
});
test('valid incremental checkpoint skips settled oversized old history; invalid or absent state cannot',async t=>{
 const f=await fixture(t),now=B+10*86400000;await mkdir(f.dir,{recursive:true});
 const old=await open(f.journal,'w');try{await old.truncate(67108865);}finally{await old.close();}
 const statePath=join(f.dir,'state.json');await writeFile(statePath,JSON.stringify(newSpotCandidateState(now)));
 const good=await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},now);assert.equal(good.status,'observing');assert.equal(good.recoverySize.bytes,0);
 for(const field of ['seen','nonOverlap']){const bad=newSpotCandidateState(now);bad[field]=true;assert.throws(()=>validateSpotCandidateState(bad,now),/STATE_INVALID/);await writeFile(statePath,JSON.stringify(bad));const result=await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},now);assert.equal(result.reason,'CANDIDATE_STATE_INVALID');}
 await rm(statePath);const absent=await createSpotCandidateStore(f.local)({mode:'demo',markets:{}},now);assert.equal(absent.reason,'CANDIDATE_JOURNAL_CAPACITY');
});
test('a sampler tick older than queued candidate defers it rather than dropping it',async t=>{
 const f=await fixture(t);enqueueInitialSpotCandidates(f.local,input());const record=createSpotCandidateStore(f.local);
 assert.equal((await record(sample(B+1000),B+1000)).recordsThisSample,0);
 const next=await record(sample(B+3000),B+3000);assert.equal(next.recordsThisSample,2);assert.equal(next.pending,3);
});
test('streaming review deduplicates a fully settled target candidate and rejects contradictory duplicate',()=>{
 const first=mature(),done=advanceSpotCandidates(first.state,{now:B+1000000,quotes:[]}),rows=[...first.records,...done.records];
 const audit=createSpotCandidateReviewAccumulator({createdFrom:B,createdBefore:B+86400000});for(const r of [...rows,...rows])audit.consume(r);assert.equal(audit.finish().unresolvedHorizons,0);assert.equal(audit.finish().cohorts.reduce((n,c)=>n+c.observed,0),1);
 const bad=structuredClone(rows.at(-1));bad.rawQuoteMarkoutBps='0';assert.throws(()=>audit.consume(bad),/JOURNAL_INVALID/);
});
