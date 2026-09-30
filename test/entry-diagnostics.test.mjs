import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,utimes,writeFile } from 'node:fs/promises';
import { join,dirname,basename,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJson } from '../src/io.mjs';
import { buildEntryDiagnostics,readEntryDiagnostics,createEntryDiagnosticsReader } from '../src/entry-diagnostics.mjs';
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
 const options={mode:'demo',ruleVersion:version,now,allowance:{remaining:2},refreshMs:0};
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

function replayFilesystem(){
 const files=new Map(),reads=new Map();let directoriesRead=0,tick=0;
 const put=(file,value,mtimeMs=1)=>{const text=JSON.stringify(value);files.set(file,{text,mtimeMs,size:text.length});};
 const putRun=(local,row)=>{for(const suffix of ['snapshot','rules','outcome'])put(join(local,'runs',row.snapshot.id+'.'+suffix+'.json'),row[suffix]);};
 const missing=()=>Object.assign(Error('ENOENT'),{code:'ENOENT'});
 const reader=createEntryDiagnosticsReader({
  readDirectory:async dir=>{directoriesRead++;return [...files.keys()].filter(file=>dirname(file)===dir).map(file=>basename(file));},
  fileStat:async file=>{const value=files.get(file);if(!value)throw missing();return value;},
  readDocument:async file=>{reads.set(file,(reads.get(file)??0)+1);const value=files.get(file);if(!value)throw missing();return JSON.parse(value.text);},
  clock:()=>tick,
 });
 return {files,reads,put,putRun,reader,get directoriesRead(){return directoriesRead;},advance:ms=>{tick+=ms;},
  snapshotReads:()=>[...reads].filter(([file])=>file.endsWith('.snapshot.json')).reduce((sum,[,n])=>sum+n,0)};
}

test('more than 4096 snapshots per mode retain compact inventory across repeated full sweeps',async()=>{
 const fs=replayFilesystem(),spot=resolve('diagnostics-replay-spot'),futures=resolve('diagnostics-replay-futures');
 for(const [local,mode]of [[spot,'demo'],[futures,'demo-futures']]){
  for(let i=0;i<4100;i++)fs.put(join(local,'runs',i+'.snapshot.json'),{id:String(i),mode,ruleVersion:version,createdAt:iso(86400001),markets:[],rawLargeEvidence:'not retained'});
  const latest=run(mode);latest.snapshot.mode=mode;latest.outcome.mode=mode;fs.putRun(local,latest);
 }
 const options={ruleVersion:version,now,refreshMs:0};
 for(const [local,mode]of [[spot,'demo'],[futures,'demo-futures']])assert.equal((await fs.reader(local,{...options,mode})).latest.snapshotId,mode);
 assert.equal(fs.snapshotReads(),8202);
 for(const [local,mode]of [[spot,'demo'],[futures,'demo-futures']]){
  const report=await fs.reader(local,{...options,mode});
  assert.equal(report.cycles.total,1);assert.equal(report.exclusions.outsideWindow,4100);
  assert.ok(!JSON.stringify(report).includes('rawLargeEvidence'));
 }
 assert.equal(fs.snapshotReads(),8202,'second sweeps must not parse the same historical snapshots again');
 assert.equal(fs.directoriesRead,4,'actual directory inventory is checked on each uncached sweep');
});

test('cached scopes preserve asOf and independently select local, mode, rule version and since',async()=>{
 const fs=replayFilesystem(),local=resolve('diagnostics-replay-scopes'),other=resolve('diagnostics-replay-other');
 const first=run('spot',2000),future=run('futures',1000),different=run('other-version',500);
 future.snapshot.mode='demo-futures';future.outcome.mode='demo-futures';
 different.snapshot.ruleVersion='other';different.rules.metadata.ruleVersion='other';different.rules.candidates=[];
 for(const row of [first,future,different])fs.putRun(local,row);
 const options={mode:'demo',ruleVersion:version,now};
 const original=await fs.reader(local,options),reads=fs.directoriesRead;
 original.cycles.total=999;
 const cached=await fs.reader(local,{...options,now:now+1000,allowance:{remaining:4}});
 assert.equal(cached.asOf,iso(0));assert.equal(cached.cycles.total,1);assert.equal(cached.allowance.remaining,4);
 assert.equal(fs.directoriesRead,reads,'UI refresh within cache interval starts no full sweep');
 assert.equal((await fs.reader(local,{...options,mode:'demo-futures'})).latest.snapshotId,'futures');
 assert.equal((await fs.reader(local,{...options,ruleVersion:'other'})).latest.snapshotId,'other-version');
 assert.equal((await fs.reader(local,{...options,since:iso(1500)})).cycles.total,0);
 assert.equal((await fs.reader(other,options)).cycles.total,0);
 fs.advance(30001);
 assert.equal((await fs.reader(local,{...options,now:now+30001})).asOf,new Date(now+30001).toISOString());
});

test('inventory invalidates mtime, size and deleted/recreated snapshots without changing time selection',async()=>{
 const fs=replayFilesystem(),local=resolve('diagnostics-replay-edits'),row=run('mutable'),file=join(local,'runs','mutable.snapshot.json');
 fs.putRun(local,row);const options={mode:'demo',ruleVersion:version,now,refreshMs:0};
 assert.equal((await fs.reader(local,options)).cycles.total,1);
 row.snapshot.createdAt=iso(86400001);fs.put(file,row.snapshot,2);
 assert.equal((await fs.reader(local,options)).cycles.total,0);
 row.snapshot.createdAt=iso(1000);row.snapshot.unused='size changes even if timestamp did not';fs.put(file,row.snapshot,2);
 assert.equal((await fs.reader(local,options)).cycles.total,1);assert.equal(fs.snapshotReads(),3);
 const retained=fs.files.get(file);fs.files.delete(file);
 assert.equal((await fs.reader(local,options)).cycles.total,0);
 fs.files.set(file,retained);
 assert.equal((await fs.reader(local,options)).cycles.total,1);assert.equal(fs.snapshotReads(),4,'removed file must not retain an old cache entry');
});

test('bounded readers share one background scan, isolate scopes and consume background rejection',async()=>{
 let release,reads=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const reader=createEntryDiagnosticsReader({readDirectory:async()=>{reads++;await pending;throw Object.assign(Error('EACCES'),{code:'EACCES'});}});
 const options={mode:'demo',ruleVersion:version,now,waitMs:5};
 await Promise.all(Array.from({length:4},()=>assert.rejects(reader('diagnostics-replay-slow',options),/DIAGNOSTICS_INDEX_WARMING/)));
 assert.equal(reads,1,'concurrent UI refreshes must not launch duplicate scans');
 await assert.rejects(reader('diagnostics-replay-slow',{...options,since:iso(1000)}),/DIAGNOSTICS_INDEX_WARMING/);
 assert.equal(reads,2,'new session scope has its own pending result, never an old report');
 release();await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(reader('diagnostics-replay-slow',options),/EACCES/);
 assert.equal(reads,2,'failed scans use the bounded refresh cadence too');
});

test('a pending scan cannot publish a future report to a clock-rollback caller',async()=>{
 let release,reads=0;const gate=new Promise(resolve=>{release=resolve;});
 const reader=createEntryDiagnosticsReader({readDirectory:async()=>{reads++;await gate;return [];}});
 const options={mode:'demo',ruleVersion:version,now};
 const first=reader('diagnostics-replay-clock',options);
 await assert.rejects(reader('diagnostics-replay-clock',{...options,now:now-1000}),/ENTRY_DIAGNOSTICS_OBSERVATION_TIME_REVERSED/);
 release();assert.equal((await first).asOf,iso(0));
 const earlier=await reader('diagnostics-replay-clock',{...options,now:now-1000});
 assert.equal(earlier.asOf,iso(1000));assert.equal(reads,2,'a completed future report must be rescanned for earlier observation time');
});
