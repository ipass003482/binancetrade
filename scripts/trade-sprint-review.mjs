// Read-only deadline goal. Reuse the verified journal/fill accounting contract;
// neither the target nor this report can submit orders or alter entry rules.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {readJson,writeJson,journalRead} from '../src/io.mjs';
import {buildTradeGoalReview} from './trade-goal-review.mjs';
import {evaluatePerformance} from '../src/performance.mjs';
const MODES=['demo','demo-futures'],hash=b=>createHash('sha256').update(b).digest('hex');
const validTime=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
export function buildSprintReview({goal,histories,journals,observedAt,amendment=null}){
 if(goal?.schemaVersion!==2||!validTime(goal.startedAt)||!validTime(goal.deadline)||
  Date.parse(goal.deadline)<=Date.parse(goal.startedAt)||!['each','combined'].includes(goal.target?.scope)||
  !Number.isSafeInteger(goal.target.count)||goal.target.count<1||!['forecast-net-edge-v1','trend-pullback-flow-v1','order-flow-only-v1','kev-order-flow-v1'].includes(goal.entryPolicyVersion))throw Error('SPRINT_GOAL_INVALID');
 const kevAmendment=amendment?.entryPolicyVersion==='kev-order-flow-v1';
 if(amendment&&(goal.entryPolicyVersion===amendment.entryPolicyVersion||amendment.schemaVersion!==1||amendment.goalId!==goal.id||
  !['order-flow-only-v1','kev-order-flow-v1'].includes(amendment.entryPolicyVersion)||
  (kevAmendment&&amendment.ruleVersion!=='kev-order-flow-v1')||
  amendment.goalSha256!==hash(Buffer.from(JSON.stringify(goal)))||!validTime(amendment.effectiveAt)||
  Date.parse(amendment.effectiveAt)<Date.parse(goal.startedAt)||Date.parse(amendment.effectiveAt)>=Date.parse(goal.deadline)))throw Error('SPRINT_AMENDMENT_INVALID');
 const checked=buildTradeGoalReview({goal:{...goal,schemaVersion:1,deadline:null,targetPerMode:goal.target.count,
  allowOrderFlowOnly:amendment?.entryPolicyVersion==='order-flow-only-v1',
  ...(kevAmendment?{kevOrderFlowAmendment:{ruleVersion:amendment.ruleVersion,effectiveAt:amendment.effectiveAt}}:{})},histories,journals,observedAt});
 const deadline=Date.parse(goal.deadline),modes={};
 for(const mode of MODES){
  const original=checked.modes[mode],accepted=[],excluded=[];
  for(const proof of original.trades){
   const amended=amendment&&proof.entryPolicyVersion===amendment.entryPolicyVersion&&Date.parse(proof.openedAt)>=Date.parse(amendment.effectiveAt)&&Date.parse(proof.filledAt)>=Date.parse(amendment.effectiveAt);
   if(proof.entryPolicyVersion!==goal.entryPolicyVersion&&!amended){excluded.push({tradeId:proof.tradeId,reason:'OTHER_ENTRY_POLICY'});continue;}
   const trade=histories[mode].trades.find(t=>String(t.trade_id)===String(proof.tradeId));
   const fills=trade.orders.filter(o=>proof.entryOrderIds.includes(o.order_id));
   if(fills.some(o=>o.order_filled_timestamp>=deadline)){
    excluded.push({tradeId:proof.tradeId,reason:'ENTRY_FILL_AT_OR_AFTER_DEADLINE'});continue;
   }
   accepted.push({trade,proof});
  }
  const stats=evaluatePerformance({trades:accepted.map(v=>v.trade),mode,observedAt});
  const floating=accepted.filter(v=>v.trade.is_open);
  const evidenceComplete=original.evidenceComplete&&stats.summary.pnlComplete;
  modes[mode]={entries:original.entries===null?null:accepted.length,openTrades:original.entries===null?null:floating.length,
   closedTrades:original.entries===null?null:accepted.length-floating.length,netRealizedUsdt:evidenceComplete?stats.summary.netRealizedUsdt:null,
   netUnrealizedUsdt:evidenceComplete?floating.reduce((s,v)=>s.plus(v.trade.profit_abs),new Decimal(0)).toFixed():null,
   entryPolicyCohorts:[...new Set(accepted.map(v=>v.proof.entryPolicyVersion))].map(entryPolicyVersion=>{const rows=accepted.filter(v=>v.proof.entryPolicyVersion===entryPolicyVersion),evaluated=evaluatePerformance({trades:rows.map(v=>v.trade),mode,observedAt});return {entryPolicyVersion,entries:rows.length,closedTrades:rows.filter(v=>!v.trade.is_open).length,netRealizedUsdt:evaluated.summary.netRealizedUsdt};}),
   entryRouteCohorts:[...new Set(accepted.map(v=>v.proof.entryRoute))].map(entryRoute=>{const rows=accepted.filter(v=>v.proof.entryRoute===entryRoute);const evaluated=evaluatePerformance({trades:rows.map(v=>v.trade),mode,observedAt});return {entryRoute,entries:rows.length,closedTrades:rows.filter(v=>!v.trade.is_open).length,netRealizedUsdt:evaluated.summary.netRealizedUsdt};}),
   executionQualityCohorts:[...new Set(accepted.map(v=>v.proof.executionQualityVersion))].map(executionQualityVersion=>{
    const rows=accepted.filter(v=>v.proof.executionQualityVersion===executionQualityVersion),open=rows.filter(v=>v.trade.is_open),
     evaluated=evaluatePerformance({trades:rows.map(v=>v.trade),mode,observedAt});
    return {executionQualityVersion,entries:rows.length,tradeIds:rows.map(v=>v.trade.trade_id),openTrades:open.length,closedTrades:rows.length-open.length,
     netRealizedUsdt:evidenceComplete?evaluated.summary.netRealizedUsdt:null,
     netUnrealizedUsdt:evidenceComplete?open.reduce((sum,v)=>sum.plus(v.trade.profit_abs),new Decimal(0)).toFixed():null,pnlComplete:evidenceComplete};
   }),
   evidenceComplete,trades:accepted.map(v=>v.proof),excluded:[...original.excluded,...excluded],
   warnings:original.warnings,allHistory:original.allHistory??null};
 }
 const evidenceComplete=MODES.every(m=>modes[m].evidenceComplete),total=MODES.reduce((n,m)=>n+(modes[m].entries??0),0);
 const countReached=goal.target.scope==='each'?MODES.every(m=>(modes[m].entries??0)>=goal.target.count):total>=goal.target.count;
 const expired=Date.parse(observedAt)>=deadline,completed=evidenceComplete&&countReached;
 return {schemaVersion:2,source:'freqtrade-demo-sprint-review',goalId:goal.id,observedAt,startedAt:goal.startedAt,
  amendment,deadline:goal.deadline,timezone:goal.timezone,target:goal.target,entryPolicyVersion:goal.entryPolicyVersion,
  status:!evidenceComplete?'incomplete_evidence':completed?'complete':expired?'deadline_missed':'collecting',
  completed,expired,evidenceComplete,totalEntries:evidenceComplete?total:null,modes,
  countDefinition:'One new attributed strategy entry trade_id per mode, with confirmed entry fills strictly before deadline. Exits, split fills, probes and old entries do not add counts.',
  accounting:'PnL continues following the accepted entry cohort after the deadline; late entries remain in allHistory but never fill this quota.',
  stopTradingAtDeadline:false,stopTradingAtTarget:false,executionChanged:false,promotionAuthorized:false};
}
export function sprintMarkdown(r){
 const label=r.target.scope==='each'?`現貨、合約各 ${r.target.count} 筆`:`現貨、合約合計 ${r.target.count} 筆`;
 const cell=value=>String(value??'無法確認').replace(/[|\r\n]/g,' ');
 return [`# Demo 限時目標：${label}`,'',`資料時間：${r.observedAt}；狀態：${r.status}。`,
  `開始：${r.startedAt}；截止：${r.deadline}（${r.timezone}）。策略：${r.entryPolicyVersion}${r.amendment?`；自 ${r.amendment.effectiveAt} 加計 ${r.amendment.entryPolicyVersion}`:''}。`,
  '', '| 模式 | 新開倉成交 | 持倉 | 已平倉 | 已實現淨損益 USDT | 浮動損益 USDT |',
  '|---|---:|---:|---:|---:|---:|',...MODES.map(m=>{const x=r.modes[m];return `| ${m} | ${x.entries??'無法確認'} | ${x.openTrades} | ${x.closedTrades} | ${x.netRealizedUsdt??'無法確認'} | ${x.netUnrealizedUsdt??'無法確認'} |`;}),
  '',`合計 ${r.totalEntries??'無法確認'} 筆。只計截止前真正成交的新策略開倉；平倉、拆單、HOLD、未成交及舊交易不加次數。`,
  ...MODES.flatMap(mode=>(r.modes[mode].executionQualityCohorts??[]).flatMap(c=>['',`${mode} / 策略調整 ${cell(c.executionQualityVersion)}：${c.entries} 筆（trade_id：${c.tradeIds.map(cell).join(', ')}）；已實現 ${cell(c.netRealizedUsdt)} USDT，浮動 ${cell(c.netUnrealizedUsdt)} USDT。`])),
  'legacy-unrecorded 表示原始委託未記錄新版策略調整；not-applicable 表示合約不套用。只分列本目標內的實際成交，不回填或重計舊交易。',
  '截止後仍追蹤這批持倉的最終淨利，保留全部舊虧損與共同本金；截止或達標不會自動關閉 Demo 或模型。',
  '此目標不構成必然成交、獲利或真金啟用的保證。'].join('\n')+'\n';
}
export async function main(argv=process.argv.slice(2)){
 if(argv.length!==2||argv[0]!=='--goal')throw Error('USAGE_EXPECTED_GOAL_PATH');
 const goalPath=resolve(argv[1]),directory=dirname(goalPath),goal=await readJson(goalPath),histories={},journals={};
 const {loadPolicy}=await import('../src/config.mjs'),{FreqtradeClient}=await import('../src/freqtrade.mjs');
 for(const mode of MODES){
  try{
   const policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(ROOT,'local',mode,'api-auth.json')));
   histories[mode]={source:'freqtrade-demo',historyComplete:true,trades:await client.history(),observedAt:new Date().toISOString()};
   journals[mode]=await journalRead(join(ROOT,'local',mode,'orders.jsonl'));
  }catch{histories[mode]={source:'freqtrade-demo',historyComplete:false,observedAt:new Date().toISOString(),error:'HISTORY_UNAVAILABLE'};}
 }
 let amendment=null;
 for(const name of ['order-flow-only-amendment.json','kev-order-flow-amendment.json']){
  let found;try{found=await readJson(join(directory,name));}catch(e){if(e.code!=='ENOENT')throw e;continue;}
  if(amendment)throw Error('SPRINT_MULTIPLE_AMENDMENTS_UNSUPPORTED');
  amendment=found;
 }
 const input={goal,amendment,histories,journals,observedAt:new Date().toISOString()},report=buildSprintReview(input);
 const archive=join(directory,'reviews',input.observedAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));await mkdir(archive,{recursive:true});
 const bytes=Buffer.from(JSON.stringify(input,null,2)+'\n');await writeFile(join(archive,'input.json'),bytes,{flag:'wx'});
 const sources=[];
 for(const rel of ['scripts/trade-sprint-review.mjs','scripts/trade-goal-review.mjs','src/performance.mjs','src/entry-identity.mjs']){
  const b=await readFile(join(ROOT,rel)),name=rel.split('/').at(-1);await writeFile(join(archive,name),b,{flag:'wx'});sources.push({path:rel,sha256:hash(b)});
 }
 report.archive={directory:archive,inputSha256:hash(bytes),sources};
 await writeFile(join(archive,'review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 await writeFile(join(archive,'review.md'),sprintMarkdown(report),{flag:'wx'});
 await writeJson(join(directory,'latest.json'),report);await writeFile(join(directory,'latest.md'),sprintMarkdown(report));
 console.log(JSON.stringify({observedAt:report.observedAt,status:report.status,target:report.target,deadline:report.deadline,
  totalEntries:report.totalEntries,modes:Object.fromEntries(MODES.map(m=>[m,{entries:report.modes[m].entries,netRealizedUsdt:report.modes[m].netRealizedUsdt}])),archive}));
 if(!report.evidenceComplete)process.exitCode=1;
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
