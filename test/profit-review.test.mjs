import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {profitObservationBatch,newProfitObservations,buildProfitReview} from '../src/profit-review.mjs';
import {refreshProfitReview} from '../src/profit-review-store.mjs';

const base=Date.parse('2026-09-10T12:00:00Z'),iso=seconds=>new Date(base+seconds*1000).toISOString();
const tag=n=>'codex-'+String(n).padStart(32,'0');
function input(net='1',isOpen=true,seconds=60,extra={}){
 const trade={trade_id:1,enter_tag:tag(1),pair:'SOL/USDT:USDT',is_open:isOpen,profit_abs:net,
  fee_open_cost:'0.06',fee_close_cost:isOpen?null:'0.06',exit_reason:isOpen?null:'rules_target',...extra};
 const evidence={tradeId:trade.trade_id,tag:trade.enter_tag,pair:trade.pair,isOpen:trade.is_open,openedAt:iso(0),closedAt:isOpen?null:iso(seconds)};
 return {report:{asOf:iso(seconds),mode:'demo-futures',validation:{evidenceComplete:true},strategy:{trades:[evidence]},probes:{trades:[]}},trades:[trade]};
}
const observed=args=>profitObservationBatch(args);

test('actual open observations reveal giveback after a losing close without rewriting realized PnL',()=>{
 const first=input('1',true,60),second=input('2',true,120),closed=input('-.5',false,180);
 const observations=[...observed(first),...observed(second),...observed(closed)];
 const row=buildProfitReview({...closed,observations}).strategy.trades[0];
 assert.equal(row.netRealizedUsdt,'-0.5');assert.equal(row.netUnrealizedUsdt,null);
 assert.equal(row.sampledPeakNetUsdt,'2');assert.equal(row.sampledGivebackUsdt,'2.5');
 assert.equal(row.realizedToSampledPeakRatio,-.25);assert.equal(row.engineRecordedFeesUsdt,'0.12');
 assert.equal(row.openPnlSamples,2);assert.equal(row.firstObservationDelaySeconds,60);
 assert.equal(row.maxObservationGapSeconds,60);assert.equal(row.sampledPeakObservedAt,iso(120));
});

test('unobserved peak remains missing, including when engine min/max prices exist',()=>{
 const closed=input('1',false,180,{min_rate:1,max_rate:999999});
 const row=buildProfitReview({...closed,observations:observed(closed)}).strategy.trades[0];
 assert.equal(row.netRealizedUsdt,'1');assert.equal(row.sampledPeakNetUsdt,null);
 assert.equal(row.sampledGivebackUsdt,null);assert.equal(row.realizedToSampledPeakRatio,null);
 assert.equal(row.openPnlSamples,0);
});

test('closed accounting corrections persist once, repeated refreshes cannot inflate samples',()=>{
 const first=observed(input('1',false,60));
 assert.deepEqual(newProfitObservations(first,observed(input('1',false,120)),'demo-futures'),[]);
 const correction=newProfitObservations(first,observed(input('.9',false,180)),'demo-futures');
 assert.equal(correction.length,1);assert.equal(correction[0].netUsdt,'0.9');
 assert.throws(()=>newProfitObservations(first,observed(input('1',true,120)),'demo-futures'),/REOPENED/);
 assert.throws(()=>newProfitObservations(first,observed(input('2',false,60)),'demo-futures'),/CONFLICT/);
});

test('unknown fees stay null and are never deducted again; nonpositive peaks have no retention ratio',()=>{
 const args=input('-.1',false,120,{fee_open_cost:null});
 const review=buildProfitReview({...args,observations:observed(input('-.2',true,60))});
 assert.equal(review.strategy.trades[0].engineRecordedFeesUsdt,null);
 assert.equal(review.strategy.trades[0].sampledGivebackUsdt,null);
 assert.equal(review.strategy.trades[0].realizedToSampledPeakRatio,null);
 assert.equal(review.strategy.byExitReason[0].netRealizedUsdt,'-0.1');
 assert.equal(review.strategy.byExitReason[0].engineRecordedFeesUsdt,null);
});

test('profitable probe cannot inflate strategy exit statistics or peaks; exact identity survives reused IDs',()=>{
 const args=input('-1',false,180),probe=input('100',false,180,{trade_id:2,enter_tag:tag(2)});
 args.report.probes=probe.report.strategy;args.trades.push(...probe.trades);
 const wrongId=observed(input('1000',true,60,{enter_tag:tag(3)}));
 const review=buildProfitReview({...args,observations:[...wrongId,...observed(args)]});
 assert.equal(review.strategy.byExitReason[0].netRealizedUsdt,'-1');
 assert.equal(review.probes.byExitReason[0].netRealizedUsdt,'100');
 assert.equal(review.strategy.trades[0].sampledPeakNetUsdt,null);
});

test('incomplete evidence and invalid numbers cannot become positive observations',()=>{
 const args=input('1');args.report.validation.evidenceComplete=false;
 assert.deepEqual(observed(args),[]);assert.equal(buildProfitReview(args).strategy,null);
 for(const value of [null,undefined,'',NaN,Infinity,'1e999',true])assert.equal(observed(input(value,true,60,{profit_abs:value})).length,0);
 const duplicate=input('1');duplicate.trades.push({...duplicate.trades[0]});
 assert.throws(()=>observed(duplicate),/AMBIGUOUS/);
});

test('future, foreign-mode, malformed and out-of-order observations fail without inventing history',()=>{
 const args=input('1',true,120),valid=observed(args)[0];
 for(const patch of [{mode:'demo'},{netUsdt:null},{tag:'manual'},{pair:'SOL/USDC:USDC'},{observedAt:iso(-1)}])
  assert.throws(()=>buildProfitReview({...args,observations:[{...valid,...patch}]}),/INVALID/);
 assert.throws(()=>buildProfitReview({...args,observations:[valid,...observed(input('2',true,60))]}),/TIME_INVALID/);
 const future=observed(input('999',true,180));
 assert.equal(buildProfitReview({...args,observations:future}).strategy.trades[0].sampledPeakNetUsdt,null);
});

test('append-only observations survive fresh store calls and a torn file is never overwritten',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-profit-review-'));
 await refreshProfitReview(local,input('2',true,60));
 await refreshProfitReview(local,input('.5',false,120));
 const closed=await refreshProfitReview(local,input('.5',false,180));
 assert.equal(closed.strategy.trades[0].sampledGivebackUsdt,'1.5');
 const file=join(local,'profit-observations.jsonl'),data=await readFile(file,'utf8');
 assert.equal(data.trim().split('\n').length,2);
 await writeFile(file,data+'{"partial":');
 await assert.rejects(refreshProfitReview(local,input('.5',false,240)),/INCOMPLETE/);
 assert.equal(await readFile(file,'utf8'),data+'{"partial":');
});
