// Read-only actual-fill attribution. No entry decisions or parameter changes.
import Decimal from 'decimal.js';
import {join} from 'node:path';
import {evaluatePerformance} from './performance.mjs';
import {recordedEntryId} from './entry-identity.mjs';
import {FLOW_ONLY_POLICY,SPOT_FLOW_QUALITY_VERSION} from './order-flow.mjs';
import {loadPolicy} from './config.mjs';
import {modeLocal} from './mode.mjs';
import {readJson,journalRead} from './io.mjs';
import {FreqtradeClient} from './freqtrade.mjs';
import {reviewExecutionQuality} from './execution-quality-review.mjs';
import {readDemoSession,validateDemoSession,sessionTrades,sessionJournal,sessionOpenCount} from './demo-session.mjs';
import {loadKevEntryConfig} from './kev-entry.mjs';

const MODES=['demo','demo-futures'];
const fields=['entryPolicyVersion','executionQualityVersion','ruleVersion','strategyFingerprint'];
const currentKey=(mode,policy)=>policy==='kev-order-flow-v1'?'kev-order-flow-v1 / not-applicable':FLOW_ONLY_POLICY+' / '+(mode==='demo'?SPOT_FLOW_QUALITY_VERSION:'not-applicable');
const num=v=>{if(!['number','string'].includes(typeof v)||String(v).length>128||String(v).trim()==='')return null;
 try{const d=new Decimal(v);return d.isFinite()&&(d.isZero()||Math.abs(d.e)<=50)?d:null;}catch{return null;}};

// Reporting must retain actual over-budget/slipped fills. Operational pending
// reconciliation has stricter budget checks and is deliberately NOT changed.
function historicalFillProof(base,t){
 try{
  const short=base.action==='open-short';
  if(!Number.isInteger(t.trade_id)||t.pair!==base.pair||t.enter_tag!==base.tag||t.is_short!==short||
   (base.action==='buy'?t.trading_mode!=='spot':t.trading_mode!=='futures'||t.leverage!==base.leverage))return null;
  const entries=(t.orders??[]).filter(o=>o?.ft_is_entry===true||
   (o&&!Object.hasOwn(o,'ft_is_entry')&&o.ft_order_side===(short?'sell':'buy')));
  if(entries.length!==1)return null;
  const o=entries[0];
  if(o.pair!==base.pair||o.ft_order_tag!==base.tag||o.ft_order_side!==(short?'sell':'buy')||
   !String(o.order_id??'').trim()||o.is_open!==false||o.status!=='closed')return null;
  const filled=num(o.filled),amount=num(o.amount),requested=num(t.amount_requested),
   price=num(Object.hasOwn(o,'safe_price')?o.safe_price:o.average),cost=num(o.cost),precision=num(t.amount_precision),remaining=num(o.remaining);
  const step=t.precision_mode===4?precision:t.precision_mode===2&&precision?.isInteger()&&precision.gte(0)&&precision.lte(18)?new Decimal(10).pow(precision.neg()):null;
  if(!step?.gt(0)||!filled?.gt(0)||!price?.gt(0)||!cost?.gt(0)||!amount||!requested||!remaining?.isZero()||
   !filled.eq(amount)||!filled.mod(step).isZero()||requested.lt(filled)||requested.minus(filled).gte(step))return null;
  const fromPrice=filled.mul(price),relativeNoise=Decimal.max(cost.abs(),fromPrice.abs()).mul('0.00000001');
  if(cost.minus(fromPrice).abs().gt(relativeNoise))return null;
  return {orderId:String(o.order_id),filled:filled.toFixed(),grossQuoteCost:cost.toFixed(),amountStep:step.toFixed()};
 }catch{return null;}
}

function attribution(trade,journal,trades,observedAt){
 const pending=journal.filter(r=>r?.status==='pending'&&r.tag===trade.enter_tag&&['buy','open-long','open-short'].includes(r.action));
 if(pending.length!==1)return {key:'unattributed',reason:'NO_UNIQUE_ORIGINAL_INTENT'};
 const p=pending[0],records=journal.filter(r=>r.id===p.id),last=records.at(-1);
 const proof=historicalFillProof(p,trade);
 const intentAt=Date.parse(p.at),now=Date.parse(observedAt);
 if(p.id!==recordedEntryId(p)||p.tag!=='codex-'+p.id||!proof||
  records.filter(r=>r.status==='pending').length!==1||
  !Number.isFinite(intentAt)||intentAt>trade.open_timestamp||
  records.some((r,i)=>!Number.isFinite(Date.parse(r.at))||Date.parse(r.at)>now||Date.parse(r.at)<intentAt||
   (i&&Date.parse(r.at)<Date.parse(records[i-1].at)))||
  last?.tradeId!==trade.trade_id||
  !['submitted','reconciled'].includes(last?.status)||
  records.some(r=>[...fields,'tag','pair','action','snapshotId','executionPolicyVersion','stakeUsdt','leverage'].some(k=>Object.hasOwn(r,k)&&r[k]!==p[k]))||
  records.some(r=>Object.hasOwn(r,'proof')&&(!r.proof||r.proof.orderId!==proof.orderId||
   !num(r.proof.filled)?.eq(proof.filled)||!num(r.proof.grossQuoteCost)?.eq(proof.grossQuoteCost)||
   (Object.hasOwn(r.proof,'amountStep')&&!num(r.proof.amountStep)?.eq(proof.amountStep))))||
  trades.flatMap(t=>t.orders??[]).filter(o=>o.pair===p.pair&&String(o.order_id)===proof.orderId).length!==1)
  return {key:'unattributed',reason:'ENTRY_ATTRIBUTION_NOT_VERIFIED'};
 const policy=p.entryPolicyVersion??p.ruleVersion;
 if(typeof policy!=='string'||!policy.trim())return {key:'unattributed',reason:'POLICY_MISSING'};
 const quality=trade.trading_mode==='futures'||policy==='kev-order-flow-v1'?'not-applicable':p.executionQualityVersion??'legacy-unrecorded';
 if(typeof quality!=='string')return {key:'unattributed',reason:'QUALITY_INVALID'};
 return {key:policy+' / '+quality,reason:null};
}

export function buildStrategyReview({mode,trades,journal,observedAt,session=null,currentEntryPolicyVersion}){
 if(session)session=validateDemoSession(session,{now:Date.parse(observedAt)});
 const outsideSessionOpenCount=sessionOpenCount(trades,session);
 trades=sessionTrades(trades,session);journal=sessionJournal(journal,session);
 if(!MODES.includes(mode)||!Array.isArray(trades)||!Array.isArray(journal))throw Error('STRATEGY_REVIEW_INPUT');
 const activeKey=currentKey(mode,currentEntryPolicyVersion),warnings=[],groups=new Map([[activeKey,[]]]),all=evaluatePerformance({mode,trades,observedAt});
 const ids=new Set(trades.map(t=>t.trade_id)),missingSettlements=[];
 if(outsideSessionOpenCount)missingSettlements.push({reason:'OUTSIDE_SESSION_OPEN_POSITION',count:outsideSessionOpenCount});
 for(const p of journal.filter(r=>r?.status==='pending'&&['buy','open-long','open-short'].includes(r.action))){
  const records=journal.filter(r=>r.id===p.id),last=records.at(-1);
  if(['pending','unknown'].includes(last?.status))
   missingSettlements.push({tradeId:last.tradeId??null,reason:'ENTRY_OUTCOME_UNRESOLVED'});
  for(const settled of records.filter(r=>['submitted','reconciled'].includes(r.status)))
   if(!ids.has(settled.tradeId))missingSettlements.push({tradeId:settled.tradeId??null,reason:'SETTLED_ENTRY_MISSING_FROM_HISTORY'});
 }
 warnings.push(...missingSettlements);
 for(const t of trades){
  const a=attribution(t,journal,trades,observedAt);if(a.reason)warnings.push({tradeId:t.trade_id,reason:a.reason});
  if(!groups.has(a.key))groups.set(a.key,[]);groups.get(a.key).push(t);
 }
 const cohorts=[...groups.entries()].map(([key,items])=>{
  const report=evaluatePerformance({mode,trades:items,observedAt}),s=report.summary;
  const open=items.filter(t=>t.is_open===true),floating=open.map(t=>num(t.profit_abs));
  const floatingComplete=floating.every(v=>v!==null);
  return {key,current:key===activeKey,tradeIds:items.map(t=>t.trade_id),
   closedCount:s.closedTrades,openCount:open.length,wins:s.winningTrades,losses:s.losingTrades,
   winRate:s.winRate,netRealizedUsdt:s.netRealizedUsdt,
   floatingUsdt:floatingComplete?floating.reduce((a,b)=>a.plus(b),new Decimal(0)).toFixed():null,
   averageWinUsdt:s.pnlComplete&&s.winningTrades?new Decimal(s.grossWinsUsdt).div(s.winningTrades).toFixed(8):null,
   averageLossUsdt:s.pnlComplete&&s.losingTrades?new Decimal(s.grossLossesUsdt).div(s.losingTrades).toFixed(8):null,
   expectancyUsdt:s.expectancyUsdt,profitFactor:s.profitFactor,profitFactorReason:s.profitFactorReason,
   closedTradeDrawdownUsdt:s.closedTradeDrawdownUsdt,
   flowExitCount:items.filter(t=>t.is_open===false&&t.exit_reason==='rules_flow_invalidated').length,
   firstCloseAt:s.firstCloseAt,lastCloseAt:s.lastCloseAt,
   complete:s.pnlComplete&&floatingComplete,diagnostics:report.diagnostics,
   evidenceStatus:s.closedTrades===0?'no_closed_trades':'observed_only'};
 }).sort((a,b)=>Number(b.current)-Number(a.current)||a.key.localeCompare(b.key));
 if(missingSettlements.length)for(const c of cohorts)Object.assign(c,{complete:false,netRealizedUsdt:null,winRate:null,
  averageWinUsdt:null,averageLossUsdt:null,profitFactor:null,expectancyUsdt:null,closedTradeDrawdownUsdt:null,evidenceStatus:'history_incomplete'});
 return {mode,observedAt,session,outsideSessionOpenCount,complete:missingSettlements.length===0&&all.summary.pnlComplete&&cohorts.every(c=>c.complete),
  attributionComplete:warnings.length===0,warnings,diagnostics:all.diagnostics,cohorts,
  aggregateNetRealizedUsdt:missingSettlements.length?null:all.summary.netRealizedUsdt,
  knownHistoryNetRealizedUsdt:all.summary.netRealizedUsdt,
  accounting:(session?'Trades opened in this validation session, ':'All available history, ')+'grouped by exact original entry intent and settled actual fill. Reporting accepts relative serialization noise and retains over-budget/slipped fills; it never clears pending orders. Includes original losses within scope; profit_abs is already fee/funding net. Not today-only or a controlled experiment.'};
}

async function inputFor(mode){
 const local=modeLocal(mode),policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
 const [trades,journal]=await Promise.all([client.history(),journalRead(join(local,'orders.jsonl'))]);
 const plansByTag={};
 for(const t of trades){
  if(!/^codex-[a-f0-9]{32}$/.test(t.enter_tag??''))continue;
  try{plansByTag[t.enter_tag]=await readJson(join(local,'entry-plans',t.enter_tag+'.json'));}catch{/* Unknown evidence remains unknown. */}
 }
 let protection=null;try{protection=await readJson(join(local,'protection-readiness.json'));}catch{}
 const kevConfig=await loadKevEntryConfig({local,mode});
 return {trades,journal,plansByTag,protection,currentEntryPolicyVersion:kevConfig.marketData==='order-flow'?'kev-order-flow-v1':undefined};
}
export async function readStrategyReview({readFor=inputFor,now=()=>Date.now(),readSession=readDemoSession,session:providedSession}={}){
 const started=now(),session=providedSession===undefined?await readSession({now:started}):providedSession;
 if(session)validateDemoSession(session,{now:started});
 const results=await Promise.allSettled(MODES.map(mode=>readFor(mode))),observedAt=new Date(now()).toISOString();
 const modes=results.map((r,i)=>{try{
  if(r.status!=='fulfilled')throw Error();
  const args={...r.value,mode:MODES[i],observedAt,session},review=buildStrategyReview(args);
  try{review.execution={...reviewExecutionQuality({...args,trades:sessionTrades(args.trades,session),journal:sessionJournal(args.journal,session)}),available:true};}catch{review.execution={available:false,rows:[],diagnostics:[{reason:'EXECUTION_REVIEW_UNAVAILABLE'}]};}
  return review;
 }catch{return {mode:MODES[i],observedAt,complete:false,attributionComplete:false,cohorts:[],error:'STRATEGY_HISTORY_UNAVAILABLE'};}});
 return {schemaVersion:1,observedAt,session,complete:modes.every(m=>m.complete&&m.execution?.available===true),modes,
  note:(session?'Only trades opened at or after '+session.startedAt+' enter this validation session. ':'Each strategy cohort starts at its original tagged fills. ')+
   'This is not a reset of exchange capital. Current version with zero closes has no realized performance evidence.'};
}
