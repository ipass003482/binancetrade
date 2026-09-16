import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJson,readJson } from '../src/io.mjs';
import { dashboardState,readProtectionView,readPortfolioView,readSupervisorView } from '../src/dashboard.mjs';
import { assertProtectionResumeAllowed } from '../src/cli.mjs';
import { fixture } from './fixtures.mjs';
import { DEMO_RULE_VERSION } from '../src/demo-rules.mjs';
import { RULE_ENGINE_VERSION } from '../src/decision.mjs';
const now=Date.parse('2026-09-10T12:00:00.000Z'),iso=age=>new Date(now-age).toISOString();
const temp=()=>mkdtemp(join(tmpdir(),'binance-dashboard-integration-'));
function protection(mode='demo'){
 const pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',side=mode==='demo'?'sell':'buy';
 const stop={pair,orderId:'12345',side,amount:0.01,stopPrice:2000,observedAt:iso(1000)};
 return {version:'demo-native-stop-v1',mode,engineVersion:RULE_ENGINE_VERSION,asOf:iso(1000),configured:true,unresolvedStops:0,
  activeStops:[stop],attempts:[{...stop,acceptedAmount:stop.amount,status:'confirmed',orderStatus:'open',secret:'DO_NOT_EXPOSE'}],
  capabilities:{[pair]:{status:'capability_validated',orderType:mode==='demo'?'STOP_LOSS_LIMIT':'STOP_MARKET',
   destination:mode==='demo'?'demo-api.binance.com':'demo-fapi.binance.com',reduceOnly:mode!=='demo',secret:'DO_NOT_EXPOSE'}},
  protectionEvidence:'actual_order_ack_required',secret:'DO_NOT_EXPOSE'};
}

test('dashboard reuses one account snapshot and exposes missing continuous watch separately',async()=>{
 const base=await temp(),local=join(base,'demo'),portfolioLocal=join(base,'portfolio'),supervisorLocal=join(base,'supervisor'),f=await fixture();
 const policy={...f.policy,mode:'demo',timeframe:'5m'};let reads=0;
 const snapshot={...f.account,engine:{strategy_version:RULE_ENGINE_VERSION,password:'DO_NOT_EXPOSE'}};
 const client={snapshot:async()=>{reads++;return snapshot;},history:async()=>[]};
 await writeJson(join(local,'continuous.json'),{enabled:true,updatedAt:iso(700000)});
 await writeJson(join(local,'health.json'),{lastSuccessAt:iso(1000),stage:'waiting_candle'});
 await writeJson(join(local,'runs','sample.snapshot.json'),{id:'sample',mode:'demo',ruleVersion:DEMO_RULE_VERSION,createdAt:iso(1000),markets:[]});
 await writeJson(join(local,'runs','sample.rules.json'),{metadata:{ruleVersion:DEMO_RULE_VERSION},candidates:[],proposal:{action:'hold'}});
 await writeJson(join(local,'runs','sample.outcome.json'),{mode:'demo',snapshotId:'sample',status:'completed',result:{status:'hold'}});
 await writeJson(join(local,'protection-readiness.json'),protection());
 await writeJson(join(portfolioLocal,'report.json'),{schemaVersion:1,source:'freqtrade-demo-portfolio',asOf:iso(1000),startedAt:iso(700000),
  capitalUsdt:'2000',evidenceComplete:true,netPnlUsdt:'-0.25',sampledMaxDrawdownUsdt:'0.25',sampleCount:2,
  exposure:{asOf:iso(1000),grossUsdt:'25',estimatedOpenRiskUsdt:'0.5',allocatedMarginUsdt:'25',secret:'DO_NOT_EXPOSE'},warnings:[],secret:'DO_NOT_EXPOSE'});
 await writeJson(join(supervisorLocal,'status.json'),{pid:process.pid,observedAt:iso(1000),states:[{mode:'demo',action:'observe',reason:'RUNNING',secret:'DO_NOT_EXPOSE'}],secret:'DO_NOT_EXPOSE'});
 const state=await dashboardState('demo',{local,policy,client,session:null,getTiming:async()=>null,
  getDecision:async()=>({demoEngine:'rules',ruleVersion:DEMO_RULE_VERSION}),now:()=>now,portfolioLocal,supervisorLocal,localFor:mode=>join(base,mode)});
 assert.equal(reads,1);assert.equal(state.operations.engineAvailable,true);assert.equal(state.operations.watchRunning,false);
 assert.equal(state.operations.healthy,false);assert.ok(state.operations.problems.includes('CONTINUOUS_WATCH_NOT_RUNNING'));
 assert.equal(state.diagnostics.cycles.hold,1);assert.equal(state.diagnostics.allowance.remaining,policy.maxEntriesPerDay);
 assert.equal(state.portfolio.netPnlUsdt,'-0.25');assert.equal(state.portfolio.grossExposureUsdt,'25');
 assert.equal(state.supervisor.running,true);assert.equal(state.protection[0].activeStops[0].orderId,'12345');
 assert.equal(state.protection[1].status,'unknown');
 assert.ok(!JSON.stringify(state).includes('DO_NOT_EXPOSE'));
});

test('protection state requires fresh matching order evidence; missing data is unknown, not zero',async()=>{
 const local=await temp(),file=join(local,'protection.json');
 assert.equal((await readProtectionView(file,'demo',{now})).activeStops,null);
 const raw=protection();await writeJson(file,raw);
 let view=await readProtectionView(file,'demo',{now});
 assert.equal(view.status,'active_order_observed');assert.equal(view.activeStops[0].amount,0.01);
 raw.activeStops[0].amount=0.02;await writeJson(file,raw);
 view=await readProtectionView(file,'demo',{now});assert.equal(view.status,'unknown');assert.equal(view.activeStops,null);
 raw.activeStops[0].amount=0.01;raw.asOf=iso(120001);await writeJson(file,raw);
 view=await readProtectionView(file,'demo',{now});assert.equal(view.status,'unknown');assert.equal(view.error,'DEMO_PROTECTION_STATE_STALE');
 raw.asOf=iso(1000);raw.activeStops[0].observedAt=iso(120001);await writeJson(file,raw);
 assert.equal((await readProtectionView(file,'demo',{now})).status,'unknown');
});

test('stale portfolio values are not presented as current net profit or exposure',async()=>{
 const file=join(await temp(),'report.json');
 await writeJson(file,{schemaVersion:1,source:'freqtrade-demo-portfolio',asOf:iso(180001),evidenceComplete:true,
  capitalUsdt:'2000',netPnlUsdt:'15',exposure:{grossUsdt:'25'}});
 const report=await readPortfolioView(file,{now});
 assert.equal(report.fresh,false);assert.equal(report.evidenceComplete,false);assert.equal(report.netPnlUsdt,null);
 assert.equal(report.grossExposureUsdt,null);assert.equal(report.capitalUsdt,'2000');
 assert.ok(report.warnings.some(w=>w.code==='PORTFOLIO_REPORT_STALE'));
});

test('stale supervisor receipt never establishes a running supervisor',async()=>{
 const file=join(await temp(),'status.json');
 await writeJson(file,{pid:42,observedAt:iso(45001),states:[{mode:'demo',action:'observe',reason:'RUNNING'}]});
 const report=await readSupervisorView(file,{now,state:()=> 'alive'});
 assert.equal(report.fresh,false);assert.equal(report.running,false);
});

test('resume refuses unresolved protection in either market without changing STOP',async()=>{
 const base=await temp(),localFor=mode=>join(base,mode),stop={reason:'protection review'};
 await writeJson(join(localFor('demo'),'STOP'),stop);
 await assertProtectionResumeAllowed('demo',{localFor}); // Missing readiness is allowed, never labelled protected.
 const raw=protection('demo-futures');raw.unresolvedStops=0;raw.attempts.push({status:'unknown'});
 await writeJson(join(localFor('demo-futures'),'protection-readiness.json'),raw);
 await assert.rejects(assertProtectionResumeAllowed('demo',{localFor}),/DEMO_PROTECTION_UNRESOLVED/);
 assert.deepEqual(await readJson(join(localFor('demo'),'STOP')),stop);
 raw.attempts.pop();raw.unresolvedStops=1;await writeJson(join(localFor('demo-futures'),'protection-readiness.json'),raw);
 await assert.rejects(assertProtectionResumeAllowed('demo',{localFor}),/DEMO_PROTECTION_UNRESOLVED/);
 raw.unresolvedStops=0;await writeJson(join(localFor('demo-futures'),'protection-readiness.json'),raw);
 await assertProtectionResumeAllowed('demo',{localFor});
});

test('session dashboard hides old artifact aggregates and uses snapshot time for decision and diagnostic scope',async()=>{
 const base=await temp(),local=join(base,'demo'),portfolioLocal=join(base,'portfolio'),supervisorLocal=join(base,'supervisor'),f=await fixture();
 const session={schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',startedAt:iso(60000),modes:['demo','demo-futures']};
 const client={snapshot:async()=>f.account,history:async()=>[]};
 for(const [name,age]of [['old',60001],['new',50000]]){
  await writeJson(join(local,'runs',name+'.snapshot.json'),{id:name,mode:'demo',ruleVersion:DEMO_RULE_VERSION,createdAt:iso(age),markets:[]});
  await writeJson(join(local,'runs',name+'.proposal.json'),{snapshotId:name,action:'hold',pair:'ETH/USDT',reason:name});
  await writeJson(join(local,'runs',name+'.rules.json'),{metadata:{ruleVersion:DEMO_RULE_VERSION},candidates:[],proposal:{action:'hold'}});
  await writeJson(join(local,'runs',name+'.outcome.json'),{mode:'demo',snapshotId:name,status:'completed',result:{status:'hold'}});
 }
 await writeJson(join(local,'equity-summary.json'),{firstObservedAt:iso(60001),observedAt:iso(1000),changeSinceFirstUsdt:'100'});
 await writeJson(join(local,'forward-report.json'),{startedAt:iso(60001),asOf:iso(1000),netRealizedUsdt:'100'});
 await writeJson(join(portfolioLocal,'report.json'),{schemaVersion:1,source:'freqtrade-demo-portfolio',startedAt:iso(60001),asOf:iso(1000),evidenceComplete:true,netPnlUsdt:'100'});
 const args={session,local,policy:{...f.policy,mode:'demo'},client,getTiming:async()=>null,getDecision:async()=>({ruleVersion:DEMO_RULE_VERSION}),now:()=>now,portfolioLocal,supervisorLocal,localFor:mode=>join(base,mode)};
 const d=await dashboardState('demo',args);assert.deepEqual(d.session,session);assert.equal(d.equity,null);assert.equal(d.forward,null);assert.equal(d.portfolio,null);
 assert.deepEqual(d.decisions.map(x=>x.reason),['new']);assert.equal(d.decisions[0].at,iso(50000));
 assert.equal(d.diagnostics.cycles.total,1);assert.equal(d.diagnostics.window.from,session.startedAt);
 assert.equal(d.artifactErrors.filter(x=>x.code==='ARTIFACT_OUTSIDE_DEMO_SESSION').length,3);
 await writeJson(join(local,'forward-report.json'),{startedAt:session.startedAt,netRealizedUsdt:'-.4'});
 assert.equal((await dashboardState('demo',args)).forward.netRealizedUsdt,'-.4');
});
