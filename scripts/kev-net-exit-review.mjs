// Read-only current-goal comparison. No trading client mutation, native policy
// activation, goal update or order submission exists in this tool.
import {readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {buildKevLossReview,loadKevLossReviewInput} from './kev-loss-review.mjs';
import {compareKevNetExitReplay} from '../src/kev-net-exit-replay.mjs';

const MODES=['demo','demo-futures'];
const SCENARIOS=['0','5','10'];
const sha=value=>createHash('sha256').update(value).digest('hex');

export function summarizeNetExitComparisons(results){
 const good=scenario=>scenario?.comparison?.status==='indicative_comparison'&&
  ['baseline','staged'].every(policy=>{
   const arm=scenario.comparison.results.filter(r=>r.policy===policy);
   try{return arm.length===1&&arm[0].status==='indicative_displayed_depth_simulation'&&
    typeof arm[0].exit?.netUsdt==='string'&&new Decimal(arm[0].exit.netUsdt).isFinite()&&
    Number.isSafeInteger(arm[0].exit.at)&&arm[0].exit.at>0;}catch{return false;}
  });
 const keys=results.map(r=>r.key);
 if(new Set(keys).size!==keys.length)throw Error('DUPLICATE_REPLAY_TRADE');
 const common=results.filter(row=>row.scenarios.length===SCENARIOS.length&&SCENARIOS.every(bps=>{
  const matched=row.scenarios.filter(s=>s.adverseSlippageBps===bps);return matched.length===1&&good(matched[0]);
 }));
 const stats=rows=>{
  if(!rows.length)return {observedScenarios:0,netUsdt:null,positiveNet:0,nonPositiveNet:0,positiveNetFraction:null,
   profitFactor:null,maxDrawdownOfClosedScenarioNetUsdt:null,exitReasons:{}};
  let total=new Decimal(0),gains=new Decimal(0),losses=new Decimal(0),peak=new Decimal(0),drawdown=new Decimal(0),wins=0;
  const exitReasons={};
  for(const exit of [...rows].sort((a,b)=>a.at-b.at)){
   const n=new Decimal(exit.netUsdt);total=total.plus(n);if(n.gt(0)){wins++;gains=gains.plus(n);}else losses=losses.minus(n);
   peak=Decimal.max(peak,total);drawdown=Decimal.max(drawdown,peak.minus(total));
   exitReasons[exit.reason]=(exitReasons[exit.reason]??0)+1;
  }
  return {observedScenarios:rows.length,netUsdt:total.toFixed(),positiveNet:wins,nonPositiveNet:rows.length-wins,
   positiveNetFraction:wins/rows.length,profitFactor:losses.gt(0)?gains.div(losses).toNumber():null,
   maxDrawdownOfClosedScenarioNetUsdt:drawdown.toFixed(),exitReasons};
 };
 const summaries=[];
 for(const adverseSlippageBps of SCENARIOS)for(const mode of [...MODES,'combined']){
  const matched=common.filter(r=>mode==='combined'||r.mode===mode),arms={};
  for(const policy of ['baseline','staged'])arms[policy]=stats(matched.map(r=>r.scenarios.find(s=>s.adverseSlippageBps===adverseSlippageBps)
   .comparison.results.find(a=>a.policy===policy).exit));
  summaries.push({mode,adverseSlippageBps,arms,stagedMinusBaselineNetUsdt:matched.length?
   new Decimal(arms.staged.netUsdt).minus(arms.baseline.netUsdt).toFixed():null});
 }
 return {basis:'common_complete_paths_across_all_three_slippage_arms',submittedTrades:results.length,
  matchedTrades:common.length,matchedKeys:common.map(r=>r.key),unavailableKeys:results.filter(r=>!common.includes(r)).map(r=>r.key),
  completeForSubmittedTrades:results.length>0&&common.length===results.length,summaries,
  label:'Indicative conditional scenarios, not actual fills, actual win rate, expected return or full portfolio drawdown.'};
}

// All slippage arms use exactly the same set. A missing path must not disappear
// from the denominator or be converted into a winning/no-loss simulation.
export function buildNetExitReview({input,archives,fundingByTrade={},replay=compareKevNetExitReplay}){
 const actual=buildKevLossReview(input),results=[],excluded=[];
 for(const row of actual.rows){
  const key=`${row.mode}:${row.tradeId}`;
  if(row.kevApprovalVerified!==true){excluded.push({key,reason:'ORIGINAL_KEV_APPROVAL_UNVERIFIED'});continue;}
  const history=input.histories[row.mode].trades.filter(t=>String(t.trade_id)===String(row.tradeId));
  if(history.length!==1){excluded.push({key,reason:'TRADE_ID_NOT_UNIQUE'});continue;}
  let plan;try{plan=JSON.parse(input.artifacts[row.mode][history[0].enter_tag.slice(6)].planRaw);}catch{}
  const protection=plan?.profitProtection;
  if(plan?.ruleVersion!=='kev-order-flow-v1'||plan.entryPolicyVersion!=='kev-order-flow-v1'||
   plan.entrySignalEngine!=='kev_order_flow'||plan.purpose!=='strategy'||plan.timeframe!=='order-flow'||
   plan.isShort!==history[0].is_short||plan.pair!==history[0].pair||plan.tag!==history[0].enter_tag||
   plan.stopFraction!==.005||plan.targetFraction!==.015||plan.maxHoldingSeconds!==900||plan.maxHoldingBars!==0||plan.riskBudgetUsdt!==1||
   !protection||Object.keys(protection).sort().join('|')!=='givebackNetUsdt|riskMultiple|triggerNetUsdt|version'||
   protection.version!=='net-profit-trail-v1'||protection.triggerNetUsdt!==.5||protection.givebackNetUsdt!==.25||protection.riskMultiple!==.5||
   ['atrTimeframe','candleBoundary','model','adaptiveParameters'].some(key=>Object.hasOwn(plan,key))||
   Object.keys(plan).some(key=>/exit|stop|target|holding|profitProtection/i.test(key)&&
    !['stopFraction','targetFraction','maxHoldingSeconds','maxHoldingBars','profitProtection','stopPrice','targetPrice'].includes(key))){
   excluded.push({key,reason:'ORIGINAL_EXIT_PLAN_NOT_COMPARABLE'});continue;
  }
  const scenarios=SCENARIOS.map(adverseSlippageBps=>({adverseSlippageBps,
   comparison:archives[row.mode]?.error?{status:'unavailable',reason:archives[row.mode].error,results:[],comparison:null}:
    replay({mode:row.mode,trade:history[0],archiveFiles:archives[row.mode]?.files??[],
     observedAt:input.observedAt,adverseSlippageBps,fundingEvidence:fundingByTrade[key]??null})}));
  results.push({key,mode:row.mode,tradeId:row.tradeId,pair:row.pair,isOpen:row.isOpen,
   originalKevApprovalVerified:true,actualNetUsdt:row.netUsdt,actualExit:row.exitReason,scenarios});
 }
 const comparisonSummary=summarizeNetExitComparisons(results);
 comparisonSummary.activeGoalEntries=actual.totalEntries;
 comparisonSummary.excludedEntries=excluded.length;
 comparisonSummary.completeForActiveGoal=actual.evidenceComplete&&excluded.length===0&&
  comparisonSummary.completeForSubmittedTrades&&comparisonSummary.matchedTrades===actual.totalEntries;
 return {version:'kev-net-exit-review-v1',observedAt:input.observedAt,readOnly:true,
  executionChanged:false,promotionAuthorized:false,
  goal:{id:actual.goalId,startedAt:actual.startedAt,deadline:actual.deadline,target:actual.target},
  actual:{evidenceComplete:actual.evidenceComplete,totalEntries:actual.totalEntries,summary:actual.summary,warnings:actual.warnings},
  experiment:{policy:'kev-staged-net-targets-v1',middleNetTargetUsdt:'1',lateNetTargetBps:'10',
   stagesSeconds:[300,600,900],middleTargetBasis:'configured_1_USDT_risk_budget_not_realized_filled_risk',
   entryBasis:'same_original_approved_actual_fills',exitBasis:'next_observed_quantity_aware_depth_scenario',
   slippageBpsPerExit:SCENARIOS,scope:'conditional_on_actual_entries_not_a_full_strategy_backtest'},
  results,excluded,comparisonSummary,
  activation:{status:'not_promoted',reason:'Research comparisons never activate trading. Both-mode complete evidence and prospective outcome review are required.'},
  limitations:[
   'Sampled displayed depth can disappear; modeled exits are not executed fills or filled-trade win rates.',
   'Funding, missing paths, invalid evidence and unavailable outcomes remain unknown.',
   'Changing exit timing may change later entry eligibility and portfolio capacity; this conditional comparison does not model that.',
   'Original losses and the active target are unchanged. More profitable scenarios do not prove future profitability.'
  ]};
}

async function readArchives(mode,root){
 const directory=join(root,'local',mode,'quote-path-research');
 try{
  const names=(await readdir(directory)).filter(n=>/^quotes-\d+-[a-f0-9-]+-\d+\.jsonl$/.test(n)).sort();
  let total=0;const files=[];
  for(const name of names){
   const path=join(directory,name),metadata=await stat(path);total+=metadata.size;
   if(total>512*1024*1024)throw Error('ARCHIVE_READ_BUDGET_EXCEEDED');
   const raw=await readFile(path);
   if(raw.length>512*1024*1024||total-metadata.size+raw.length>512*1024*1024)throw Error('ARCHIVE_READ_BUDGET_EXCEEDED');
   total+=raw.length-metadata.size;
   files.push({name,text:raw.toString('utf8'),sha256:sha(raw),bytes:raw.length});
  }
  return {files,directory,totalBytes:total};
 }catch(error){return {files:[],directory,error:error.code==='ENOENT'?'QUOTE_ARCHIVE_MISSING':
   error.message==='ARCHIVE_READ_BUDGET_EXCEEDED'?error.message:'QUOTE_ARCHIVE_READ_FAILED'};}
}

export async function collectNetExitReview({root=ROOT,fundingByTrade={}}={}){
 const activePath=join(root,'local/trade-goals/active.json'),activeRaw=await readFile(activePath,'utf8'),active=JSON.parse(activeRaw);
 const goalPath=resolve(root,active.goalPath),goalRaw=await readFile(goalPath,'utf8');
 const input=await loadKevLossReviewInput([],{root});
 if(JSON.stringify(input.goal)!==JSON.stringify(JSON.parse(goalRaw)))throw Error('ACTIVE_GOAL_CHANGED_DURING_REVIEW');
 const modes=await Promise.all(MODES.map(mode=>readArchives(mode,root))),archives=Object.fromEntries(MODES.map((mode,i)=>[mode,modes[i]]));
 if(!fundingByTrade||Array.isArray(fundingByTrade)||typeof fundingByTrade!=='object')throw Error('FUNDING_LEDGER_INVALID');
 const report=buildNetExitReview({input,archives,fundingByTrade});
 if(await readFile(activePath,'utf8')!==activeRaw||await readFile(goalPath,'utf8')!==goalRaw)throw Error('ACTIVE_GOAL_CHANGED_DURING_REVIEW');
 report.sources={activeSha256:sha(activeRaw),goalSha256:sha(goalRaw),
  histories:Object.fromEntries(MODES.map(mode=>[mode,{sha256:sha(JSON.stringify(input.histories[mode])),observedAt:input.histories[mode].observedAt}])),
  archives:Object.fromEntries(MODES.map(mode=>[mode,{directory:archives[mode].directory,error:archives[mode].error??null,
   files:archives[mode].files.map(({name,sha256,bytes})=>({name,sha256,bytes}))}]))};
 return report;
}

export async function main(argv=process.argv.slice(2)){
 if(argv.length&&!(argv.length===2&&argv[0]==='--funding-ledger'))throw Error('USAGE: kev-net-exit-review.mjs [--funding-ledger FILE]');
 const fundingByTrade=argv.length?JSON.parse(await readFile(resolve(ROOT,argv[1]),'utf8')):{};
 const report=await collectNetExitReview({fundingByTrade});console.log(JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
