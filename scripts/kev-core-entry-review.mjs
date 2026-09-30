// Detached, read-only fixed-hypothesis comparison. Never an order or fill.
import {readFile,readdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import DecimalBase from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {modePolicy} from '../src/mode.mjs';
import {clockRange} from '../src/exchange-clock.mjs';
import {decisionTiming} from '../src/entry-timing.mjs';
import {validateOrderFlowData,assessOrderFlow,assessFlowShock,FLOW_SELECTIVITY} from '../src/order-flow.mjs';
import {assessKevEntrySignal,KEV_ENTRY_SIGNAL_POLICY} from '../src/kev-entry-signal.mjs';
import {kevSignalQuoteRejection} from '../src/kev-entry-contract.mjs';
import {advanceConfirmation} from '../src/kev-confirmation.mjs';
import {entryCost,executableCostEconomics} from '../src/trading-costs.mjs';
import {checkDemoOrderSize} from '../src/demo-order-size.mjs';
import {demoRiskPolicy} from '../src/demo-risk.mjs';
import {decodeKevQuoteArchive} from '../src/kev-net-exit-replay.mjs';
import {depthExitQuote} from './kev-executable-path-audit.mjs';

const D=DecimalBase.clone({precision:40}),sha=value=>createHash('sha256').update(value).digest('hex');
export const REVIEW_WINDOW=Object.freeze({from:'2026-09-29T01:45:00.000Z',holdoutFrom:'2026-09-29T04:45:00.000Z',to:'2026-09-29T05:45:00.000Z'});
const FROM=Date.parse(REVIEW_WINDOW.from),HOLDOUT=Date.parse(REVIEW_WINDOW.holdoutFrom),TO=Date.parse(REVIEW_WINDOW.to),MAX_GAP=20000;
const MODES=['demo','demo-futures'],ARMS=['legacyOne','legacyTwo','coherent'],HORIZONS=[300,600,900];
const increment=(obj,key)=>{obj[key]=(obj[key]??0)+1;};
const counts=rows=>{const result={};for(const row of rows)for(const reason of row)increment(result,reason);return result;};

// Discover by the original top-level timestamp, never by mtime. Read only the
// JSON prefix before markets for the 30k+ older large snapshots. Unrecognised
// layouts are explicitly missing discovery evidence, not out-of-scope zeros.
async function readSnapshotInventory(directory){
 const names=(await readdir(directory)).filter(n=>n.endsWith('.snapshot.json')),selected=[],issues=[];
 for(let offset=0;offset<names.length;offset+=16){
  await Promise.all(names.slice(offset,offset+16).map(async name=>{
   let handle;try{
    handle=await open(join(directory,name),'r');const buffer=Buffer.alloc(4096),{bytesRead}=await handle.read(buffer,0,buffer.length,0),prefix=buffer.subarray(0,bytesRead).toString('utf8');
    const marketIndex=prefix.indexOf('"markets"');
    if(marketIndex<0)throw Error('SNAPSHOT_HEADER_LAYOUT_UNRECOGNIZED');
    const metadata=JSON.parse(prefix.slice(0,marketIndex)+'"markets":[]}'),at=Date.parse(metadata.createdAt);
    if(!Number.isFinite(at)||typeof metadata.id!=='string')throw Error('SNAPSHOT_HEADER_INVALID');
    if(at>=FROM-60000&&at<TO)selected.push({file:name,at,id:metadata.id});
   }catch(error){issues.push({file:name,reason:error.code??error.message});}finally{await handle?.close();}
  }));
 }
 return {inventorySnapshots:names.length,selected:selected.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)),issues};
}

function commonChecks(snapshot,market,action,policy,costConfig,at){
 const reasons=[];let sizing=null,cost=null,economics=null,stake=null;
 try{clockRange(snapshot.clock,snapshot.mode,at);const timing=decisionTiming(snapshot);
  if(!timing||at<timing.boundary||at>=timing.deadline)throw Error('KEV_FLOW_DECISION_EXPIRED');
 }catch(error){reasons.push(error.message);}
 if(!policy.pairs.includes(market.pair))reasons.push('PAIR_NOT_ALLOWED');
 if((snapshot.mode==='demo'?market.verifiedSpot:market.verifiedFutures)!==true||!Number.isFinite(market.spreadBps)||market.spreadBps<0||market.spreadBps>policy.maxSpreadBps)
  reasons.push('QUOTE_REJECTED');
 const valid=validateOrderFlowData(market.orderFlow,{mode:snapshot.mode,pair:market.pair,now:at});
 if(!valid.eligible)reasons.push(valid.reason);
 else{const shock=assessFlowShock(valid,{spreadBps:market.spreadBps});if(!shock.eligible)reasons.push(shock.reason);}
 try{
  cost=entryCost(snapshot.costFacts,market,snapshot.mode,costConfig,at);
  if(cost.status!=='ok')throw Error(cost.reason??'ENTRY_COSTS_UNAVAILABLE');
  if(market.entryCost?.status!=='ok'||['buyRate','sellRate','roundTripFeeBps','spreadBps','slippageBpsPerSide','fundingReserveBps','estimatedRoundTripCostBps','requiredPriceSpaceBps']
   .some(key=>!new D(cost[key]).eq(market.entryCost[key])))throw Error('ORIGINAL_COST_EVIDENCE_MISMATCH');
  const required=new D(cost.requiredPriceSpaceBps),fees=new D(cost.estimatedRoundTripCostBps).div(10000),reward=new D('.015').minus(fees),risk=new D('.005').plus(fees);
  if(required.gt(150))reasons.push('KEV_FLOW_PRICE_SPACE_TOO_SMALL');
  if(reward.lte(risk))reasons.push('KEV_FLOW_NET_REWARD_RISK_TOO_SMALL');
  economics=executableCostEconomics({mode:snapshot.mode,action,market:{...market,entryCost:cost},stopFraction:'.005',targetFraction:'.015',maxHoldingSeconds:900});
  const targetNetBps=new D(economics.targetNetUsdtPer100).mul(100),drift=D.min(policy.maxPriceMoveBps,cost.slippageBpsPerSide,new D(150).minus(required));
  if(drift.lt(0)||targetNetBps.minus(drift).lt(10))reasons.push('KEV_NET_MARGIN_TOO_SMALL');
  stake=D.min(policy.maxStakeUsdt,policy.maxExposureUsdt,new D(1).div(risk.plus(demoRiskPolicy(snapshot.mode).reserveFraction))).toFixed(8,D.ROUND_DOWN);
  sizing=checkDemoOrderSize({market,price:action==='open-short'?market.bid:market.ask,stakeUsdt:stake,leverage:1});
  if(!sizing.eligible)reasons.push(...sizing.reasons);
 }catch(error){reasons.push(error.message==='KEV_COST_ECONOMICS_INVALID'?error.message:cost?.status!=='ok'?cost?.reason??'ENTRY_COSTS_UNAVAILABLE':'COST_OR_SIZE_EVIDENCE_INVALID');}
 return {eligible:reasons.length===0,reasons:[...new Set(reasons)],sizing,stakeUsdt:stake,cost,economics};
}

export function evaluateCoreSnapshot(snapshot,{policy,costConfig,confirmationState=null}={}){
 const at=Date.parse(snapshot.completedAt??snapshot.createdAt),rows=[];
 if(!Number.isSafeInteger(at)||snapshot.mode!==policy.mode)throw Error('REVIEW_SNAPSHOT_TIME_OR_MODE_INVALID');
 let state=confirmationState;
 for(const market of snapshot.markets)for(const action of snapshot.mode==='demo'?['buy']:['open-long','open-short']){
  const long=action!=='open-short',common=commonChecks(snapshot,market,action,policy,costConfig,at),
   legacy=assessOrderFlow(market.orderFlow,{mode:snapshot.mode,pair:market.pair,long,now:at,minTakerShare:'.55',
    minMidChangeBps:FLOW_SELECTIVITY.minimumMidChangeBps,maxDepthImbalance:FLOW_SELECTIVITY.maximumDepthImbalance}),
   coherent=assessKevEntrySignal(market.orderFlow,{mode:snapshot.mode,pair:market.pair,long,now:at}),
   quoteRejection=coherent.eligible?kevSignalQuoteRejection(market.orderFlow,market,{long}):null,
   legacyOne=common.eligible&&legacy.eligible,
   advanced=advanceConfirmation(state,{mode:snapshot.mode,pair:market.pair,action,snapshotId:snapshot.id,boundary:snapshot.decisionBoundary,
    intervalMs:snapshot.decisionIntervalMs,eligible:legacyOne,now:at});state=advanced.state;
  rows.push({key:snapshot.mode+':'+snapshot.id+':'+market.pair+':'+action,snapshotId:snapshot.id,mode:snapshot.mode,pair:market.pair,action,
   createdAt:snapshot.createdAt,at,boundary:snapshot.decisionBoundary,split:Date.parse(snapshot.createdAt)<HOLDOUT?'development':'holdout',
   common:{eligible:common.eligible,reasons:common.reasons},
   arms:{legacyOne,legacyTwo:legacyOne&&advanced.confirmation?.confirmed===true,coherent:common.eligible&&coherent.eligible&&!quoteRejection},
   legacy:{eligible:legacy.eligible,reason:legacy.reason,bookDirection:legacy.bookDirection,tapeDirection:legacy.tapeDirection,
    takerShare:legacy.takerShare,midChangeBps:legacy.midChangeBps},
   coherent:{eligible:coherent.eligible&&!quoteRejection,reasons:[...coherent.reasons,...(quoteRejection?[quoteRejection]:[])],validationReason:coherent.validationReason,window:coherent.window,
    overall:coherent.overall,halves:coherent.halves,quoteResponse:coherent.quoteResponse},
   staticRiskSizing:{basis:'counterfactual_unchanged_1_USDT_risk_and_recorded_exchange_filters; account_capacity_unknown',
    stakeUsdt:common.stakeUsdt,...common.sizing},cost:common.cost,
   entryBook:market.orderFlow?.books?.at(-1)??null,markouts:[]});
 }
 return {rows,confirmationState:state};
}

// Signal classification never consumes these future books. The entry side is
// original snapshot-known depth. Exit uses the first observation on/after the
// horizon, never the best future price, and never interpolates across gaps.
export function quoteMarkout(row,path,horizonSeconds){
 const result={horizonSeconds,status:'unavailable',reason:null,netUsdt:null,netBeforeFundingUsdt:null,netAfterReservedFundingUsdt:null};
 const unavailable=reason=>({...result,reason});
 try{
  const long=row.action!=='open-short',q=new D(row.staticRiskSizing?.quantity),cost=row.cost;
  if(!q.gt(0)||cost?.status!=='ok'||!row.entryBook) return unavailable('QUANTITY_OR_COST_UNAVAILABLE');
  if(row.entryBook.at>row.at||row.at-row.entryBook.at>45000)return unavailable('ENTRY_DEPTH_STALE_OR_FUTURE');
  const buy=new D(cost.buyRate),sell=new D(cost.sellRate),slip=new D(cost.slippageBpsPerSide).div(10000),reserve=new D(cost.fundingReserveBps).div(10000);
  const entry=depthExitQuote(row.entryBook,q.toFixed(),long);
  if(entry.status!=='observed_depth_scenario')return unavailable('ENTRY_'+entry.status.toUpperCase());
  const exitQuantity=row.mode==='demo'?q.mul(new D(1).minus(buy)):q;
  const target=row.at+horizonSeconds*1000,samples=path.samples.filter(s=>s.book.at>=row.at).sort((a,b)=>a.book.at-b.book.at),
   exit=samples.find(s=>s.book.at>=target);
  if(row.split==='development'&&target+MAX_GAP>=HOLDOUT)return unavailable('DEVELOPMENT_HORIZON_CROSSES_HOLDOUT');
  if(!exit||exit.book.at-target>MAX_GAP)return unavailable('HORIZON_QUOTE_UNAVAILABLE');
  if(path.issues.some(issue=>!issue.range||issue.range.to>=row.at&&issue.range.from<=exit.book.at))return unavailable('ARCHIVE_EVIDENCE_INCOMPLETE');
  let prior=row.at,maxGapMs=0;
  for(const sample of samples){if(sample.book.at>exit.book.at)break;const gap=sample.book.at-prior;maxGapMs=Math.max(maxGapMs,gap);
   if(gap>MAX_GAP)return unavailable('QUOTE_PATH_GAP');prior=sample.book.at;}
  const quoted=depthExitQuote(exit.book,exitQuantity.toFixed(),!long);
  if(quoted.status!=='observed_depth_scenario')return unavailable('EXIT_'+quoted.status.toUpperCase());
  const entryGross=new D(entry.grossQuote).mul(new D(1).plus(slip.mul(long?1:-1))),
   exitGross=new D(quoted.grossQuote).mul(new D(1).plus(slip.mul(long?-1:1))),
   entryFee=row.mode==='demo'?new D(0):entryGross.mul(long?buy:sell),exitFee=exitGross.mul(long?sell:buy),
   before=row.mode==='demo'?exitGross.minus(exitFee).minus(entryGross):
    exitGross.minus(entryGross).mul(long?1:-1).minus(entryFee).minus(exitFee),reserved=entryGross.mul(reserve),after=before.minus(reserved);
  return {...result,status:'displayed_depth_fee_scenario',entryBookAt:row.entryBook.at,entryDepthAgeMs:row.at-row.entryBook.at,
   exitBookAt:exit.book.at,horizonOvershootMs:exit.book.at-target,maxGapMs,quantity:q.toFixed(),exitQuantity:exitQuantity.toFixed(),
   entryGrossUsdt:entryGross.toFixed(),entryDepthLevels:entry.levelsUsed,exitDepthLevels:quoted.levelsUsed,
   entryFeeQuoteUsdt:entryFee.toFixed(),spotEntryFeeBase:row.mode==='demo'?q.mul(buy).toFixed():null,exitFeeUsdt:exitFee.toFixed(),
   slippageBpsPerSide:cost.slippageBpsPerSide,fundingReserveUsdt:reserved.toFixed(),
   actualFunding:row.mode==='demo'?'not_applicable':'unknown_no_point_in_time_cashflow_ledger',
   netUsdt:row.mode==='demo'?before.toFixed():null,netBeforeFundingUsdt:before.toFixed(),netAfterReservedFundingUsdt:after.toFixed(),
   netBeforeFundingBps:before.div(entryGross).mul(10000).toFixed(),netAfterReservedFundingBps:after.div(entryGross).mul(10000).toFixed(),
   entryRecord:'original_snapshot_known_depth',exitRecordId:exit.recordId};
 }catch{return unavailable('QUOTE_SCENARIO_EVIDENCE_INVALID');}
}

export function commonNonoverlap(rows,horizonSeconds){
 const result=[],next=new Map(),selectedAt=new Map();
 for(const row of [...rows].sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key))){
  if(!ARMS.some(arm=>row.arms[arm]))continue;
  const key=row.mode+':'+row.pair;
  if(selectedAt.get(key)===row.at){result.push(row);continue;}
  if(row.at<(next.get(key)??0))continue;
  result.push(row);selectedAt.set(key,row.at);next.set(key,row.at+horizonSeconds*1000+MAX_GAP);
 }
 return result;
}
function outcomeSummary(rows,horizonSeconds){
 const marks=rows.map(row=>row.markouts.find(m=>m.horizonSeconds===horizonSeconds)),known=marks.filter(m=>m?.status==='displayed_depth_fee_scenario'),missing=counts(marks.filter(m=>m?.status!=='displayed_depth_fee_scenario').map(m=>[m?.reason??'NOT_EVALUATED']));
 const mean=field=>known.length?known.reduce((sum,m)=>sum.plus(m[field]),new D(0)).div(known.length).toFixed(6):null;
 return {selected:rows.length,observed:known.length,missing:rows.length-known.length,missingReasons:missing,
  meanNetBeforeFundingBps:mean('netBeforeFundingBps'),meanNetAfterReservedFundingBps:mean('netAfterReservedFundingBps'),
  positiveReservedCostScenarios:known.filter(m=>new D(m.netAfterReservedFundingUsdt).gt(0)).length,
  nonPositiveReservedCostScenarios:known.filter(m=>new D(m.netAfterReservedFundingUsdt).lte(0)).length,
  actualWinRate:null,actualNetPnl:null};
}
export function summarizeCoreRows(rows){
 const reports=[];
 for(const mode of MODES)for(const split of ['development','holdout']){
  const scoped=rows.filter(r=>r.mode===mode&&r.split===split),cycles=[...new Set(scoped.map(r=>r.snapshotId))];
  const summary={mode,split,cycles:cycles.length,candidateDirections:scoped.length,
   commonPassed:scoped.filter(r=>r.common.eligible).length,arms:{},
   commonBlockers:counts(scoped.map(r=>r.common.reasons)),legacyBlockers:counts(scoped.map(r=>r.legacy.reason?[r.legacy.reason]:[])),
   coherentBlockers:counts(scoped.map(r=>r.coherent.reasons)),
   newOnlyVsLegacyTwo:scoped.filter(r=>r.arms.coherent&&!r.arms.legacyTwo).length,
   sharedWithLegacyTwo:scoped.filter(r=>r.arms.coherent&&r.arms.legacyTwo).length,
   legacyTwoOnly:scoped.filter(r=>!r.arms.coherent&&r.arms.legacyTwo).length,markouts:[]};
  for(const arm of ARMS)summary.arms[arm]={candidateDirections:scoped.filter(r=>r.arms[arm]).length,
   cyclesWithCandidate:new Set(scoped.filter(r=>r.arms[arm]).map(r=>r.snapshotId)).size};
  for(const seconds of HORIZONS)for(const sampling of ['all','common_nonoverlap','per_group_nonoverlap']){
   const selected=sampling==='common_nonoverlap'?commonNonoverlap(scoped,seconds):scoped;
   const groups={...Object.fromEntries(ARMS.map(arm=>[arm,selected.filter(r=>r.arms[arm])])),
    shared:selected.filter(r=>r.arms.coherent&&r.arms.legacyTwo),newOnly:selected.filter(r=>r.arms.coherent&&!r.arms.legacyTwo),
    legacyOnly:selected.filter(r=>!r.arms.coherent&&r.arms.legacyTwo)};
   summary.markouts.push({horizonSeconds:seconds,sampling,groups:Object.fromEntries(Object.entries(groups).map(([key,value])=>[key,outcomeSummary(sampling==='per_group_nonoverlap'?commonNonoverlap(value,seconds):value,seconds)]))});
  }
  reports.push(summary);
 }
 return reports;
}

export async function collectCoreEntryReview({root=ROOT,progress=()=>{}}={}){
 const policyRaw=await readFile(join(root,'config/policy.json'),'utf8'),costRaw=await readFile(join(root,'config/costs.json'),'utf8'),
  rawPolicy=JSON.parse(policyRaw),costConfig=JSON.parse(costRaw),signalFile=new URL('../src/kev-entry-signal.mjs',import.meta.url),signalSource=await readFile(signalFile),
  quoteContractFile=new URL('../src/kev-entry-contract.mjs',import.meta.url),quoteContractSource=await readFile(quoteContractFile),reviewSource=await readFile(fileURLToPath(import.meta.url)),
  rows=[],sources={},archives={};
 for(const mode of MODES){
  const directory=join(root,'local',mode,'runs'),inventory=await readSnapshotInventory(directory),policy=modePolicy(rawPolicy,mode);
  sources[mode]={directory,inventorySnapshots:inventory.inventorySnapshots,discoveryIssues:inventory.issues,selectedFiles:[],outOfScope:0,invalid:[]};
  let state=null;
  for(const item of inventory.selected){
   try{
    const raw=await readFile(join(directory,item.file),'utf8'),snapshot=JSON.parse(raw),created=Date.parse(snapshot.createdAt);
    if(snapshot.mode!==mode||snapshot.purpose==='execution_probe'||snapshot.timeframe!=='order-flow'||created<FROM-60000||created>=TO){sources[mode].outOfScope++;continue;}
    const evaluated=evaluateCoreSnapshot(snapshot,{policy,costConfig,confirmationState:state});state=evaluated.confirmationState;
    sources[mode].selectedFiles.push({file:item.file,id:snapshot.id,createdAt:snapshot.createdAt,sha256:sha(raw),preRoll:created<FROM});
    if(created>=FROM)rows.push(...evaluated.rows.map(row=>({...row,snapshotSha256:sha(raw)})));
   }catch(error){sources[mode].invalid.push({file:item.file,reason:error.code??error.message});}
  }
  progress({stage:'classified',mode,files:sources[mode].selectedFiles.length,summary:summarizeCoreRows(rows).filter(s=>s.mode===mode).map(({markouts,...rest})=>rest)});
  const archiveDir=join(root,'local',mode,'quote-path-research'),names=(await readdir(archiveDir)).filter(n=>/^quotes-.*\.jsonl$/.test(n)).sort(),files=[];
  for(const name of names)files.push({name,text:await readFile(join(archiveDir,name),'utf8')});
  archives[mode]={directory:archiveDir,files:files.map(f=>({name:f.name,sha256:sha(f.text),bytes:Buffer.byteLength(f.text)})),pairs:{}};
  for(const pair of [...new Set(rows.filter(row=>row.mode===mode).map(row=>row.pair))]){
   const decoded=decodeKevQuoteArchive({mode,pair,archiveFiles:files,asOf:TO+900000+MAX_GAP}),seen=new Map(),issues=[...decoded.issues];
   for(const item of decoded.snapshots){
    const book=item.snapshot.markets[0].orderFlow.books[0],old=seen.get(book.at);
    if(old&&JSON.stringify(old.book)!==JSON.stringify(book))issues.push({reason:'CONFLICTING_SAME_TIME_DEPTH',range:{from:book.at,to:book.at}});
    else if(!old)seen.set(book.at,{book,recordId:item.sha256});
   }
   const path={samples:[...seen.values()].sort((a,b)=>a.book.at-b.book.at),issues};
   archives[mode].pairs[pair]={samples:path.samples.length,firstAt:path.samples[0]?.book.at??null,lastAt:path.samples.at(-1)?.book.at??null,issues};
   for(const row of rows.filter(r=>r.mode===mode&&r.pair===pair&&ARMS.some(arm=>r.arms[arm])))row.markouts=HORIZONS.map(seconds=>quoteMarkout(row,path,seconds));
  }
 }
 if(!signalSource.equals(await readFile(signalFile)))throw Error('FROZEN_SIGNAL_SOURCE_CHANGED_DURING_REVIEW');
 if(!quoteContractSource.equals(await readFile(quoteContractFile)))throw Error('FROZEN_QUOTE_CONTRACT_CHANGED_DURING_REVIEW');
 return {version:'kev-core-entry-fixed-window-review-v1',readOnly:true,window:REVIEW_WINDOW,policy:KEV_ENTRY_SIGNAL_POLICY,
  frozenSignalSourceSha256:sha(signalSource),quoteContractSourceSha256:sha(quoteContractSource),reviewSourceSha256:sha(reviewSource),configSha256:{policy:sha(policyRaw),costs:sha(costRaw)},
  evidenceScope:'Signal classification at original completedAt; snapshot.createdAt selects cohort; 1 minute pre-roll; last hour fixed holdout.',
  accountConstraints:'Unavailable counterfactual account capacity, concurrent positions, portfolio conflict and recent-loss cooldown. Common static checks do not establish native entry eligibility.',
  outcomeScope:'Original known five-level entry depth; first archived exit quote at/after300/600/900s with<=20s delay; complete sampled path gaps<=20s; fees once; two-sided original5bps reserve; funding cashflows unknown for futures.',
  limitations:['Not orders, fills, actual win rate or portfolio PnL. No calibrated forecast or positive expectancy proof.',
   'Counterfactual quantity comes from unchanged1USDT risk budget and recorded exchange filters; new-only candidates have no actual filled quantity.',
   'Static-risk comparison omits account capacity, Kev choice/review latency and native execution outcomes. Replay two-minute confirmation is not recorded postreview confirmation state.',
   'Displayed liquidity can disappear. Spot BUY fee reduces exit base quantity once; Futures funding reserve is a scenario, not verified funding.',
   'Price markouts ignore stop/target/trailing/harvest exits and do not simulate complete trade paths. Missing data remains missing.',
   'Common nonoverlap uses the chronological union of all arms by mode/pair, independent of future outcomes, holding out horizon+20s; cross-pair portfolio overlap remains.',
   'Per-group nonoverlap is also shown because earlier single-cycle opportunities can preempt every two-minute opportunity in the common union; those per-group averages are not paired entry comparisons.',
   'Development markouts whose horizon+20s reaches the holdout boundary are unavailable, preventing development outcomes from using held-out prices.',
   'Last-hour holdout is chronologically separate but not claimed never previously viewed; frozen parameters were not tuned to these outcomes.'],
  sources,archives,summaries:summarizeCoreRows(rows),rows:rows.map(({entryBook,...row})=>row)};
}
export async function main(argv=process.argv.slice(2)){
 if(argv.length!==2||argv[0]!=='--root')throw Error('USAGE: kev-core-entry-review.mjs --root ROOT');
 const report=await collectCoreEntryReview({root:resolve(argv[1]),progress:value=>process.stderr.write(JSON.stringify(value)+'\n')});
 process.stdout.write(JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
