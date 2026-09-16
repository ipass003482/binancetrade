import {recordedEntryId} from '../src/entry-identity.mjs';
// Read-only Demo accounting. This helper never submits, reconciles or retries orders.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {readJson,writeJson,journalRead} from '../src/io.mjs';
import {evaluatePerformance} from '../src/performance.mjs';

const MODES=['demo','demo-futures'],ENTRY=new Set(['buy','open-long','open-short']);
const GOAL_RULE_VERSIONS=new Set(['kronos-forward-v11','kronos-direction-v12']);
const SETTLED=new Set(['submitted','reconciled']),STATUSES=new Set(['pending','unknown','submitted','reconciled','rejected','hold']);
const HEX=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{32}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const key=value=>Number.isSafeInteger(value)&&value>0?String(value):typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:null;
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const digest=value=>createHash('sha256').update(value).digest('hex');
const errorCode=error=>/^[A-Z][A-Z0-9_]{2,80}/.exec(String(error?.code??error?.message??''))?.[0]??'REVIEW_FAILED';
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;

function validateGoal(goal,observedAt){
 const nativeFlow=goal?.entryPolicyVersion==='order-flow-only-v1';
 if(!goal||goal.schemaVersion!==1||goal.source!=='freqtrade-demo'||typeof goal.id!=='string'||!goal.id.length||
  !time(goal.startedAt)||!time(observedAt)||Date.parse(goal.startedAt)>Date.parse(observedAt)||
  !GOAL_RULE_VERSIONS.has(goal.ruleVersion)||(nativeFlow?goal.modelFingerprint!==null:!HEX.test(goal.modelFingerprint??''))||
  !Number.isSafeInteger(goal.targetPerMode)||goal.targetPerMode<1||goal.deadline!==null)
  throw Error('TRADE_GOAL_INVALID');
 for(const mode of MODES){const baseline=goal.modes?.[mode];
  if(!baseline||!Array.isArray(baseline.excludedTradeIds)||baseline.excludedTradeIds.some(id=>!key(id))||
   new Set(baseline.excludedTradeIds.map(key)).size!==baseline.excludedTradeIds.length||
   baseline.baselineTradeCount!==baseline.excludedTradeIds.length)throw Error('TRADE_GOAL_INVALID_BASELINE');
 }
}

function statesFromJournal(journal,observedAt,warnings){
 const groups=new Map();
 for(const [index,row] of journal.entries()){
  if(!row||!ID.test(row.id??'')){warnings.push({code:'INVALID_JOURNAL_RECORD',index});continue;}
  if(!groups.has(row.id))groups.set(row.id,[]);groups.get(row.id).push(row);
 }
 return [...groups].map(([id,rows])=>{
  let merged={},invalid=false,last=-Infinity;
  const pending=rows.filter(row=>row.status==='pending');
  for(const row of rows){
   const at=time(row.at)?Date.parse(row.at):NaN;
   if(!Number.isFinite(at)||at>observedAt||at<last||!STATUSES.has(row.status))invalid=true;
   last=at;
   for(const field of ['tag','pair','action','tradeId','purpose','ruleVersion','snapshotId','model','riskPolicy','strategyFingerprint','entryPolicyVersion','entryRoute','entrySignalEngine','entryEvidence','executionPolicyVersion','executionQualityVersion']){
    if(merged[field]!=null&&row[field]!=null&&canonical(merged[field])!==canonical(row[field]))invalid=true;
   }
   merged={...merged,...row};
  }
  if(pending.length!==1||rows[0]!==pending[0])invalid=true;
  // Execution quality is prospective attribution from the original intent.
  // A later row may repeat it, but cannot introduce, null out or replace it.
  if(pending.length===1&&rows.some(row=>Object.hasOwn(row,'executionQualityVersion')&&
   (!Object.hasOwn(pending[0],'executionQualityVersion')||row.executionQualityVersion!==pending[0].executionQualityVersion)))invalid=true;
  return {id,...merged,pending:pending[0]??null,invalid};
 });
}

function fillEvidence(trade,start,end){
 const expectedSide=trade.is_short?'sell':'buy',orders=Array.isArray(trade.orders)?trade.orders:[];
 const eligible=orders.filter(o=>o?.ft_order_side===expectedSide&&o.ft_is_entry!==false),seen=new Map(),verified=[];
 for(const order of eligible){
  if(typeof order.order_id!=='string'||!order.order_id.length)return {reason:'INVALID_ENTRY_ORDER_ID'};
  const previous=seen.get(order.order_id);
  if(previous&&canonical(previous)!==canonical(order))return {reason:'CONFLICTING_ENTRY_ORDER_ID'};
  if(previous)continue;seen.set(order.order_id,order);
  if(!positive(order.filled))continue;
  const settledPartial=['canceled','cancelled','expired'].includes(order.status)&&positive(order.amount)&&
   typeof order.remaining==='number'&&Number.isFinite(order.remaining)&&order.remaining>=0&&
   order.filled<=order.amount&&Math.abs(order.filled+order.remaining-order.amount)<=Math.max(1e-12,order.amount*1e-10);
  const settledFull=order.status==='closed'&&order.remaining===0;
  if(order.pair!==trade.pair||order.ft_order_tag!==trade.enter_tag||
   !(order.ft_is_entry===true||order.ft_is_entry===undefined)||!(settledFull||settledPartial)||order.is_open!==false||
   !positive(order.cost)||!Number.isSafeInteger(order.order_filled_timestamp)||
   order.order_filled_timestamp<start||order.order_filled_timestamp>end)return {reason:'ENTRY_FILL_NOT_CONFIRMED'};
  verified.push(order);
 }
 return verified.length?{orderIds:verified.map(o=>o.order_id),filledAt:new Date(Math.min(...verified.map(o=>o.order_filled_timestamp))).toISOString()}:
  {reason:'ENTRY_FILL_NOT_CONFIRMED'};
}

function pnl(trades,mode,observedAt){
 const result=evaluatePerformance({trades,mode,observedAt}),open=trades.filter(t=>t.is_open===true);
 const validFloat=value=>{
  if(!(typeof value==='number'||typeof value==='string')||String(value).length>=256||
   !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value))||!Number.isFinite(Number(value)))return false;
  const d=new Decimal(value);return d.isFinite()&&(d.isZero()||(d.e>=-100&&d.e<=100));
 };
 const floatingComplete=open.every(t=>validFloat(t.profit_abs)),sum=open.reduce((s,t)=>validFloat(t.profit_abs)?s.plus(t.profit_abs):s,new Decimal(0));
 return {netRealizedUsdt:result.summary.netRealizedUsdt,netUnrealizedUsdt:floatingComplete?sum.toFixed():null,
  pnlComplete:result.summary.pnlComplete&&floatingComplete,openTrades:open.length,
  closedTrades:trades.filter(t=>t.is_open===false).length,diagnostics:[...result.diagnostics,
   ...(!floatingComplete?[{code:'FLOATING_PNL_UNAVAILABLE'}]:[])]};
}

function reviewMode({goal,history,journal,mode,observedAt}){
 const warnings=[],excluded=[],accepted=[],start=Date.parse(goal.startedAt),end=Date.parse(observedAt);
 const unavailable=reason=>({mode,status:'unavailable',historyObservedAt:history?.observedAt??null,entries:null,openTrades:null,
  closedTrades:null,remaining:null,target:goal.targetPerMode,complete:false,countComplete:false,evidenceComplete:false,
  netRealizedUsdt:null,netUnrealizedUsdt:null,trades:[],excluded,warnings:[...warnings,{code:reason}]});
 if(history?.source!=='freqtrade-demo'||history?.historyComplete!==true||!Array.isArray(history?.trades)||
  !time(history?.observedAt)||Date.parse(history.observedAt)<start||Date.parse(history.observedAt)>end)
  return unavailable(history?.error??'HISTORY_UNAVAILABLE_OR_UNATTESTED');
 if(!Array.isArray(journal))return unavailable('JOURNAL_UNAVAILABLE');
 for(const warning of history.warnings??[])warnings.push({code:'SOURCE_WARNING',sourceWarning:warning});
 const states=statesFromJournal(journal,end,warnings),baseline=new Set(goal.modes[mode].excludedTradeIds.map(key));
 const grouped=new Map();
 for(const [index,trade] of history.trades.entries()){
  const id=key(trade?.trade_id);
  if(!id){warnings.push({code:'INVALID_HISTORY_TRADE_ID',index});continue;}
  if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(trade);
 }
 for(const id of baseline)if(!grouped.has(id))warnings.push({code:'BASELINE_HISTORY_MISSING',tradeId:id});
 const unique=[];
 for(const [id,records] of grouped){
  if(records.length>1){warnings.push({code:'DUPLICATE_HISTORY_TRADE_ID',tradeId:id});
   if(records.some(t=>canonical(t)!==canonical(records[0]))){excluded.push({tradeId:id,reason:'CONFLICTING_HISTORY_TRADE_ID'});continue;}}
  unique.push(records[0]);
 }
 for(const trade of unique){
  const id=key(trade.trade_id),ignore=reason=>excluded.push({tradeId:id,reason});
  if(baseline.has(id)){ignore('BASELINE_TRADE');continue;}
  if(Number.isSafeInteger(trade.open_timestamp)&&trade.open_timestamp<start){ignore('OPENED_BEFORE_GOAL');continue;}
  if(!Number.isSafeInteger(trade.open_timestamp)||trade.open_timestamp>end){ignore('INVALID_OPEN_TIMESTAMP');warnings.push({code:'INVALID_OPEN_TIMESTAMP',tradeId:id});continue;}
  const matches=states.filter(s=>ENTRY.has(s.action)&&(s.tag===trade.enter_tag||key(s.tradeId)===id));
  if(matches.length!==1){const code=matches.length?'AMBIGUOUS_ENTRY_JOURNAL':'UNATTRIBUTED_GOAL_TRADE';ignore(code);warnings.push({code,tradeId:id});continue;}
  const state=matches[0],pending=state.pending;
  if(pending?.purpose==='execution_probe'){ignore('EXECUTION_PROBE');continue;}
  if(pending&&pending.ruleVersion!==goal.ruleVersion){ignore('OTHER_STRATEGY_VERSION');continue;}
  const flowOnly=pending?.entryPolicyVersion==='order-flow-only-v1';
  const nativeFlow=goal.entryPolicyVersion==='order-flow-only-v1';
  if(nativeFlow&&!flowOnly){ignore('OTHER_ENTRY_POLICY');continue;}
  if(flowOnly&&!nativeFlow&&!goal.allowOrderFlowOnly){ignore('OTHER_ENTRY_ENGINE');continue;}
  let reason=null;
  const expectedAction=mode==='demo'?'buy':trade.is_short?'open-short':'open-long';
  if(state.invalid||!pending||pending.purpose!=='strategy'||!SETTLED.has(state.status)||
   key(state.tradeId)!==id||state.tag!==trade.enter_tag||state.pair!==trade.pair||state.action!==expectedAction||
   pending.tag!=='codex-'+state.id||Date.parse(pending.at)<start)reason='ENTRY_SUBMISSION_NOT_CONFIRMED';
  else if(!UUID.test(pending.snapshotId??'')||recordedEntryId(pending)!==state.id)reason='ENTRY_IDENTITY_MISMATCH';
  else if(flowOnly?(pending.model!=null||pending.entrySignalEngine!=='sampled_order_flow'||pending.entryRoute!=='order-flow'||
   pending.entryEvidence?.version!=='order-flow-evidence-v1'||pending.entryEvidence?.usedForEntryDecision!==true||
   pending.entryEvidence?.snapshotId!==pending.snapshotId||!HEX.test(pending.entryEvidence?.proofSha256??'')||!pending.riskPolicy):
   (pending.model?.modelFingerprint!==goal.modelFingerprint||pending.model?.usedForEntryDecision!==true||
   !HEX.test(pending.model?.predictionSha256??'')||pending.model.snapshotId!==pending.snapshotId||
   !time(pending.model.issuedAt)||Date.parse(pending.model.issuedAt)>Date.parse(pending.at)))reason=flowOnly?'FLOW_ATTRIBUTION_MISMATCH':'MODEL_ATTRIBUTION_MISMATCH';
  else if(['trial_version','strategyVersion','ruleVersion'].some(field=>trade[field]!==undefined&&trade[field]!==goal.ruleVersion))reason='TRADE_VERSION_MISMATCH';
  const validation=evaluatePerformance({trades:[trade],mode,observedAt});
  if(!reason&&validation.diagnostics.length)reason='INVALID_TRADE_EVIDENCE';
  if(!reason&&pending.riskPolicy!==undefined){
   const expected={version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'};
   if(canonical(pending.riskPolicy)!==canonical(expected)||!HEX.test(pending.strategyFingerprint??''))
    reason='RISK_ATTRIBUTION_MISMATCH';
  }
  if(!reason&&pending.entryPolicyVersion==='trend-pullback-flow-v1'&&!['pullback','order-flow'].includes(pending.entryRoute))reason='ENTRY_ROUTE_ATTRIBUTION_MISMATCH';
  if(!reason&&pending.entryPolicyVersion!==undefined&&(!['closed-price-momentum-v1','forecast-net-edge-v1','trend-pullback-model-v1','trend-pullback-flow-v1','order-flow-only-v1'].includes(pending.entryPolicyVersion)||!HEX.test(pending.strategyFingerprint??'')))reason='ENTRY_POLICY_ATTRIBUTION_MISMATCH';
  if(!reason&&Object.hasOwn(pending,'executionQualityVersion')&&(mode!=='demo'||!flowOnly||
   !['flow-price-continuation-v1','flow-strength-exit-v1','flow-confirmed-exit-v2'].includes(pending.executionQualityVersion)))reason='EXECUTION_QUALITY_ATTRIBUTION_MISMATCH';
  const fill=fillEvidence(trade,start,end);if(!reason&&fill.reason)reason=fill.reason;
  if(reason){ignore(reason);warnings.push({code:reason,tradeId:id});continue;}
  accepted.push({trade,proof:{tradeId:trade.trade_id,pair:trade.pair,tag:trade.enter_tag,isOpen:trade.is_open,
   direction:trade.is_short?'short':'long',openedAt:new Date(trade.open_timestamp).toISOString(),
   filledAt:fill.filledAt,closedAt:trade.is_open?null:new Date(trade.close_timestamp).toISOString(),
   entryOrderIds:fill.orderIds,journalId:state.id,journalStatus:state.status,entrySignalEngine:pending.entrySignalEngine??'kronos_pretrained',entryEvidence:pending.entryEvidence??null,modelFingerprint:pending.model?.modelFingerprint??null,
   predictionSha256:pending.model?.predictionSha256??null,riskPolicyVersion:pending.riskPolicy?.version??'legacy-unrecorded',
   entryRoute:pending.entryRoute??'legacy-unrecorded',entryPolicyVersion:pending.entryPolicyVersion??(pending.ruleVersion==='kronos-direction-v12'?'direction-only-v12':'legacy-unrecorded'),strategyFingerprint:pending.strategyFingerprint??null,executionPolicyVersion:pending.executionPolicyVersion??'single-entry-cycle',
   executionQualityVersion:mode==='demo-futures'?'not-applicable':pending.executionQualityVersion??'legacy-unrecorded',netRealizedUsdt:trade.is_open?null:String(trade.profit_abs),
   netUnrealizedUsdt:trade.is_open?String(trade.profit_abs):null}});
 }
 for(const state of states){const p=state.pending;
  if(!p||!ENTRY.has(p.action)||p.purpose!=='strategy'||p.ruleVersion!==goal.ruleVersion||Date.parse(p.at)<start)continue;
  if(goal.entryPolicyVersion==='order-flow-only-v1'&&p.entryPolicyVersion!==goal.entryPolicyVersion)continue;
  if(['pending','unknown'].includes(state.status)||state.invalid)warnings.push({code:'UNRESOLVED_OR_INVALID_GOAL_INTENT',journalId:state.id,status:state.status});
  if(SETTLED.has(state.status)&&!unique.some(t=>key(t.trade_id)===key(state.tradeId)&&t.enter_tag===state.tag&&t.pair===state.pair))
   warnings.push({code:'SUBMITTED_TRADE_MISSING',journalId:state.id,tradeId:state.tradeId??null});
 }
 const stats=pnl(accepted.map(v=>v.trade),mode,observedAt),allHistory=pnl(unique,mode,observedAt);
 for(const warning of stats.diagnostics)warnings.push({...warning,scope:'goal'});
 for(const warning of allHistory.diagnostics)warnings.push({...warning,scope:'all_history'});
 const countComplete=warnings.length===0,evidenceComplete=countComplete&&stats.pnlComplete&&allHistory.pnlComplete;
 const entries=accepted.length,complete=evidenceComplete&&entries>=goal.targetPerMode;
 const entryPolicyCohorts=[...new Set(accepted.map(v=>v.proof.entryPolicyVersion))].map(version=>{
  const rows=accepted.filter(v=>v.proof.entryPolicyVersion===version);
  return {entryPolicyVersion:version,entries:rows.length,tradeIds:rows.map(v=>v.trade.trade_id),...pnl(rows.map(v=>v.trade),mode,observedAt)};
 });
 const entryRouteCohorts=[...new Set(accepted.map(v=>v.proof.entryRoute))].map(entryRoute=>{const rows=accepted.filter(v=>v.proof.entryRoute===entryRoute);return {entryRoute,entries:rows.length,tradeIds:rows.map(v=>v.trade.trade_id),...pnl(rows.map(v=>v.trade),mode,observedAt)};});
 const executionQualityCohorts=[...new Set(accepted.map(v=>v.proof.executionQualityVersion))].map(executionQualityVersion=>{
  const rows=accepted.filter(v=>v.proof.executionQualityVersion===executionQualityVersion);
  return {executionQualityVersion,entries:rows.length,tradeIds:rows.map(v=>v.trade.trade_id),...pnl(rows.map(v=>v.trade),mode,observedAt)};
 });
 const riskCohorts=[...new Set(accepted.map(v=>v.proof.riskPolicyVersion))].map(version=>{
  const rows=accepted.filter(v=>v.proof.riskPolicyVersion===version);
  return {riskPolicyVersion:version,entries:rows.length,tradeIds:rows.map(v=>v.trade.trade_id),
   ...pnl(rows.map(v=>v.trade),mode,observedAt)};
 });
 return {mode,status:complete?'complete':evidenceComplete?'collecting':'incomplete_evidence',historyObservedAt:history.observedAt,
  entries,openTrades:stats.openTrades,closedTrades:stats.closedTrades,remaining:Math.max(0,goal.targetPerMode-entries),target:goal.targetPerMode,
  complete,countComplete,evidenceComplete,netRealizedUsdt:stats.netRealizedUsdt,netUnrealizedUsdt:stats.netUnrealizedUsdt,
  pnlComplete:stats.pnlComplete,riskCohorts,entryPolicyCohorts,entryRouteCohorts,executionQualityCohorts,allHistory:{...allHistory,inputTrades:history.trades.length},trades:accepted.map(v=>v.proof),excluded,warnings};
}

/** Complete, identity-attested histories are wrappers, never a bare historical array:
 * histories[mode] = {source:'freqtrade-demo',historyComplete:true,observedAt,trades}.
 * journals[mode] is the existing parsed append-only orders.jsonl. Pure: no I/O.
 */
export function buildTradeGoalReview({goal,histories={},journals={},observedAt}={}){
 validateGoal(goal,observedAt);
 const modes=Object.fromEntries(MODES.map(mode=>[mode,reviewMode({goal,history:histories[mode],journal:journals[mode],mode,observedAt})]));
 const completed=MODES.every(mode=>modes[mode].complete);
 return {schemaVersion:1,source:'freqtrade-demo-trade-goal-review',goalId:goal.id,observedAt,startedAt:goal.startedAt,
  ruleVersion:goal.ruleVersion,modelFingerprint:goal.modelFingerprint,...(goal.entryPolicyVersion==='order-flow-only-v1'?{entryPolicyVersion:goal.entryPolicyVersion}:{}),targetPerMode:goal.targetPerMode,deadline:null,
  status:completed?'complete':MODES.some(mode=>modes[mode].status==='unavailable')?'unavailable':
   MODES.some(mode=>!modes[mode].evidenceComplete)?'incomplete_evidence':'collecting',completed,modes,
  countDefinition:'One newly filled strategy entry per mode and trade_id; its exit and split fills do not add entries.',
  profitMethod:'Closed profit_abs is engine-reported net including its recorded fees/funding; do not subtract fees again. Open profit_abs is floating and reported separately.',
  baselinePolicy:'Old trades and losses remain in allHistory and the unchanged shared portfolio; excluded IDs are only a count baseline.',
  promotionAuthorized:false,executionChanged:false,
  limitations:[goal.targetPerMode+' entries in each mode is an observation target, not a daily limit or a profitability validation.',
   'Still-open partial orders wait for settlement; terminal canceled/expired orders with verified actual fills count once. This review never sends, retries, closes or reconciles orders.',
   'Missing, conflicting or incomplete evidence prevents completion; count values are verified observations, not a promise of fill frequency.']};
}

export function tradeGoalMarkdown(report){
 const cell=value=>String(value??'unavailable').replace(/[|\r\n]/g,' ');
 const versionLabel={'kronos-forward-v11':'v11','kronos-direction-v12':'v12'}[report.ruleVersion]??'版本未確認';
 const target=report.targetPerMode??30;
 const lines=[`# ${versionLabel} DEMO 各 ${cell(target)} 次交易追蹤`,'',`資料時間：${report.observedAt}；狀態：${report.status}。`,
  `任務起點：${report.startedAt??'unavailable'}；持續至現貨、合約各 ${cell(target)} 次新的策略開倉成交。`,
  '', '每個模式的一筆 trade_id 只計一次；平倉、拆分成交、舊交易、測試探針、HOLD 與未成交委託不加次數。',
  '', '| 模式 | 已成交／目標 | 持倉 | 已平倉 | 本輪已實現淨損益 USDT | 本輪浮動損益 USDT | 證據狀態 |',
  '|---|---:|---:|---:|---:|---:|---|'];
 for(const mode of MODES){const r=report.modes?.[mode];
  lines.push('| '+[mode,r?`${r.entries??'unavailable'} / ${r.target}`:'unavailable',r?.openTrades,r?.closedTrades,
   r?.netRealizedUsdt,r?.netUnrealizedUsdt,r?.status??'unavailable'].map(cell).join(' | ')+' |');
 }
 for(const mode of MODES){const r=report.modes?.[mode];
  if(r?.warnings?.length)lines.push('',`${mode} 證據警示：${[...new Set(r.warnings.map(w=>w.code))].map(cell).join('、')}。`);
  for(const c of r?.entryPolicyCohorts??[])lines.push('',`${mode} / entry ${cell(c.entryPolicyVersion)}: ${c.entries} entries; realized ${cell(c.netRealizedUsdt)} USDT; unrealized ${cell(c.netUnrealizedUsdt)} USDT. Actual fills only; old losses retained.`);
  for(const c of r?.entryRouteCohorts??[])if(c.entryRoute!=='legacy-unrecorded')lines.push('',`${mode} / route ${cell(c.entryRoute)}: ${c.entries} entries; realized ${cell(c.netRealizedUsdt)} USDT; unrealized ${cell(c.netUnrealizedUsdt)} USDT.`);
  for(const c of r?.executionQualityCohorts??[])lines.push('',`${mode} / 策略調整 ${cell(c.executionQualityVersion)}：${c.entries} 筆（trade_id：${c.tradeIds.map(cell).join(', ')}）；已實現 ${cell(c.netRealizedUsdt)} USDT，浮動 ${cell(c.netUnrealizedUsdt)} USDT。legacy-unrecorded 表示原始委託未記錄新版檢查；not-applicable 表示合約不套用。只依原始歸因分組，不回填舊成交。`);
  for(const c of r?.riskCohorts??[])lines.push('',`${mode} / ${cell(c.riskPolicyVersion)}：${c.entries} 筆；已實現 ${cell(c.netRealizedUsdt)} USDT，浮動 ${cell(c.netUnrealizedUsdt)} USDT。修改前後分列，總次數及舊損失不重設。`);
 }
 lines.push('','已實現欄使用引擎記錄的 profit_abs（含其已記錄費用／資金費），不重扣手續費；浮動損益分列。',
  '舊交易與虧損完整保留於 JSON 的 allHistory 與原共同資金帳；本輪起點不重設本金或策略試驗。',
  `${cell(target)} 次是觀察目標，並非每日開倉上限；達標不自動停止交易或啟用真金。`);
 if(report.error)lines.push('',`本次讀取失敗：${cell(report.error)}；前次結果不視為目前狀態。`);
 return lines.join('\n')+'\n';
}

export async function main(argv=process.argv.slice(2)){
 let directory=join(ROOT,'local/trade-goals/2026-09-14-v12-30-each');
 try{
  if(argv.length&&!(argv.length===2&&argv[0]==='--goal'))throw Error('USAGE_EXPECTED_GOAL_PATH');
  const goalPath=argv.length?resolve(argv[1]):join(directory,'goal.json');directory=dirname(goalPath);
  const goal=await readJson(goalPath),histories={},journals={};validateGoal(goal,new Date().toISOString());
  const [{loadPolicy},{FreqtradeClient}]=await Promise.all([import('../src/config.mjs'),import('../src/freqtrade.mjs')]);
  await Promise.all(MODES.map(async mode=>{
   try{
    const policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(ROOT,'local',mode,'api-auth.json')));
    const trades=await client.history();
    histories[mode]={source:'freqtrade-demo',historyComplete:true,observedAt:new Date().toISOString(),trades};
    journals[mode]=await journalRead(join(ROOT,'local',mode,'orders.jsonl'));
   }catch(error){histories[mode]={source:'freqtrade-demo',historyComplete:false,observedAt:new Date().toISOString(),error:errorCode(error)};}
  }));
  const input={goal,histories,journals,observedAt:new Date().toISOString()},report=buildTradeGoalReview(input);
  const archive=join(directory,'reviews',input.observedAt.replace(/[:.]/g,'-')+'-'+randomUUID());
  await mkdir(archive,{recursive:true});
  const bytes=Buffer.from(JSON.stringify(input,null,2)+'\n'),source=await readFile(fileURLToPath(import.meta.url)),performance=await readFile(join(ROOT,'src/performance.mjs'));
  const identitySource=await readFile(join(ROOT,'src/entry-identity.mjs'));
  await writeFile(join(archive,'entry-identity.mjs'),identitySource,{flag:'wx'});
  report.archive={directory:archive,entryIdentitySourceSha256:digest(identitySource),inputSha256:digest(bytes),reviewSourceSha256:digest(source),performanceSourceSha256:digest(performance)};
  await writeFile(join(archive,'input.json'),bytes,{flag:'wx',mode:0o600});
  await writeFile(join(archive,'trade-goal-review.mjs'),source,{flag:'wx'});
  await writeFile(join(archive,'performance.mjs'),performance,{flag:'wx'});
  await writeFile(join(archive,'review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await writeFile(join(archive,'review.md'),tradeGoalMarkdown(report),{flag:'wx'});
  await writeJson(join(directory,'latest.json'),report);
  await writeFile(join(directory,'latest.md'),tradeGoalMarkdown(report));
  console.log(JSON.stringify({observedAt:report.observedAt,status:report.status,completed:report.completed,
   modes:Object.fromEntries(MODES.map(mode=>[mode,{entries:report.modes[mode].entries,target:goal.targetPerMode,
    openTrades:report.modes[mode].openTrades,closedTrades:report.modes[mode].closedTrades,
    netRealizedUsdt:report.modes[mode].netRealizedUsdt,netUnrealizedUsdt:report.modes[mode].netUnrealizedUsdt,
    status:report.modes[mode].status,warnings:report.modes[mode].warnings}])),report:join(directory,'latest.md'),archive},null,2));
  if(report.status==='unavailable'||report.status==='incomplete_evidence')process.exitCode=1;
  return report;
 }catch(error){
  const failure={schemaVersion:1,source:'freqtrade-demo-trade-goal-review',status:'unavailable',completed:false,
   observedAt:new Date().toISOString(),error:errorCode(error),promotionAuthorized:false,executionChanged:false};
  // Even validation/read failures get their own immutable record when storage
  // is available. Failure to archive must not prevent replacing stale latest.
  try{
   const archive=join(directory,'reviews',failure.observedAt.replace(/[:.]/g,'-')+'-'+randomUUID());
   await mkdir(archive,{recursive:true});
   await writeFile(join(archive,'input.json'),JSON.stringify({available:false,observedAt:failure.observedAt,error:failure.error},null,2)+'\n',{flag:'wx'});
   await writeFile(join(archive,'review.json'),JSON.stringify(failure,null,2)+'\n',{flag:'wx'});
   await writeFile(join(archive,'review.md'),tradeGoalMarkdown(failure),{flag:'wx'});
   failure.archive={directory:archive};
  }catch{failure.archive={status:'unavailable'};}
  await writeJson(join(directory,'latest.json'),failure);
  await writeFile(join(directory,'latest.md'),tradeGoalMarkdown(failure));
  console.error(failure.error);process.exitCode=1;return failure;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
