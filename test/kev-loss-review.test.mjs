import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildKevLossReview,main} from '../scripts/kev-loss-review.mjs';
import {KEV_NET_HARVEST_POLICY} from '../src/kev-exit-policy.mjs';
import {KEV_ENTRY_SIGNAL_POLICY} from '../src/kev-entry-signal.mjs';

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
   ...(spec.flow?{entryPolicyVersion:'kev-order-flow-v1',ruleVersion:'kev-order-flow-v1',entrySignalEngine:'kev_order_flow',
    nativeEntryGuard:{kevReviewSha256:createHash('sha256').update(reviewRaw).digest('hex')}}:{})};
  artifacts[mode][id]={reviewRaw,snapshotRaw:JSON.stringify(rawSnapshot),planRaw:JSON.stringify(plan)};
  histories[mode].trades.push(trade);journals[mode].push(pending,{id,at:new Date(opened+1000).toISOString(),status:'submitted',action,tradeId:n,pair,tag});
 }
 const amendment=specs.some(s=>s.flow)?{schemaVersion:1,goalId:goal.id,goalSha256:createHash('sha256').update(JSON.stringify(goal)).digest('hex'),
  entryPolicyVersion:'kev-order-flow-v1',ruleVersion:'kev-order-flow-v1',effectiveAt:new Date(start+1000).toISOString()}:null;
 return {goal,amendment,histories,journals,artifacts,observedAt};
}
const near=(actual,expected)=>assert.ok(actual!==null&&Math.abs(Number(actual)-expected)<1e-9,`${actual} != ${expected}`);

function setOriginalPolicy(input,index=0,edit=()=>{}){
 const pending=input.journals.demo.filter(r=>r.status==='pending')[index],artifact=input.artifacts.demo[pending.id],
  review=JSON.parse(artifact.reviewRaw),plan=JSON.parse(artifact.planRaw);
 plan.exitPolicy={...KEV_NET_HARVEST_POLICY};pending.exitPolicy={...KEV_NET_HARVEST_POLICY};
 review.request.state.requestVersion='kev-flow-request-v4';review.request.state.exitPolicy={...KEV_NET_HARVEST_POLICY};
 review.request.state.candidates[0].exitPolicyVersion=KEV_NET_HARVEST_POLICY.version;
 edit({pending,plan,review});
 delete review.proofSha256;review.proofSha256=digest(review);pending.entryEvidence.kevReview.proofSha256=review.proofSha256;
 artifact.reviewRaw=JSON.stringify(review);plan.entryEvidence=structuredClone(pending.entryEvidence);
 plan.nativeEntryGuard.kevReviewSha256=createHash('sha256').update(artifact.reviewRaw).digest('hex');artifact.planRaw=JSON.stringify(plan);
 return {pending,artifact};
}

function reviewerPolicy(input,effectiveFrom=new Date(start+1000).toISOString()){
 input.goal.reviewerPolicy={version:'decision-provider-policy-v1',effectiveFrom,
  allowed:[{version:'jev-typesafe-entry-v1',provider:'typesafe-api',model:'jev-1.13.0'}]};
 if(input.amendment)input.amendment.goalSha256=createHash('sha256').update(JSON.stringify(input.goal)).digest('hex');
}
function setOriginalProvider(input,index=0,provider='typesafe-api',edit=()=>{}){
 const pending=input.journals.demo.filter(r=>r.status==='pending')[index],artifact=input.artifacts.demo[pending.id],
  review=JSON.parse(artifact.reviewRaw),plan=JSON.parse(artifact.planRaw),snapshot=JSON.parse(artifact.snapshotRaw),
  jev=provider==='typesafe-api',version=jev?'jev-typesafe-entry-v1':'kev-codex-entry-v1',model=jev?'jev-1.13.0':'gpt-6-luna',
  revision='12345678-1234-4234-9234-123456789abc',state=review.request.state;
 Object.assign(review,{provider,providerRevision:revision,version,actualModel:model});
 snapshot.kevEntry={enabled:true,version,provider,model,providerRevision:revision};
 state.decisionProvider={provider,model,revision};
 review.response.backend.actual_model=model;
 if(jev){
  review.request.model=review.response.model=model;review.requestId=review.response.request_id=snapshotId(index+900);
  review.response.created_at=review.completedAt;review.response.answers.entry.confidence=.7;
  review.response.usage={input_tokens:42,output_tokens:0};
  review.response.upstream=structuredClone({model,answers:review.response.answers,usage:review.response.usage});
  review.response.backend={name:provider,actual_model:model,weights_loaded:false,probabilities_calibrated:false,
   api_calls:1,request_id_source:'host',timestamp_source:'host'};
  state.requestVersion='kev-flow-request-v5';state.exitPolicy={...KEV_NET_HARVEST_POLICY};
  state.entrySignalPolicy={...KEV_ENTRY_SIGNAL_POLICY};
  Object.assign(state.candidates[0],{exitPolicyVersion:KEV_NET_HARVEST_POLICY.version,entrySignalPolicyVersion:KEV_ENTRY_SIGNAL_POLICY.version});
  for(const value of [plan,pending]){value.exitPolicy={...KEV_NET_HARVEST_POLICY};value.entrySignalPolicy={...KEV_ENTRY_SIGNAL_POLICY};}
  snapshot.entrySignalPolicy={...KEV_ENTRY_SIGNAL_POLICY};plan.nativeEntryGuard.version='kev-native-entry-v3';
 }
 const receipt=pending.entryEvidence.kevReview;
 Object.assign(receipt,{version,provider,model,providerRevision:revision,requestId:review.requestId});
 edit({review,plan,snapshot,pending,receipt});
 review.snapshotSha256=receipt.snapshotSha256=digest(snapshot);
 delete review.proofSha256;review.proofSha256=digest(review);receipt.proofSha256=review.proofSha256;
 artifact.reviewRaw=JSON.stringify(review);artifact.snapshotRaw=JSON.stringify(snapshot);plan.entryEvidence=structuredClone(pending.entryEvidence);
 plan.nativeEntryGuard.kevReviewSha256=createHash('sha256').update(artifact.reviewRaw).digest('hex');artifact.planRaw=JSON.stringify(plan);
}

test('prospective Jev approvals retain old Kev entries, losses, original target and truthful provider groups',()=>{
 const input=fixture([{flow:true,net:-1},{flow:true,net:.2}]);reviewerPolicy(input);setOriginalProvider(input,1);
 const before=JSON.stringify(input),r=buildKevLossReview(input);assert.equal(JSON.stringify(input),before);
 assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,2);assert.deepEqual(r.target,input.goal.target);
 assert.equal(r.summary.netRealizedUsdt,'-0.8');assert.equal(r.summary.wins,1);assert.equal(r.summary.losses,1);
 assert.deepEqual(r.byProvider.map(x=>[x.key,x.entries,x.netRealizedUsdt]),
  [['codex-cli/test-model',1,'-1'],['typesafe-api/jev-1.13.0',1,'0.2']]);
 assert.equal(r.rows[1].decisionProvider.revision,'12345678-1234-4234-9234-123456789abc');
});

test('Jev cannot count under a historical goal without additive policy or before its effective time',()=>{
 for(const authorized of [false,true]){
  const input=fixture([{flow:true,net:-.6}]);setOriginalProvider(input);
  if(authorized)reviewerPolicy(input,new Date(start+60000).toISOString());
  const r=buildKevLossReview(input);assert.equal(r.evidenceComplete,false);assert.equal(r.totalEntries,null);
  assert.equal(r.summary.netRealizedUsdt,null);assert.equal(input.histories.demo.trades[0].profit_abs,-.6);
 }
 const input=fixture([{flow:true}]);setOriginalProvider(input);
 const completed=input.journals.demo[0].entryEvidence.kevReview.completedAt;reviewerPolicy(input,completed);
 assert.equal(buildKevLossReview(input).totalEntries,1,'original completion exactly at effectiveFrom is allowed');
});

test('rehashing a Jev record cannot legitimize forged upstream, aliases, revision or policy provenance',()=>{
 const mutations=[
  ({review})=>delete review.response.upstream,
  ({review})=>review.response.upstream.model='jev-latest',
  ({review})=>review.response.upstream.answers.entry.choice='hold',
  ({review})=>review.response.upstream.usage.input_tokens++,
  ({review})=>review.response.backend.cli_calls=1,
  ({review})=>review.response.backend.request_id_source='remote',
  ({review})=>review.response.backend.timestamp_source='remote',
  ({review})=>review.request.model='kev-codex',
  ({review})=>review.response.model='kev-codex',
  ({review})=>review.actualModel='jev-latest',
  ({review})=>review.response.answers.entry.confidence=true,
  ({review})=>{review.response.upstream.usage.input_tokens=review.response.usage.input_tokens=0;},
  ({review})=>{review.response.upstream.usage.output_tokens=review.response.usage.output_tokens=-1;},
  ({review})=>delete review.providerRevision,
  ({receipt})=>delete receipt.providerRevision,
  ({review})=>review.request.state.decisionProvider.revision=snapshotId(700),
  ({snapshot})=>snapshot.kevEntry.provider='codex-cli',
  ({snapshot})=>snapshot.kevEntry.providerRevision=snapshotId(700),
  ({plan})=>plan.nativeEntryGuard.version='kev-native-entry-v2',
  ({pending})=>delete pending.entrySignalPolicy,
  ({plan})=>delete plan.entrySignalPolicy,
  ({review})=>delete review.request.state.entrySignalPolicy,
 ];
 for(const mutate of mutations){
  const input=fixture([{flow:true,net:-.4}]);reviewerPolicy(input);setOriginalProvider(input,0,'typesafe-api',mutate);
  const r=buildKevLossReview(input);assert.equal(r.evidenceComplete,false,mutate.toString());assert.equal(r.totalEntries,null);
  assert.equal(r.summary.netRealizedUsdt,null);assert.equal(input.histories.demo.trades[0].profit_abs,-.4);
 }
});

test('switching back to Kev retains explicit revision without requiring it on historical receipts',()=>{
 const input=fixture([{flow:true},{flow:true}]);setOriginalProvider(input,1,'codex-cli');
 input.goal.reviewerPolicy={version:'decision-provider-policy-v1',effectiveFrom:new Date(start+1000).toISOString(),
  allowed:[{version:'kev-codex-entry-v1',provider:'codex-cli',model:'gpt-6-luna'}]};
 input.amendment.goalSha256=createHash('sha256').update(JSON.stringify(input.goal)).digest('hex');
 const r=buildKevLossReview(input);assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,2);
 assert.equal(r.rows[0].decisionProvider.revision,null);assert.equal(r.rows[1].decisionProvider.provider,'codex-cli');
});

test('actual long and short fill prices reconcile net without deducting spread twice',()=>{
 const input=fixture([{closeRate:100.1},{mode:'demo-futures',short:true,closeRate:99,funding:.02}]);
 const before=JSON.stringify(input),r=buildKevLossReview(input);assert.equal(JSON.stringify(input),before);
 assert.equal(r.totalEntries,2);assert.equal(r.evidenceComplete,true);near(r.summary.grossPriceComponentUsdt,2.2);
 near(r.summary.feeEquivalentUsdt,.7982);near(r.summary.fundingUsdt,.02);near(r.summary.netRealizedUsdt,1.4218);
 near(r.summary.decompositionResidualUsdt,0);assert.equal(r.summary.grossPositiveNetNegative,1);
 assert.equal(r.summary.wins,1);assert.equal(r.summary.losses,1);assert.equal(r.rows[1].side,'short');
});

test('a fee-adjusted flat close counts as a loss and remains in the win-rate denominator',()=>{
 const input=fixture([{net:0},{net:1},{net:-1}]),r=buildKevLossReview(input);
 assert.equal(r.summary.closedTrades,3);assert.equal(r.summary.wins,1);assert.equal(r.summary.losses,2);
 assert.equal(r.summary.winRate,1/3);assert.equal(r.summary.profitFactor,1);
 assert.equal(r.summary.netRealizedUsdt,'0');
});

test('original legacy receipt without config hash remains valid; raw evidence and plan are still required',()=>{
 const input=fixture(),pending=input.journals.demo[0];assert.equal(pending.entryEvidence.kevReview.configSha256,undefined);
 const r=buildKevLossReview(input);assert.equal(r.totalEntries,1);assert.equal(r.rows[0].kevApprovalVerified,true);
 for(const mutate of [a=>a.reviewRaw=a.reviewRaw.replace('test-model','forged-model'),a=>a.snapshotRaw=a.snapshotRaw.replace('"demo"','"demo-futures"'),
  a=>a.planRaw=a.planRaw.replace('test-model','forged-model'),a=>delete a.reviewRaw]){
  const bad=structuredClone(input);mutate(bad.artifacts.demo[pending.id]);const failed=buildKevLossReview(bad);
  assert.equal(failed.evidenceComplete,false);assert.equal(failed.totalEntries,null);assert.equal(failed.summary.netRealizedUsdt,null);
  assert.equal(failed.rows[0].netUsdt,r.rows[0].netUsdt,'known historical loss or gain is not erased');
  assert.ok(failed.warnings.some(w=>w.code==='ORIGINAL_KEV_APPROVAL_INVALID'));
 }
});

test('autonomous receipt and native exact raw review hash are validated without current entry risk rules',()=>{
 const input=fixture([{flow:true}]);const r=buildKevLossReview(input);assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,1);
 const id=input.journals.demo[0].id;input.artifacts.demo[id].reviewRaw+=' ';
 assert.equal(buildKevLossReview(input).totalEntries,null,'same canonical decision but altered raw bytes fail the historical native hash');
});

test('unapproved legacy receipt cannot be counted merely because model/fill provenance is valid',()=>{
 const input=fixture();input.journals.demo[0].entryEvidence.kevReview.decision.approved=false;
 const r=buildKevLossReview(input);assert.equal(r.totalEntries,null);assert.equal(r.rows[0].kevApprovalVerified,false);
});

test('rehashed reviews still need the original raw backend, response selection and request timing',()=>{
 for(const mutate of [r=>r.response.backend.name='other',r=>r.response.backend.weights_loaded=true,
  r=>r.response.backend.probabilities_calibrated=true,r=>r.response.backend.actual_model='other',
  r=>r.response.request_id='other',r=>r.response.answers.entry.choice='hold',
  r=>r.request.state.candidates[0].pair='ETH/USDT',r=>r.response.created_at='2025-01-01T00:00:00Z']){
  const input=fixture([{flow:true}]),pending=input.journals.demo[0],a=input.artifacts.demo[pending.id],review=JSON.parse(a.reviewRaw);
  mutate(review);delete review.proofSha256;review.proofSha256=digest(review);
  pending.entryEvidence.kevReview.proofSha256=review.proofSha256;
  a.reviewRaw=JSON.stringify(review);const plan=JSON.parse(a.planRaw);plan.entryEvidence=pending.entryEvidence;
  plan.nativeEntryGuard.kevReviewSha256=createHash('sha256').update(a.reviewRaw).digest('hex');a.planRaw=JSON.stringify(plan);
  assert.equal(buildKevLossReview(input).totalEntries,null);
 }
});

test('actual weighted fills survive trade-level price tick rounding',()=>{
 const input=fixture([{net:1.591994}]),t=input.histories.demo.trades[0];
 t.orders[0].average=100.003;t.orders[0].cost=200.006;t.precision_mode_price=4;t.price_precision=.01;
 const r=buildKevLossReview(input);assert.equal(r.summary.decompositionComplete,true);
 near(r.summary.grossPriceComponentUsdt,1.994);near(r.summary.feeEquivalentUsdt,.402006);
 near(r.summary.decompositionResidualUsdt,0);
});

test('base-fee quantity differences are kept as a price component and separate residual, not assumed wallet cash flow',()=>{
 const input=fixture([{entryAmount:2,amount:1.998,closeRate:100.1,net:-.2000998}]),r=buildKevLossReview(input),row=r.rows[0];
 assert.equal(row.entryFillQuantity,'2');assert.equal(row.exitFillQuantity,'1.998');assert.equal(row.quantityBasis,'1.998');
 near(row.grossPriceComponentUsdt,.1998);near(row.feeEquivalentUsdt,.3997998);near(row.decompositionResidualUsdt,-.0001);
 assert.match(r.accounting.drag,/not all commission/);assert.match(r.accounting.price,/not total wallet cash flow/);
});

test('missing fee or funding remains unknown while independently known net PnL stays visible',()=>{
 for(const field of ['fee_open','fee_close','funding_fees']){
  const input=fixture();delete input.histories.demo.trades[0][field];const r=buildKevLossReview(input);
  near(r.summary.netRealizedUsdt,1.598);assert.equal(r.summary.decompositionResidualUsdt,null);assert.equal(r.summary.decompositionComplete,false);
  assert.notEqual(r.summary.priceToNetDragUsdt,null);assert.equal(r.rows[0].decompositionStatus,'missing_fee_funding_or_net');
  assert.equal(r.summary[field==='funding_fees'?'fundingUsdt':'feeEquivalentUsdt'],null);
 }
});

test('missing or inconsistent filled exit prices cannot masquerade as zero gross or zero drag',()=>{
 for(const mutate of [t=>t.orders.pop(),t=>t.orders[1].cost+=1,t=>delete t.amount,t=>t.open_rate='1e99999']){
  const input=fixture();mutate(input.histories.demo.trades[0]);const r=buildKevLossReview(input);
  assert.equal(r.summary.grossPriceComponentUsdt,null);assert.equal(r.summary.priceToNetDragUsdt,null);assert.equal(r.summary.decompositionComplete,false);
 }
});

test('unknown history or net is not reported as zero or a verified target count',()=>{
 const input=fixture();input.histories['demo-futures']={historyComplete:false,error:'HISTORY_UNAVAILABLE'};
 const r=buildKevLossReview(input);assert.equal(r.totalEntries,null);assert.equal(r.summary.netRealizedUsdt,null);
 assert.equal(r.modes['demo-futures'].netRealizedUsdt,null);assert.equal(r.status,'incomplete_evidence');
 const missingNet=fixture();delete missingNet.histories.demo.trades[0].profit_abs;
 assert.equal(buildKevLossReview(missingNet).summary.netRealizedUsdt,null);
});

test('open PnL is separate, split fills and exits do not add entries, historical strategies are not relabeled',()=>{
 const input=fixture([{net:-.5,fingerprint:'1'.repeat(64)},{open:true,net:-.2,flow:true,fingerprint:'2'.repeat(64)}]);
 const first=input.histories.demo.trades[0],order=first.orders[0];order.amount=order.filled=1;order.cost=100;
 first.orders.push({...order,order_id:'entry-split'});
 const r=buildKevLossReview(input);assert.equal(r.totalEntries,2);assert.equal(r.summary.closedTrades,1);assert.equal(r.summary.openTrades,1);
 assert.equal(r.summary.netRealizedUsdt,'-0.5');assert.equal(r.summary.netUnrealizedUsdt,'-0.2');assert.equal(r.byStrategy.length,2);
 assert.equal(r.rows[1].decompositionStatus,'open_trade');assert.equal(r.rows[1].grossPriceComponentUsdt,null);
});

test('the entry cutoff remains fixed across midnight while later exits retain their loss',()=>{
 const input=fixture([{net:-.5},{net:-99}]);input.observedAt='2026-09-23T08:00:00Z';
 for(const history of Object.values(input.histories))history.observedAt=input.observedAt;
 input.histories.demo.trades[0].close_timestamp=Date.parse('2026-09-22T08:00:00Z');
 input.histories.demo.trades[1].orders[0].order_filled_timestamp=Date.parse(input.goal.deadline);
 const r=buildKevLossReview(input);assert.equal(r.totalEntries,1);assert.equal(r.summary.netRealizedUsdt,'-0.5');
 assert.equal(r.status,'deadline_missed');assert.equal(r.deadline,input.goal.deadline);
 assert.ok(r.modes.demo.excluded.some(v=>v.reason==='ENTRY_FILL_AT_OR_AFTER_DEADLINE'));
});

test('CLI rejects mutation/output options before reading credentials or calling APIs',async()=>{
 for(const args of [['--reset'],['--output','goal.json'],['--goal'],['--goal','x','--resume']])
  await assert.rejects(main(args),/USAGE/);
});

test('original exit policy cohorts preserve combined goal membership and net including legacy losses',()=>{
 const input=fixture([{flow:true,net:-.7},{flow:true,net:.3},{net:-.2}]);
 input.goal.target={scope:'each',count:100,totalCount:200};
 input.amendment.goalSha256=createHash('sha256').update(JSON.stringify(input.goal)).digest('hex');
 const before=buildKevLossReview(input);setOriginalPolicy(input,1);const original=JSON.stringify(input),r=buildKevLossReview(input);
 assert.equal(JSON.stringify(input),original);assert.equal(r.totalEntries,before.totalEntries);assert.deepEqual(r.summary,before.summary);
 assert.deepEqual(r.target,before.target);assert.equal(r.summary.netRealizedUsdt,'-0.6');assert.equal(r.summary.losses,2);
 assert.deepEqual(r.rows.map(row=>row.exitPolicyVersion),['kev-flow-fixed-exits-v1','kev-net-harvest-v1',null]);
 assert.equal(r.byExitPolicy.find(g=>g.key==='kev-flow-fixed-exits-v1').netRealizedUsdt,'-0.7');
 assert.equal(r.byExitPolicy.find(g=>g.key==='kev-net-harvest-v1').netRealizedUsdt,'0.3');
 assert.equal(r.byExitPolicy.find(g=>g.key===null).netRealizedUsdt,'-0.2');
 assert.deepEqual(r.modes.demo.byExitPolicy,r.byExitPolicy);assert.deepEqual(r.modes['demo-futures'].byExitPolicy,[]);
 assert.match(r.accounting.exitPolicy,/not causal evidence/);
});

test('new policy must match the original state, selected candidate, plan and pending even after rehashing',()=>{
 const mutations=[
  ({plan})=>delete plan.exitPolicy,({pending})=>delete pending.exitPolicy,({review})=>delete review.request.state.exitPolicy,
  ({review})=>delete review.request.state.candidates[0].exitPolicyVersion,
  ({review})=>review.request.state.candidates[0].exitPolicyVersion='kev-flow-fixed-exits-v1',
  ({review})=>review.request.state.requestVersion='kev-flow-request-v3',
  ({plan})=>plan.exitPolicy.exitSlippageBps='0',({pending})=>pending.exitPolicy.middleNetUsdt='2',
  ({review})=>review.request.state.exitPolicy.lateNetBps='0',
  ({plan})=>plan.exitPolicy.extra='ignored',({plan})=>plan.entryPolicyVersion='other',
  ({plan,pending,review})=>{delete plan.exitPolicy;delete pending.exitPolicy;delete review.request.state.exitPolicy;delete review.request.state.candidates[0].exitPolicyVersion;}
 ];
 for(const edit of mutations){
  const input=fixture([{flow:true,net:-.7}]);setOriginalPolicy(input,0,edit);const r=buildKevLossReview(input);
  assert.equal(r.evidenceComplete,false);assert.equal(r.totalEntries,null);assert.equal(r.rows[0].exitPolicyVersion,null);
  assert.equal(r.rows[0].netUsdt,'-0.7','a policy mismatch never erases an original loss');
  assert.equal(r.rows[0].kevApprovalVerified,false);assert.ok(r.warnings.some(w=>w.code==='ORIGINAL_KEV_APPROVAL_INVALID'));
 }
});

test('legacy reviews stay valid without latest request fields and missing evidence is not relabeled',()=>{
 const old=fixture([{flow:true}]),pending=old.journals.demo[0],artifact=old.artifacts.demo[pending.id];
 const legacy=buildKevLossReview(old);assert.equal(legacy.evidenceComplete,true);assert.equal(legacy.rows[0].exitPolicyVersion,'kev-flow-fixed-exits-v1');
 const nonFlow=fixture();assert.equal(buildKevLossReview(nonFlow).rows[0].exitPolicyVersion,null);
 delete artifact.planRaw;const missing=buildKevLossReview(old);assert.equal(missing.rows[0].exitPolicyVersion,null);assert.equal(missing.evidenceComplete,false);
});
