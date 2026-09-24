import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildKevLossReview,main} from '../scripts/kev-loss-review.mjs';

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
const near=(actual,expected)=>assert.ok(actual!==null&&Math.abs(Number(actual)-expected)<1e-9,`${actual} != ${expected}`);

test('actual long and short fill prices reconcile net without deducting spread twice',()=>{
 const input=fixture([{closeRate:100.1},{mode:'demo-futures',short:true,closeRate:99,funding:.02}]);
 const before=JSON.stringify(input),r=buildKevLossReview(input);assert.equal(JSON.stringify(input),before);
 assert.equal(r.totalEntries,2);assert.equal(r.evidenceComplete,true);near(r.summary.grossPriceComponentUsdt,2.2);
 near(r.summary.feeEquivalentUsdt,.7982);near(r.summary.fundingUsdt,.02);near(r.summary.netRealizedUsdt,1.4218);
 near(r.summary.decompositionResidualUsdt,0);assert.equal(r.summary.grossPositiveNetNegative,1);
 assert.equal(r.summary.wins,1);assert.equal(r.summary.losses,1);assert.equal(r.rows[1].side,'short');
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
