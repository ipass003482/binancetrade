// Read-only cohort accounting. This module never submits orders or updates goals.
import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import DecimalBase from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {journalRead,readJson} from '../src/io.mjs';
import {validKevExitPolicy,reviewedKevExitPolicy} from '../src/kev-exit-policy.mjs';
import {validKevEntrySignalPolicy} from '../src/kev-entry-signal.mjs';
import {reviewedKevEntrySignalPolicy} from '../src/kev-entry-contract.mjs';
import {buildSprintReview} from './trade-sprint-review.mjs';
import {reviewerAllowedForGoal} from './trade-goal-review.mjs';

const Decimal=DecimalBase.clone({precision:512}),MODES=['demo','demo-futures'],HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const JEV_VERSION='jev-typesafe-entry-v1',JEV_MODEL='jev-1.13.0';
const decimal=value=>{
 if(!['number','string'].includes(typeof value)||String(value).length>256)return null;
 const match=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(String(value));
 if(!match||(match[1]!==undefined&&Math.abs(Number(match[1]))>100))return null;
 try{const n=new Decimal(value);return n.isFinite()&&(n.isZero()||Math.abs(n.e)<=100)&&n.sd()<=128?n:null;}catch{return null;}
};
const time=value=>typeof value==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const formatted=value=>value.toSignificantDigits(20).toFixed();
const sum=(rows,key)=>rows.every(r=>decimal(r[key])!==null)?rows.reduce((n,r)=>n.plus(r[key]),new Decimal(0)).toFixed():null;
const ratio=(a,b)=>a!==null&&b!==null&&new Decimal(b).gt(0)?new Decimal(a).div(b).toNumber():null;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?
 Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const normalizedReceipt=r=>r?{...r,completedAt:time(r.completedAt)?new Date(r.completedAt).toISOString():r.completedAt,
 expiresAt:time(r.expiresAt)?new Date(r.expiresAt).toISOString():r.expiresAt}:null;

function originalExitPolicy(pending,plan,review){
 const state=review?.request?.state,selected=state?.candidates?.filter(c=>c.pair===pending.pair&&c.action===pending.action)??[];
 const flowPlan=plan.entryPolicyVersion==='kev-order-flow-v1'&&plan.ruleVersion==='kev-order-flow-v1'&&plan.entrySignalEngine==='kev_order_flow';
 // Policy declarations must not disappear from one part of the approval chain
 // and silently relabel a new entry as a legacy fixed-exit trade.
 const declared=Object.hasOwn(plan,'exitPolicy')||Object.hasOwn(pending,'exitPolicy')||
  (state&&Object.hasOwn(state,'exitPolicy'))||selected.some(c=>Object.hasOwn(c,'exitPolicyVersion'))||state?.requestVersion==='kev-flow-request-v4';
 if(!declared)return {valid:true,version:flowPlan?'kev-flow-fixed-exits-v1':null};
 try{
  const approved=reviewedKevExitPolicy(review,pending.pair,pending.action);
  const valid=flowPlan&&pending.entryPolicyVersion==='kev-order-flow-v1'&&validKevExitPolicy(plan.exitPolicy)&&
   validKevExitPolicy(pending.exitPolicy)&&digest(plan.exitPolicy)===digest(pending.exitPolicy)&&digest(plan.exitPolicy)===digest(approved);
  return {valid,version:valid?plan.exitPolicy.version:null};
 }catch{return {valid:false,version:null};}
}

function originalProvider(review,receipt,snapshot){
 const jev=review.version===JEV_VERSION,provider=jev?'typesafe-api':'codex-cli',state=review.request?.state,
  selected=snapshot.kevEntry,declared=jev||Object.hasOwn(review,'provider')||Object.hasOwn(review,'providerRevision')||
   Object.hasOwn(receipt,'providerRevision')||Object.hasOwn(state??{},'decisionProvider')||
   Object.hasOwn(selected??{},'provider')||Object.hasOwn(selected??{},'providerRevision');
 if(!jev&&review.version!=='kev-codex-entry-v1')return null;
 if(declared){
  const model=jev?JEV_MODEL:'gpt-6-luna',revision=review.providerRevision;
  if(!UUID.test(revision??'')||review.provider!==provider||review.actualModel!==model||receipt.providerRevision!==revision||
   digest(state?.decisionProvider)!==digest({provider,model,revision})||selected?.version!==review.version||selected.enabled!==true||
   selected.provider!==provider||selected.model!==model||selected.providerRevision!==revision)return null;
 }
 return {version:review.version,provider,model:review.actualModel,revision:declared?review.providerRevision:null};
}

function rawAnswerValid(mode,pending,review){
 const {request,response}=review,backend=response?.backend,state=request?.state,candidates=state?.candidates;
 const jev=review.version===JEV_VERSION,model=jev?JEV_MODEL:'kev-codex',provider=jev?'typesafe-api':'codex-cli';
 if(request?.model!==model||response?.model!==model||state?.mode!==mode||state.snapshotId!==pending.snapshotId||
  backend?.name!==provider||backend.actual_model!==review.actualModel||backend.weights_loaded!==false||
  backend.probabilities_calibrated!==false||(!jev&&backend.cli_calls!==1)||response.request_id!==review.requestId||
  !Array.isArray(candidates)||!candidates.length||new Set(candidates.map(c=>c.id)).size!==candidates.length||
  ![review.startedAt,review.completedAt,review.expiresAt,response.created_at].every(time))return false;
 const [start,complete,expires,created]=[review.startedAt,review.completedAt,review.expiresAt,response.created_at].map(Date.parse);
 if(start>complete||complete>Date.parse(pending.at)||Date.parse(pending.at)>=expires||created<start-2000||created>complete+2000)return false;
 if(jev){
  const upstream=response.upstream,usage=response.usage,confidence=upstream?.answers?.entry?.confidence;
  if(review.decisionMode!=='autonomous'||pending.entryPolicyVersion!=='kev-order-flow-v1'||state.requestVersion!=='kev-flow-request-v5'||
   digest(backend)!==digest({name:provider,actual_model:JEV_MODEL,weights_loaded:false,probabilities_calibrated:false,
    api_calls:1,request_id_source:'host',timestamp_source:'host'})||!UUID.test(response.request_id??'')||
   !upstream||typeof upstream!=='object'||Array.isArray(upstream)||upstream.model!==JEV_MODEL||
   digest(upstream.answers)!==digest(response.answers)||digest(upstream.usage)!==digest(usage)||
   !Number.isSafeInteger(usage?.input_tokens)||usage.input_tokens<1||!Number.isSafeInteger(usage?.output_tokens)||usage.output_tokens<0||
   typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1||created<start||created>complete)return false;
 }
 const selected=candidates.filter(c=>c.pair===pending.pair&&c.action===pending.action);if(selected.length!==1)return false;
 const autonomous=review.decisionMode==='autonomous',answer=response.answers?.[autonomous?'entry':selected[0].id];
 if(answer?.type!=='choice'||answer.choice!==(autonomous?selected[0].id:'approve'))return false;
 const probabilities=answer.probabilities,choices=autonomous?[...candidates.map(c=>c.id),'hold']:['approve','hold'];
 if(!probabilities||Object.keys(probabilities).sort().join('|')!==choices.sort().join('|')||
  choices.some(c=>typeof probabilities[c]!=='number'||!Number.isFinite(probabilities[c])||probabilities[c]<0||probabilities[c]>1)||
  Math.abs(choices.reduce((sum,c)=>sum+probabilities[c],0)-1)>.011||
  choices.some(c=>c!==answer.choice&&probabilities[c]>=probabilities[answer.choice]))return false;
 const decision=review.decisions?.find(d=>d.pair===pending.pair&&d.action===pending.action);
 if(digest(decision?.probabilities)!==digest(probabilities))return false;
 return !autonomous||(Object.keys(response.answers).length===1&&digest(review.selection)===digest({choice:answer.choice,probabilities}));
}

function artifactsValid(mode,pending,artifact){
 try{
  const review=JSON.parse(artifact.reviewRaw),snapshot=JSON.parse(artifact.snapshotRaw),plan=JSON.parse(artifact.planRaw),
   receipt=pending.entryEvidence.kevReview,{proofSha256,...body}=review,provider=originalProvider(review,receipt,snapshot);
  if(proofSha256!==digest(body)||proofSha256!==receipt.proofSha256||review.snapshotSha256!==digest(snapshot)||
   review.snapshotSha256!==receipt.snapshotSha256||snapshot.mode!==mode||snapshot.id!==pending.snapshotId||
   review.mode!==mode||review.snapshotId!==pending.snapshotId||review.enabled!==true||review.status!=='reviewed'||review.invoked!==true||
   plan.tag!==pending.tag||plan.pair!==pending.pair||plan.snapshotId!==pending.snapshotId||
   digest(normalizedReceipt(plan.entryEvidence?.kevReview))!==digest(normalizedReceipt(receipt))||!rawAnswerValid(mode,pending,review)||
   !originalExitPolicy(pending,plan,review).valid||!provider)return false;
  if(provider.provider==='typesafe-api'){
   const signal=reviewedKevEntrySignalPolicy(review,snapshot,pending.pair,pending.action);
   if(plan.nativeEntryGuard?.version!=='kev-native-entry-v3'||plan.entryPolicyVersion!=='kev-order-flow-v1'||
    !validKevEntrySignalPolicy(plan.entrySignalPolicy)||!validKevEntrySignalPolicy(pending.entrySignalPolicy)||
    digest(signal)!==digest(plan.entrySignalPolicy)||digest(signal)!==digest(pending.entrySignalPolicy))return false;
  }
  const decisions=review.decisions?.filter(d=>d.pair===pending.pair&&d.action===pending.action);
  if(decisions?.length!==1||digest(decisions[0])!==digest(receipt.decision))return false;
  const expected={version:review.version,provider:provider.provider,model:review.actualModel,requestId:review.requestId,
   snapshotId:review.snapshotId,snapshotSha256:review.snapshotSha256,proofSha256:review.proofSha256,
   completedAt:review.completedAt,expiresAt:review.expiresAt,decision:decisions[0],probabilitiesCalibrated:false};
  // Historical approval receipts did not contain these newer fields. Check each
  // field that was recorded then; never inject the present configuration.
  if(Object.hasOwn(receipt,'decisionMode'))expected.decisionMode=review.decisionMode??'approval';
  if(Object.hasOwn(receipt,'configSha256'))expected.configSha256=review.configSha256;
  if(Object.hasOwn(receipt,'selection'))expected.selection=review.selection??null;
  if(provider.revision!==null)expected.providerRevision=provider.revision;
  if(digest(normalizedReceipt(receipt))!==digest(normalizedReceipt(expected)))return false;
  const rawHash=plan.nativeEntryGuard?.kevReviewSha256;
  return rawHash===undefined||rawHash===createHash('sha256').update(artifact.reviewRaw).digest('hex');
 }catch{return false;}
}

function approvalValid(goal,pending){
 if(goal.kevEntry?.required!==true&&pending?.entryEvidence?.kevReview?.provider!=='typesafe-api')return null;
 const r=pending?.entryEvidence?.kevReview,d=r?.decision,flow=pending?.entryPolicyVersion==='kev-order-flow-v1';
 return reviewerAllowedForGoal(goal,r)&&
  typeof r.requestId==='string'&&r.requestId.length>0&&r.snapshotId===pending.snapshotId&&
  HEX.test(r.snapshotSha256??'')&&HEX.test(r.proofSha256??'')&&
  (r.configSha256===undefined?!flow:HEX.test(r.configSha256))&&r.probabilitiesCalibrated===false&&
  d?.approved===true&&d.pair===pending.pair&&d.action===pending.action&&d.choice===(flow?'select':'approve')&&
  time(r.completedAt)&&time(r.expiresAt)&&time(pending.at)&&Date.parse(r.completedAt)<=Date.parse(pending.at)&&
  Date.parse(pending.at)<Date.parse(r.expiresAt);
}

function filledSide(trade,entry){
 if(!Array.isArray(trade.orders))return null;
 const filled=trade.orders.filter(o=>o.ft_is_entry===entry&&decimal(o.filled)?.gt(0));
 if(!filled.length||filled.some(o=>o.is_open!==false||o.status!=='closed'||o.pair!==trade.pair||
   !decimal(o.cost)?.gt(0)||!decimal(o.remaining)?.isZero()||
   (o.average!==undefined&&(!decimal(o.average)?.gt(0)||decimal(o.cost).minus(new Decimal(o.filled).mul(o.average)).abs()
    .gt(Decimal.max(new Decimal(o.cost).abs().mul('1e-8'),'1e-8'))))))return null;
 const quantity=filled.reduce((n,o)=>n.plus(o.filled),new Decimal(0));
 return {quantity,price:filled.reduce((n,o)=>n.plus(o.cost),new Decimal(0)).div(quantity)};
}

function decompose(trade){
 const empty={grossPriceComponentUsdt:null,priceToNetDragUsdt:null,feeEquivalentUsdt:null,fundingUsdt:null,
  decompositionResidualUsdt:null,entryFillQuantity:null,exitFillQuantity:null,quantityBasis:null};
 if(trade.is_open!==false)return {...empty,decompositionStatus:'open_trade'};
 const amount=decimal(trade.amount),open=decimal(trade.open_rate),close=decimal(trade.close_rate),net=decimal(trade.profit_abs),
  entry=filledSide(trade,true),exit=filledSide(trade,false);
 if(!amount?.gt(0)||!open?.gt(0)||!close?.gt(0)||!entry||!exit||typeof trade.is_short!=='boolean')
  return {...empty,decompositionStatus:'missing_actual_fill_or_price'};
 // Freqtrade can round its trade-level rates to the exchange tick even when
 // one market order filled at multiple prices. Cost / quantity retains that
 // actual weighted fill price; accept only the documented tick-sized rounding.
 const tick=trade.precision_mode_price===4&&decimal(trade.price_precision)?.gt(0)?decimal(trade.price_precision):new Decimal(0);
 const matches=(a,b)=>a.minus(b).abs().lte(Decimal.max(b.abs().mul('1e-8'),'1e-8',tick));
 if(!matches(open,entry.price)||!matches(close,exit.price))return {...empty,decompositionStatus:'fill_price_mismatch'};
 const gross=amount.mul(exit.price.minus(entry.price)).mul(trade.is_short?-1:1),a=decimal(trade.fee_open),b=decimal(trade.fee_close),funding=decimal(trade.funding_fees);
 const fees=a&&b&&a.gte(0)&&b.gte(0)&&a.lte(1)&&b.lte(1)?amount.mul(entry.price).mul(a).plus(amount.mul(exit.price).mul(b)):null;
 return {grossPriceComponentUsdt:formatted(gross),priceToNetDragUsdt:net?formatted(gross.minus(net)):null,
  feeEquivalentUsdt:fees?formatted(fees):null,fundingUsdt:funding?.toFixed()??null,
  decompositionResidualUsdt:net&&fees&&funding?net.minus(gross.minus(fees).plus(funding)).toFixed(12):null,
  entryFillQuantity:entry.quantity.toFixed(),exitFillQuantity:exit.quantity.toFixed(),quantityBasis:amount.toFixed(),
  decompositionStatus:net&&fees&&funding?'complete':'missing_fee_funding_or_net'};
}

function statistics(rows,complete){
 const closed=rows.filter(r=>!r.isOpen),open=rows.filter(r=>r.isOpen),pnlComplete=complete&&rows.every(r=>decimal(r.netUsdt)!==null);
 const wins=closed.filter(r=>decimal(r.netUsdt)?.gt(0)),losses=closed.filter(r=>decimal(r.netUsdt)?.lte(0));
 const winning=sum(wins,'netUsdt'),losing=sum(losses,'netUsdt'),averageWin=wins.length?formatted(new Decimal(winning).div(wins.length)):null,
  averageLoss=losses.length?formatted(new Decimal(losing).div(losses.length).neg()):null;
 return {entries:complete?rows.length:null,knownAcceptedRows:rows.length,closedTrades:complete?closed.length:null,openTrades:complete?open.length:null,
  pnlComplete,netRealizedUsdt:pnlComplete?sum(closed,'netUsdt'):null,netUnrealizedUsdt:pnlComplete?sum(open,'netUsdt'):null,
  wins:pnlComplete?wins.length:null,losses:pnlComplete?losses.length:null,winRate:pnlComplete&&closed.length?wins.length/closed.length:null,
  averageWinUsdt:pnlComplete?averageWin:null,averageLossUsdt:pnlComplete?averageLoss:null,
  profitFactor:pnlComplete?ratio(winning,losing===null?null:new Decimal(losing).neg().toFixed()):null,
  empiricalBreakEvenWinRate:pnlComplete&&averageWin!==null&&averageLoss!==null?ratio(averageLoss,new Decimal(averageWin).plus(averageLoss).toFixed()):null,
  grossPriceComponentUsdt:complete?sum(closed,'grossPriceComponentUsdt'):null,
  priceToNetDragUsdt:pnlComplete?sum(closed,'priceToNetDragUsdt'):null,
  feeEquivalentUsdt:complete?sum(closed,'feeEquivalentUsdt'):null,fundingUsdt:complete?sum(closed,'fundingUsdt'):null,
  decompositionResidualUsdt:complete?sum(closed,'decompositionResidualUsdt'):null,
  decompositionComplete:complete&&closed.every(r=>r.decompositionStatus==='complete'),
  grossPositiveNetNegative:pnlComplete&&closed.every(r=>decimal(r.grossPriceComponentUsdt)!==null)?
   closed.filter(r=>new Decimal(r.grossPriceComponentUsdt).gt(0)&&new Decimal(r.netUsdt).lt(0)).length:null};
}

export function buildKevLossReview(input){
 const sprint=buildSprintReview(input),rows=[],warnings=[];
 const modeComplete={};
 for(const mode of MODES){
  const accepted=sprint.modes[mode];modeComplete[mode]=accepted.evidenceComplete;
  warnings.push(...accepted.warnings.map(w=>({mode,...w})));
  for(const proof of accepted.trades){
   const trade=input.histories[mode].trades.find(t=>String(t.trade_id)===String(proof.tradeId));
   const pending=input.journals[mode].find(j=>j.id===proof.journalId&&j.status==='pending');
   const receiptApproved=approvalValid(input.goal,pending),receipt=pending?.entryEvidence?.kevReview;
   const kevApprovalVerified=receiptApproved===null?null:receiptApproved&&artifactsValid(mode,pending,input.artifacts?.[mode]?.[proof.journalId]);
   if(kevApprovalVerified===false){modeComplete[mode]=false;warnings.push({mode,tradeId:proof.tradeId,code:'ORIGINAL_KEV_APPROVAL_INVALID'});}
   let exitPolicyVersion=null,decisionProvider=null;
   if(kevApprovalVerified===true){
    const artifact=input.artifacts[mode][proof.journalId];
    exitPolicyVersion=originalExitPolicy(pending,JSON.parse(artifact.planRaw),JSON.parse(artifact.reviewRaw)).version;
    decisionProvider=originalProvider(JSON.parse(artifact.reviewRaw),receipt,JSON.parse(artifact.snapshotRaw));
   }
   const decomposition=decompose(trade);
   if(!['complete','open_trade'].includes(decomposition.decompositionStatus))warnings.push({mode,tradeId:proof.tradeId,code:decomposition.decompositionStatus});
   rows.push({mode,tradeId:proof.tradeId,pair:trade.pair,isOpen:trade.is_open,side:trade.is_short?'short':'long',
    openedAt:proof.openedAt,closedAt:trade.is_open?null:new Date(trade.close_timestamp).toISOString(),
    holdSeconds:trade.is_open?null:(trade.close_timestamp-trade.open_timestamp)/1000,exitReason:trade.is_open?null:trade.exit_reason??'unknown',
    netUsdt:decimal(trade.profit_abs)?.toFixed()??null,entryPolicyVersion:proof.entryPolicyVersion,exitPolicyVersion,
    strategyFingerprint:proof.strategyFingerprint,kevConfigSha256:receipt?.configSha256??null,kevModel:receipt?.model??null,
    kevApprovalVerified,decisionProvider,entryOrderIds:proof.entryOrderIds,...decomposition});
  }
 }
 const evidenceComplete=MODES.every(m=>modeComplete[m]),summary=statistics(rows,evidenceComplete);
 const groups=(key,sourceRows=rows,complete=evidenceComplete)=>[...new Set(sourceRows.map(key))].sort().map(value=>({key:value,
  ...statistics(sourceRows.filter(r=>key(r)===value),complete)}));
 return {schemaVersion:1,source:'kev-loss-review',observedAt:input.observedAt,goalId:sprint.goalId,startedAt:sprint.startedAt,
  deadline:sprint.deadline,timezone:sprint.timezone,target:sprint.target,status:evidenceComplete?sprint.status:'incomplete_evidence',
  evidenceComplete,totalEntries:evidenceComplete?sprint.totalEntries:null,summary,
  modes:Object.fromEntries(MODES.map(mode=>[mode,{observedAt:input.histories?.[mode]?.observedAt??null,
   ...statistics(rows.filter(r=>r.mode===mode),modeComplete[mode]),
   byExitPolicy:groups(r=>r.exitPolicyVersion,rows.filter(r=>r.mode===mode),modeComplete[mode]),
   byProvider:groups(r=>r.decisionProvider?r.decisionProvider.provider+'/'+r.decisionProvider.model:'unverified',rows.filter(r=>r.mode===mode),modeComplete[mode]),excluded:sprint.modes[mode].excluded}])),
  byExit:groups(r=>r.exitReason??'open'),byPair:groups(r=>r.mode+'/'+r.pair),
  byExitPolicy:groups(r=>r.exitPolicyVersion),
  byProvider:groups(r=>r.decisionProvider?r.decisionProvider.provider+'/'+r.decisionProvider.model:'unverified'),
  byStrategy:groups(r=>r.mode+'/'+r.entryPolicyVersion+'/'+(r.strategyFingerprint??'legacy-unrecorded')),
  byKevConfiguration:groups(r=>r.kevConfigSha256??'legacy-unrecorded'),rows,warnings,
  accounting:{net:'Engine profit_abs already includes its fee/funding accounting; do not deduct modeled costs again.',
   price:'Actual average filled prices verified against order quote cost / filled quantity, multiplied by trade.amount. This is a matched-quantity price component, not total wallet cash flow.',
   drag:'Price-to-net difference is not all commission: it may include fee asset conversion, base-fee quantity treatment and precision. Fee equivalent uses recorded side rates; residual is separately shown. Raw fee_cost currencies must not be summed as USDT.',
   spread:'Actual fill prices already reflect executed spread/slippage; no second modeled spread/slippage charge is deducted.',
   exitPolicy:'Original verified entry plan, pending journal and approval determine the exit-policy cohort. Legacy Kev flow plans without a declared policy retain kev-flow-fixed-exits-v1; missing or other policies remain null. Policy cohorts are descriptive, not causal evidence of an improvement.',
   decisionProvider:'Original snapshot, review, provider revision and raw upstream approval determine provider attribution. Prospective goal reviewerPolicy adds only explicitly permitted approvals after effectiveFrom; historical Kev trades and all cumulative losses remain. Provider groups are descriptive, not causal comparisons.',
   scope:sprint.countDefinition,unknown:'Missing values remain null. Descriptive cohorts do not prove causality, future edge, or authorize trading.'},
  executionChanged:false,promotionAuthorized:false};
}

// Shared read-only loader: comparison tools must reuse the same original
// approval/fill/cohort evidence instead of fetching a different trade subset.
export async function loadKevLossReviewInput(argv=[],{root=ROOT}={}){
 if(argv.length&&!(argv.length===2&&argv[0]==='--goal'))throw Error('USAGE: kev-loss-review.mjs [--goal goal.json]');
 const active=argv.length?null:await readJson(join(root,'local/trade-goals/active.json'));
 const goalPath=resolve(root,argv.length?argv[1]:active.goalPath),goal=JSON.parse(await readFile(goalPath,'utf8'));
 let amendment=null;
 for(const name of ['order-flow-only-amendment.json','kev-order-flow-amendment.json']){
  try{const value=await readJson(join(dirname(goalPath),name));if(amendment)throw Error('MULTIPLE_GOAL_AMENDMENTS');amendment=value;}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const {validatePolicy}=await import('../src/config.mjs'),{modePolicy}=await import('../src/mode.mjs'),
  {FreqtradeClient}=await import('../src/freqtrade.mjs');
 const policyConfig=validatePolicy(await readJson(join(root,'config/policy.json')));
 const histories={},journals={};
 await Promise.all(MODES.map(async mode=>{
  try{const policy=modePolicy(policyConfig,mode),client=new FreqtradeClient(policy,await readJson(join(root,'local',mode,'api-auth.json')));
   histories[mode]={source:'freqtrade-demo',historyComplete:true,trades:await client.history(),observedAt:new Date().toISOString()};
   journals[mode]=await journalRead(join(root,'local',mode,'orders.jsonl'));
  }catch{histories[mode]={source:'freqtrade-demo',historyComplete:false,observedAt:new Date().toISOString(),error:'HISTORY_OR_JOURNAL_UNAVAILABLE'};}
 }));
 const input={goal,amendment,histories,journals,observedAt:new Date().toISOString()},checked=buildSprintReview(input),artifacts={};
 for(const mode of MODES){
  artifacts[mode]={};
  for(const proof of checked.modes[mode].trades){
   const pending=journals[mode].find(j=>j.id===proof.journalId&&j.status==='pending');
   try{const [reviewRaw,snapshotRaw,planRaw]=await Promise.all([
    join(root,'local',mode,'runs',pending.snapshotId+'.kev-review.json'),
    join(root,'local',mode,'runs',pending.snapshotId+'.snapshot.json'),
    join(root,'local',mode,'entry-plans','codex-'+proof.journalId+'.json')].map(p=>readFile(p,'utf8')));
    artifacts[mode][proof.journalId]={reviewRaw,snapshotRaw,planRaw};
   }catch{artifacts[mode][proof.journalId]=null;}
  }
 }
 return {...input,artifacts};
}

export async function main(argv=process.argv.slice(2)){
 const report=buildKevLossReview(await loadKevLossReviewInput(argv));
 console.log(JSON.stringify(report,null,2));if(!report.evidenceComplete)process.exitCode=1;return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
