import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,utimes,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJson } from '../src/io.mjs';
import { buildEntryDiagnostics,readEntryDiagnostics } from '../src/entry-diagnostics.mjs';
const now=Date.parse('2026-09-10T12:00:00.000Z'),version='atr15m-forward-v6';
const iso=age=>new Date(now-age).toISOString();
function run(id,age=1000){
 return {snapshot:{id,mode:'demo',ruleVersion:version,createdAt:iso(age),markets:[{pair:'ETH/USDT',
  entryCost:{status:'ok',estimatedRoundTripCostBps:'22.5',requiredPriceSpaceBps:'52.5'}}]},
  rules:{metadata:{ruleVersion:version},proposal:{action:'hold'},candidates:[{
   pair:'ETH/USDT',version,action:'hold',stakeUsdt:'0',reasons:['ENTRY_DIRECTION_NOT_ALIGNED'],
   directionChecks:[{action:'buy',eligible:false,reasons:['ENTRY_DIRECTION_NOT_ALIGNED','BASELINE_BUFFERED_BREAKOUT_REQUIRED'],
    metrics:{lastClose:'100',sma8:'101',sma20:'102',return1hPct:'-0.02',return4hPct:'0.01',volumeVsPrior19:null},
    breakout:{trigger:102,close:100},costSpace:{targetBps:65,requiredBps:52.5}}]}]},
  outcome:{mode:'demo',snapshotId:id,status:'completed',result:{status:'hold'}}};
}
const build=runs=>buildEntryDiagnostics({mode:'demo',ruleVersion:version,runs,asOf:now});

test('cycle funnel separates sizing, selection and submission without counting fills or duplicate pairs',()=>{
 const undersized=run('small'),capacity=run('capacity',2000),riskWait=run('risk',3000),sent=run('sent',4000);
 for(const row of [undersized,capacity,riskWait,sent])row.rules.candidates[0].directionChecks[0].eligible=true;
 undersized.rules.candidates[0].sizingReason='DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM';
 for(const row of [capacity,riskWait,sent])row.rules.candidates[0].action='buy';
 for(const row of [riskWait,sent])row.rules.proposal.action='buy';
 riskWait.outcome={...riskWait.outcome,status:'waiting',reason:'PORTFOLIO_OPEN_RISK_LIMIT'};
 sent.outcome.result.status='submitted';
 sent.rules.candidates.push(structuredClone(sent.rules.candidates[0]));
 const report=build([undersized,capacity,riskWait,sent]);
 assert.deepEqual(report.funnel,{observedCycles:4,withCandidates:4,signalAndCostPassed:4,sizePassed:3,
  entryProposed:2,eligibleWithoutProposal:1,submitted:1});
 assert.equal(report.candidates.total,4);
 assert.equal(report.cycles.waiting,1);
 assert.equal(report.funnel.fills,undefined);
});

test('signal reasons count once per pair per cycle across repeated long and short checks',()=>{
 const first=run('a'),second=run('b',2000);
 first.rules.candidates[0].directionChecks.push({...first.rules.candidates[0].directionChecks[0],action:'open-short'});
 const report=build([first,second]);
 assert.deepEqual(report.cycles,{total:2,completed:2,waiting:0,failed:0,aborted:0,incomplete:0,submitted:0,hold:2,filtered:0});
 assert.deepEqual(report.candidates,{total:2,eligible:0,blocked:2});
 assert.deepEqual(report.signalReasons,[{reason:'BASELINE_BUFFERED_BREAKOUT_REQUIRED',count:2},{reason:'ENTRY_DIRECTION_NOT_ALIGNED',count:2}]);
 assert.equal(report.latest.pairs[0].directionChecks.length,2);
 assert.equal(report.latest.pairs[0].metrics.volumeVsPrior19,null);
 assert.equal(report.latest.pairs[0].cost.estimatedRoundTripCostBps,'22.5');
 assert.equal(report.latest.pairs[0].trigger,102);
});

test('global waits remain separate from passed signals and actual failed cycles',()=>{
 const waiting=run('wait'),failed=run('fault',2000),incomplete=run('incomplete',3000);
 waiting.rules.candidates[0].action='buy';waiting.rules.candidates[0].directionChecks[0].eligible=true;
 waiting.outcome={...waiting.outcome,status:'waiting',reason:'ENTRY_RATE_LIMIT',resetAt:'2026-09-11T00:00:00.000Z'};
 failed.outcome={...failed.outcome,status:'failed',code:'UNRESOLVED_SUBMISSION'};
 delete incomplete.outcome;
 const report=build([incomplete,failed,waiting]);
 assert.equal(report.cycles.waiting,1);assert.equal(report.cycles.failed,1);assert.equal(report.cycles.incomplete,1);
 assert.equal(report.cycles.hold,0);assert.equal(report.cycles.completed,0);
 assert.equal(report.candidates.eligible,1);
 assert.deepEqual(report.globalWaitReasons,[{reason:'ENTRY_RATE_LIMIT',count:1,resetAt:'2026-09-11T00:00:00.000Z',reviewRequired:false}]);
 assert.deepEqual(report.faultReasons,[{reason:'UNRESOLVED_SUBMISSION',count:1}]);
 assert.equal(report.latest.status,'waiting');assert.equal(report.latest.globalWait.reason,'ENTRY_RATE_LIMIT');
 assert.equal(report.latest.pairs[0].eligible,true);
});

test('latest/current-version statistics exclude probes, older versions, wrong mode and timestamps',()=>{
 const valid=run('valid'),probe=run('probe',500),oldVersion=run('old',400),wrongMode=run('futures',300),old=run('yesterday',86400001),future=run('future',-1);
 probe.snapshot.purpose='execution_probe';oldVersion.rules.metadata.ruleVersion='old-version';wrongMode.snapshot.mode='demo-futures';
 const report=build([valid,probe,oldVersion,wrongMode,old,future,structuredClone(valid)]);
 assert.equal(report.cycles.total,1);assert.equal(report.latest.snapshotId,'valid');
 assert.deepEqual(report.exclusions,{outsideWindow:2,versionMismatch:1,modeMismatch:1,probe:1,invalid:0,duplicate:1,limited:0});
});

test('bounded report selects the latest 288 by snapshot time regardless of input order',()=>{
 const rows=Array.from({length:300},(_,i)=>run('run-'+i,i*1000));
 const report=build(rows.reverse());
 assert.equal(report.cycles.total,288);assert.equal(report.latest.snapshotId,'run-0');assert.equal(report.exclusions.limited,12);
});

test('failure before candidate generation retains version attribution and missing indicators stay null',()=>{
 const failed=run('failed');delete failed.rules;
 failed.outcome={...failed.outcome,status:'failed',code:'STRATEGY_CHANGED_DURING_CYCLE'};
 const report=build([failed]);
 assert.equal(report.cycles.failed,1);assert.equal(report.candidates.total,0);
 assert.equal(report.latest.fault,'STRATEGY_CHANGED_DURING_CYCLE');
 assert.deepEqual(report.warnings,[{code:'CYCLE_CANDIDATES_UNAVAILABLE',snapshotId:'failed'}]);
 assert.throws(()=>buildEntryDiagnostics({mode:'demo',ruleVersion:version,runs:[],asOf:'invalid'}),/INPUT_INVALID/);
});

test('reader uses snapshot timestamps instead of mtime and refreshes compact cache after edits',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-entry-diagnostics-')),dir=join(local,'runs');
 const fresh=run('fresh'),old=run('old',86400001);
 for(const row of [fresh,old])for(const suffix of ['snapshot','rules','outcome'])await writeJson(join(dir,row.snapshot.id+'.'+suffix+'.json'),row[suffix]);
 await utimes(join(dir,'fresh.snapshot.json'),new Date(0),new Date(0));
 const options={mode:'demo',ruleVersion:version,now,allowance:{remaining:2}};
 let report=await readEntryDiagnostics(local,options);
 assert.equal(report.cycles.total,1);assert.equal(report.latest.snapshotId,'fresh');assert.equal(report.allowance.remaining,2);
 fresh.snapshot.createdAt=iso(86400001);await writeJson(join(dir,'fresh.snapshot.json'),fresh.snapshot);
 report=await readEntryDiagnostics(local,options);assert.equal(report.cycles.total,0);
});

test('corrupt outcome is reported as missing evidence instead of a successful HOLD',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-entry-diagnostics-')),dir=join(local,'runs'),row=run('broken');
 await writeJson(join(dir,'broken.snapshot.json'),row.snapshot);await writeJson(join(dir,'broken.rules.json'),row.rules);
 await writeFile(join(dir,'broken.outcome.json'),'{bad');
 const report=await readEntryDiagnostics(local,{mode:'demo',ruleVersion:version,now});
 assert.equal(report.cycles.incomplete,1);assert.equal(report.cycles.hold,0);
 assert.ok(report.warnings.some(warning=>warning.code==='DIAGNOSTICS_FILE_UNREADABLE'));
});
