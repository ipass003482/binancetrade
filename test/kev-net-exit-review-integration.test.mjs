import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNetExitReview} from '../scripts/kev-net-exit-review.mjs';
import {KEV_NET_HARVEST_POLICY} from '../src/kev-exit-policy.mjs';

const start=Date.parse('2026-09-21T06:00:00Z'),fingerprint='a'.repeat(64),prediction='b'.repeat(64);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const snapshotId=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
function fixture(specs=[{}]){
 const observedAt='2026-09-22T03:00:00Z',goal={schemaVersion:2,id:'loss-test',source:'freqtrade-demo',startedAt:new Date(start).toISOString(),
  deadline:new Date(start+86400000).toISOString(),timezone:'Asia/Taipei',target:{scope:'combined',count:100},
  ruleVersion:'kronos-direction-v12',entryPolicyVersion:'forecast-net-edge-v1',modelFingerprint:fingerprint,
  kevEntry:{required:true,version:'kev-codex-entry-v1',provider:'codex-cli',model:'test-model'},
  modes:Object.fromEntries(['demo','demo-futures'].map(m=>[m,{excludedTradeIds:[],baselineTradeCount:0}]))};
 const histories=Object.fromEntries(['demo','demo-futures'].map(m=>[m,{source:'freqtrade-demo',historyComplete:true,trades:[],observedAt}])),
  journals={demo:[],'demo-futures':[]},artifacts={demo:{},'demo-futures':{}};
 for(const [index,spec] of specs.entries()){
  const n=index+1,mode=spec.mode??'demo',pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',short=spec.short??false,
   snapshot=snapshotId(n),id=createHash('sha256').update(snapshot).digest('hex').slice(0,32),tag='codex-'+id,
   opened=start+n*60000,action=mode==='demo'?'buy':short?'open-short':'open-long',openRate=100,closeRate=spec.closeRate??101,
   amount=spec.amount??2,entryAmount=spec.entryAmount??amount,feeOpen=spec.feeOpen??.001,feeClose=spec.feeClose??.001,funding=spec.funding??0,
   profit=spec.net??(amount*(closeRate-openRate)*(short?-1:1)-amount*openRate*feeOpen-amount*closeRate*feeClose+funding);
  const order=(entry,quantity,price)=>({order_id:(entry?'entry':'exit')+n,pair,ft_order_tag:entry?tag:null,
   ft_order_side:entry?(short?'sell':'buy'):(short?'buy':'sell'),ft_is_entry:entry,status:'closed',is_open:false,
   filled:quantity,cost:quantity*price,amount:quantity,remaining:0,average:price,order_filled_timestamp:opened+(entry?-500:900000)});
  const trade={trade_id:n,pair,enter_tag:tag,is_open:spec.open??false,is_short:short,open_timestamp:opened,
   close_timestamp:spec.open?null:opened+900000,profit_abs:profit,stake_amount:entryAmount*openRate,leverage:1,trading_mode:mode==='demo'?'spot':'futures',
   amount,open_rate:openRate,close_rate:spec.open?null:closeRate,fee_open:feeOpen,fee_close:feeClose,funding_fees:funding,exit_reason:spec.exit??'rules_time',
   orders:[order(true,entryAmount,openRate),...(spec.open?[]:[order(false,amount,closeRate)])]};
  const rawSnapshot={id:snapshot,mode,observedAt:new Date(opened-3000).toISOString()};
  const decision={pair,action,approved:true,choice:spec.flow?'select':'approve',probabilities:spec.flow?{q0:.7,hold:.3}:{approve:.7,hold:.3}};
  const reviewBody={version:'kev-codex-entry-v1',enabled:true,invoked:true,status:'reviewed',mode,snapshotId:snapshot,
   actualModel:'test-model',requestId:'request-'+n,snapshotSha256:digest(rawSnapshot),configSha256:'c'.repeat(64),
   startedAt:new Date(opened-2500).toISOString(),completedAt:new Date(opened-1500).toISOString(),expiresAt:new Date(opened+30000).toISOString(),decisions:[decision],
   request:{model:'kev-codex',state:{mode,snapshotId:snapshot,candidates:[{id:'q0',pair,action}]}},
   response:{model:'kev-codex',request_id:'request-'+n,created_at:new Date(opened-1500).toISOString(),
    backend:{name:'codex-cli',actual_model:'test-model',weights_loaded:false,probabilities_calibrated:false,cli_calls:1},
    answers:{[spec.flow?'entry':'q0']:{type:'choice',choice:spec.flow?'q0':'approve',probabilities:decision.probabilities}}},
   ...(spec.flow?{decisionMode:'autonomous',selection:{choice:'q0',probabilities:decision.probabilities}}:{})};
  const review={...reviewBody,proofSha256:digest(reviewBody)},reviewRaw=JSON.stringify(review,null,2);
  const receipt={version:review.version,provider:'codex-cli',model:review.actualModel,requestId:review.requestId,snapshotId:snapshot,
   snapshotSha256:review.snapshotSha256,proofSha256:review.proofSha256,completedAt:review.completedAt,expiresAt:review.expiresAt,
   decision,probabilitiesCalibrated:false,...(spec.flow?{decisionMode:'autonomous',configSha256:review.configSha256,selection:review.selection}:{})};
  const pending={id,at:new Date(opened-1000).toISOString(),status:'pending',action,pair,tag,tradeId:null,purpose:'strategy',snapshotId:snapshot,
   ruleVersion:spec.flow?'kev-order-flow-v1':'kronos-direction-v12',entryPolicyVersion:spec.flow?'kev-order-flow-v1':'forecast-net-edge-v1',
   strategyFingerprint:spec.fingerprint??'d'.repeat(64),
   model:spec.flow?null:{modelFingerprint:fingerprint,predictionSha256:prediction,snapshotId:snapshot,issuedAt:new Date(opened-2000).toISOString(),usedForEntryDecision:true},
   entryEvidence:{version:spec.flow?'kev-order-flow-evidence-v1':'kronos-ai-evidence-v1',snapshotId:snapshot,usedForEntryDecision:true,proofSha256:'e'.repeat(64),kevReview:receipt},
   ...(spec.flow?{entrySignalEngine:'kev_order_flow',riskPolicy:{version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'}}:{})};
  const plan={tag,pair,snapshotId:snapshot,entryEvidence:pending.entryEvidence,
   ...(spec.flow?{nativeEntryGuard:{kevReviewSha256:createHash('sha256').update(reviewRaw).digest('hex')}}:{})};
  artifacts[mode][id]={reviewRaw,snapshotRaw:JSON.stringify(rawSnapshot),planRaw:JSON.stringify(plan)};
  histories[mode].trades.push(trade);journals[mode].push(pending,{id,at:new Date(opened+1000).toISOString(),status:'submitted',action,tradeId:n,pair,tag});
 }
 const amendment=specs.some(s=>s.flow)?{schemaVersion:1,goalId:goal.id,goalSha256:createHash('sha256').update(JSON.stringify(goal)).digest('hex'),
  entryPolicyVersion:'kev-order-flow-v1',ruleVersion:'kev-order-flow-v1',effectiveAt:new Date(start+1000).toISOString()}:null;
 return {goal,amendment,histories,journals,artifacts,observedAt};
}

// Original approval, journal, immutable-review hash and filled-order linkage
// are exercised by buildKevLossReview inside the runner; replay alone is stubbed.
function fixedExitFixture(specs=[{flow:true},{flow:true,mode:'demo-futures'}]){
 const input=fixture(specs);
 for(const mode of ['demo','demo-futures'])for(const trade of input.histories[mode].trades){
  const artifact=input.artifacts[mode][trade.enter_tag.slice(6)],plan=JSON.parse(artifact.planRaw);
  Object.assign(plan,{ruleVersion:'kev-order-flow-v1',purpose:'strategy',timeframe:'order-flow',isShort:trade.is_short,
   entryPolicyVersion:'kev-order-flow-v1',entrySignalEngine:'kev_order_flow',stopFraction:.005,targetFraction:.015,
   maxHoldingSeconds:900,maxHoldingBars:0,riskBudgetUsdt:1,
   profitProtection:{version:'net-profit-trail-v1',triggerNetUsdt:.5,givebackNetUsdt:.25,riskMultiple:.5}});
  artifact.planRaw=JSON.stringify(plan);
 }
 return input;
}
function comparison(){return {status:'indicative_comparison',results:['baseline','staged'].map(policy=>({policy,
 status:'indicative_displayed_depth_simulation',exit:{at:start+1000000,netUsdt:policy==='baseline'?'-0.1':'0.05',reason:'rules_time'}}))};}
const archives=()=>({demo:{files:[]},'demo-futures':{files:[]}});
function mutatePlan(input,mutate){const id=Object.keys(input.artifacts.demo)[0],a=input.artifacts.demo[id],p=JSON.parse(a.planRaw);mutate(p);a.planRaw=JSON.stringify(p);}

test('runner verifies original approvals and exact fixed plans before common-cohort replay without changing actual outcomes',()=>{
 const input=fixedExitFixture(),before=JSON.stringify(input),calls=[];
 const report=buildNetExitReview({input,archives:archives(),replay:args=>{calls.push(args);return comparison();}});
 assert.equal(JSON.stringify(input),before);assert.equal(report.actual.evidenceComplete,true);assert.equal(report.actual.totalEntries,2);
 assert.equal(report.results.length,2);assert.deepEqual(report.excluded,[]);assert.equal(calls.length,6);
 assert.ok(report.results.every(row=>row.originalKevApprovalVerified===true));
 assert.equal(report.comparisonSummary.submittedTrades,2);assert.equal(report.comparisonSummary.matchedTrades,2);
 assert.equal(report.comparisonSummary.completeForSubmittedTrades,true);assert.equal(report.comparisonSummary.completeForActiveGoal,true);
 assert.equal(report.comparisonSummary.summaries.find(row=>row.mode==='combined'&&row.adverseSlippageBps==='0').stagedMinusBaselineNetUsdt,'0.3');
 assert.equal(report.results[0].actualNetUsdt,'1.598');assert.equal(report.actual.summary.netRealizedUsdt,'3.196');
 assert.equal(report.executionChanged,false);assert.equal(report.promotionAuthorized,false);assert.equal(report.activation.status,'not_promoted');
});

test('archive read failures stay in the approved comparable cohort denominator and cannot report complete coverage',()=>{
 for(const error of ['QUOTE_ARCHIVE_MISSING','QUOTE_ARCHIVE_READ_FAILED','ARCHIVE_READ_BUDGET_EXCEEDED']){
  const input=fixedExitFixture(),source=archives();source['demo-futures']={files:[],error};let calls=0;
  const report=buildNetExitReview({input,archives:source,replay:()=>{calls++;return comparison();}});
  assert.equal(report.actual.totalEntries,2,error);assert.equal(calls,3,error);
  assert.equal(report.results.length,2,error);assert.equal(report.comparisonSummary.submittedTrades,2,error);
  assert.equal(report.comparisonSummary.matchedTrades,1,error);assert.equal(report.comparisonSummary.completeForSubmittedTrades,false,error);
  assert.equal(report.comparisonSummary.completeForActiveGoal,false,error);
  assert.deepEqual(report.comparisonSummary.unavailableKeys,['demo-futures:2'],error);
  const unavailable=report.results.find(row=>row.mode==='demo-futures');assert.equal(unavailable.scenarios.length,3,error);
  assert.ok(unavailable.scenarios.every(arm=>arm.comparison.status!=='indicative_comparison'),error);
  const missing=report.comparisonSummary.summaries.find(row=>row.mode==='demo-futures'&&row.adverseSlippageBps==='0');
  assert.equal(missing.arms.baseline.netUsdt,null,error);assert.equal(missing.arms.staged.netUsdt,null,error);
 }
});

test('an approval receipt does not make altered exit geometry comparable to the exact legacy policy',()=>{
 const mutations=[
  ['riskMultiple',p=>p.profitProtection.riskMultiple=20],['missing riskMultiple',p=>delete p.profitProtection.riskMultiple],
  ['holding bars',p=>p.maxHoldingBars=1],['holding seconds',p=>p.maxHoldingSeconds=901],
  ['initial stop',p=>p.stopFraction=.01],['target',p=>p.targetFraction=.01],['risk budget',p=>p.riskBudgetUsdt=2],
  ['trail trigger',p=>p.profitProtection.triggerNetUsdt=.6],['trail giveback',p=>p.profitProtection.givebackNetUsdt=.3],
  ['trail version',p=>p.profitProtection.version='other'],['timeframe',p=>p.timeframe='5m'],['purpose',p=>p.purpose='execution_probe'],
  ['entry policy',p=>p.entryPolicyVersion='forecast-net-edge-v1'],['entry engine',p=>p.entrySignalEngine='sampled_order_flow'],
  ['ATR field',p=>p.atrTimeframe='15m'],['candle field',p=>p.candleBoundary=start],['model field',p=>p.model={}],
  ['adaptive fields',p=>p.adaptiveParameters={}],['flow exit',p=>p.flowExit={}],
  ['prospective exit version',p=>p.exitPolicyVersion='new-prospective-policy']
 ];
 for(const [name,mutate] of mutations){
  const input=fixedExitFixture();mutatePlan(input,mutate);let calls=0;
  const report=buildNetExitReview({input,archives:archives(),replay:()=>{calls++;return comparison();}});
  assert.equal(report.actual.totalEntries,2,name);assert.equal(report.actual.evidenceComplete,true,name);
  assert.equal(calls,3,name);assert.equal(report.results.length,1,name);
  assert.ok(report.excluded.some(row=>row.key==='demo:1'&&row.reason==='ORIGINAL_EXIT_PLAN_NOT_COMPARABLE'),name);
  assert.equal(report.comparisonSummary.completeForActiveGoal,false,name);
 }
});

test('an unapproved prospective exit policy makes the actual approval chain unknown rather than merely incomparable',()=>{
 const input=fixedExitFixture();mutatePlan(input,p=>p.exitPolicy={...KEV_NET_HARVEST_POLICY});
 const before=JSON.stringify(input);let calls=0;
 const report=buildNetExitReview({input,archives:archives(),replay:()=>{calls++;return comparison();}});
 assert.equal(JSON.stringify(input),before);assert.equal(report.actual.evidenceComplete,false);assert.equal(report.actual.totalEntries,null);
 assert.equal(report.actual.summary.netRealizedUsdt,null);assert.equal(report.actual.summary.knownAcceptedRows,2);
 assert.ok(report.actual.warnings.some(w=>w.mode==='demo'&&w.tradeId===1&&w.code==='ORIGINAL_KEV_APPROVAL_INVALID'));
 assert.ok(report.excluded.some(row=>row.key==='demo:1'&&row.reason==='ORIGINAL_KEV_APPROVAL_UNVERIFIED'));
 assert.equal(calls,3);assert.equal(report.results.length,1);assert.equal(report.results[0].key,'demo-futures:2');
 assert.equal(report.results[0].actualNetUsdt,'1.598');assert.equal(report.comparisonSummary.completeForActiveGoal,false);
});

test('a fully approved new exit policy remains in actual outcomes but is excluded from exact legacy replay',()=>{
 const input=fixedExitFixture(),pending=input.journals.demo.find(j=>j.status==='pending'),artifact=input.artifacts.demo[pending.id],
  plan=JSON.parse(artifact.planRaw),review=JSON.parse(artifact.reviewRaw);
 plan.exitPolicy={...KEV_NET_HARVEST_POLICY};pending.exitPolicy={...KEV_NET_HARVEST_POLICY};
 review.request.state.requestVersion='kev-flow-request-v4';review.request.state.exitPolicy={...KEV_NET_HARVEST_POLICY};
 review.request.state.candidates[0].exitPolicyVersion=KEV_NET_HARVEST_POLICY.version;
 delete review.proofSha256;review.proofSha256=digest(review);pending.entryEvidence.kevReview.proofSha256=review.proofSha256;
 artifact.reviewRaw=JSON.stringify(review);plan.entryEvidence=structuredClone(pending.entryEvidence);
 plan.nativeEntryGuard.kevReviewSha256=createHash('sha256').update(artifact.reviewRaw).digest('hex');artifact.planRaw=JSON.stringify(plan);
 const before=JSON.stringify(input);let calls=0;
 const report=buildNetExitReview({input,archives:archives(),replay:()=>{calls++;return comparison();}});
 assert.equal(JSON.stringify(input),before);assert.equal(report.actual.evidenceComplete,true);assert.equal(report.actual.totalEntries,2);
 assert.equal(report.actual.summary.netRealizedUsdt,'3.196');assert.deepEqual(report.actual.warnings,[]);
 assert.ok(report.excluded.some(row=>row.key==='demo:1'&&row.reason==='ORIGINAL_EXIT_PLAN_NOT_COMPARABLE'));
 assert.equal(calls,3);assert.equal(report.results.length,1);assert.equal(report.results[0].key,'demo-futures:2');
 assert.equal(report.comparisonSummary.activeGoalEntries,2);assert.equal(report.comparisonSummary.excludedEntries,1);
 assert.equal(report.comparisonSummary.completeForSubmittedTrades,true);assert.equal(report.comparisonSummary.completeForActiveGoal,false);
});

test('an incomplete actual history cannot authorize complete active-goal research coverage',()=>{
 const input=fixedExitFixture([{flow:true}]);input.histories['demo-futures']={historyComplete:false,error:'HISTORY_UNAVAILABLE',observedAt:input.observedAt};
 const report=buildNetExitReview({input,archives:archives(),replay:comparison});
 assert.equal(report.actual.evidenceComplete,false);assert.equal(report.actual.totalEntries,null);
 assert.equal(report.results.length,1);assert.equal(report.comparisonSummary.completeForSubmittedTrades,true);
 assert.equal(report.comparisonSummary.completeForActiveGoal,false);
});

test('unverified original approval remains visible as an excluded unknown and prevents active-goal completeness',()=>{
 const input=fixedExitFixture(),id=Object.keys(input.artifacts.demo)[0];input.artifacts.demo[id].reviewRaw+=' ';
 const report=buildNetExitReview({input,archives:archives(),replay:comparison});
 assert.equal(report.actual.evidenceComplete,false);assert.equal(report.actual.totalEntries,null);
 assert.ok(report.excluded.some(row=>row.key==='demo:1'&&row.reason==='ORIGINAL_KEV_APPROVAL_UNVERIFIED'));
 assert.equal(report.results.length,1);assert.equal(report.comparisonSummary.completeForActiveGoal,false);
 assert.equal(report.actual.summary.netRealizedUsdt,null,'partial actual aggregate must remain unknown');
 assert.equal(report.results[0].actualNetUsdt,'1.598','independently known actual net is not erased or replaced by scenario net');
});
