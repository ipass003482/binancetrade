import DecimalBase from 'decimal.js';
import {recordedEntryId} from './entry-identity.mjs';

// Pure evidence review: no broker, filesystem, clock, order or fee mutations.
const Decimal=DecimalBase.clone({precision:512});
export const EXECUTION_QUALITY_REVIEW_VERSION='execution-quality-review-v1';
const MODES=['demo','demo-futures'],TAG=/^codex-[a-f0-9]{32}$/;
const stamp=v=>Number.isSafeInteger(v)&&v>0?v:null;
const asIso=v=>stamp(v)&&Number.isFinite(new Date(v).getTime())?new Date(v).toISOString():null;
const time=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const number=(v,{positive=false,nonnegative=false}={})=>{
 if(!['string','number'].includes(typeof v))return null;
 const raw=String(v);if(raw.length>256||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(raw))return null;
 try{const d=new Decimal(raw);return d.isFinite()&&(d.isZero()||Math.abs(d.e)<=100)&&d.sd()<=128&&(!positive||d.gt(0))&&(!nonnegative||d.gte(0))?d:null;}catch{return null;}
};
// Relative tolerance only accommodates serialized price/notional noise. It must
// never be applied to quantities or gain an absolute floor for tiny amounts.
const close=(a,b)=>a.minus(b).abs().lte(Decimal.max(a.abs(),b.abs()).mul('0.00000001'));
const unknown=(reason,extra={})=>({status:'unknown',reason,...extra});
const slipUnknown=reason=>unknown(reason,{orderIds:[],referencePrice:null,fillPrice:null,filledAmount:null,signedUnfavorableUsdt:null,signedUnfavorableBps:null});
const riskUnknown=(reason,loss)=>unknown(reason,{budgetUsdt:null,atMaxEntryNotionalUsdt:null,atFilledEntryNotionalUsdt:null,
 actualLossUsdt:loss?.toFixed()??null,excessOverBudgetUsdt:null,excessOverPlannedUsdt:null});

function ordersOf(trade){
 if(!Array.isArray(trade.orders))return unknown('ORDERS_MISSING');
 const unique=new Map();
 for(const order of trade.orders){
  if(!order||typeof order.order_id!=='string'||!order.order_id)return unknown('ORDER_ID_MISSING');
  if(unique.has(order.order_id)&&canonical(unique.get(order.order_id))!==canonical(order))return unknown('CONFLICTING_ORDER_ID');
  unique.set(order.order_id,order);
 }
 return {status:'verified',orders:[...unique.values()]};
}

function fillOf(order,pair,observed){
 const quantity=number(order.filled,{positive:true}),amount=number(order.amount,{positive:true}),remaining=number(order.remaining,{nonnegative:true}),
  cost=number(order.cost,{positive:true}),average=order.average==null?null:number(order.average,{positive:true}),
  safe=order.safe_price==null?null:number(order.safe_price,{positive:true}),filledAt=stamp(order.order_filled_timestamp);
 const terminal=['closed','canceled','cancelled','expired'].includes(order.status);
 if(order.pair!==pair||order.is_open!==false||!terminal||!quantity||!amount||!remaining||!cost||!filledAt||filledAt>observed||
  quantity.gt(amount)||!quantity.plus(remaining).eq(amount)||(order.status==='closed'&&!remaining.isZero()))return unknown('FILL_NOT_VERIFIED');
 // Requested limit/stop order.price is deliberately never a fallback fill price.
 if((order.average!=null&&!average)||(order.safe_price!=null&&!safe)||(!average&&!safe))return unknown('FILL_PRICE_MISSING_OR_INVALID');
 const price=average??safe,fromCost=cost.div(quantity);
 if(!close(price.mul(quantity),cost)||(average&&safe&&!close(average,safe)))return unknown('FILL_PRICE_COST_CONFLICT');
 return {status:'verified',orderId:order.order_id,quantity,amount,cost,price:fromCost,filledAt};
}

function entryFills(trade,orders,observed){
 const side=trade.is_short?'sell':'buy',candidates=orders.filter(o=>o.ft_order_side===side&&o.ft_is_entry!==false);
 if(!candidates.length)return unknown('ENTRY_FILL_MISSING');
 const fills=[];
 for(const order of candidates){
  if(order.ft_is_entry!==undefined&&order.ft_is_entry!==true)return unknown('ENTRY_FLAG_INVALID');
  if(order.ft_order_tag!==trade.enter_tag)return unknown('ENTRY_TAG_MISMATCH');
  const fill=fillOf(order,trade.pair,observed);if(fill.status!=='verified')return fill;fills.push(fill);
 }
 const quantity=fills.reduce((s,f)=>s.plus(f.quantity),new Decimal(0)),cost=fills.reduce((s,f)=>s.plus(f.cost),new Decimal(0));
 return {status:'verified',orderIds:fills.map(f=>f.orderId),quantity,cost,price:cost.div(quantity),fills};
}

function exactPlan(trade,{mode,plansByTag,journal,observed}){
 if(!TAG.test(trade.enter_tag??'')||!Object.hasOwn(plansByTag,trade.enter_tag))return unknown('EXACT_ENTRY_PLAN_MISSING');
 const p=plansByTag[trade.enter_tag],opened=stamp(trade.open_timestamp);
 if(!p||p.tag!==trade.enter_tag||p.pair!==trade.pair||p.isShort!==trade.is_short||p.purpose!=='strategy'||!time(p.createdAt)||
  !opened||time(p.createdAt)>opened||time(p.createdAt)>observed)return unknown('ENTRY_PLAN_IDENTITY_MISMATCH');
 const rows=journal.filter(r=>r?.id===trade.enter_tag.slice(6));
 const pending=rows.filter(r=>r.status==='pending');
 if(pending.length!==1||rows[0]!==pending[0])return unknown('ENTRY_JOURNAL_MISSING_OR_AMBIGUOUS');
 const first=pending[0],expectedAction=mode==='demo'?'buy':trade.is_short?'open-short':'open-long';
 if(first.tag!==trade.enter_tag||first.pair!==trade.pair||first.action!==expectedAction||first.purpose!=='strategy'||
  first.snapshotId!==p.snapshotId||first.ruleVersion!==p.ruleVersion||first.executionPolicyVersion!==p.executionPolicyVersion||
  canonical(first.riskPolicy??null)!==canonical(p.riskPolicy??null))return unknown('ENTRY_JOURNAL_PLAN_MISMATCH');
 if(Object.hasOwn(first,'stakeUsdt')){
  const stake=number(first.stakeUsdt,{positive:true}),cap=number(p.maxEntryNotionalUsdt,{positive:true});
  if(!stake||!cap||!close(stake,cap))return unknown('ENTRY_JOURNAL_PLAN_MISMATCH');
 }
 if(Object.hasOwn(first,'leverage')){
  const leverage=number(first.leverage,{positive:true});
  if(!leverage||(trade.leverage!==undefined&&!leverage.eq(number(trade.leverage,{positive:true})??-1))||
   (p.nativeEntryGuard?.leverage!==undefined&&!leverage.eq(number(p.nativeEntryGuard.leverage,{positive:true})??-1)))return unknown('ENTRY_JOURNAL_PLAN_MISMATCH');
 }
 try{if(recordedEntryId(first)!==first.id)return unknown('ENTRY_SNAPSHOT_IDENTITY_MISMATCH');}catch{return unknown('ENTRY_SNAPSHOT_IDENTITY_MISMATCH');}
 let previous=-Infinity,merged={};
 const states=['pending','unknown','submitted','reconciled','rejected','hold'];
 for(const row of rows){
  const at=time(row.at);if(at===null||at<previous||at>observed||!states.includes(row.status))return unknown('ENTRY_JOURNAL_INVALID');previous=at;
  for(const key of ['tag','pair','action','tradeId','snapshotId','ruleVersion','riskPolicy','executionPolicyVersion','stakeUsdt','leverage']){
   if(merged[key]!=null&&row[key]!=null&&canonical(merged[key])!==canonical(row[key]))return unknown('ENTRY_JOURNAL_CONFLICT');
  }
  for(const key of ['stakeUsdt','leverage'])if(Object.hasOwn(row,key)&&(!Object.hasOwn(first,key)||canonical(row[key])!==canonical(first[key])))return unknown('ENTRY_JOURNAL_CONFLICT');
  merged={...merged,...row};
 }
 if(!['submitted','reconciled'].includes(merged.status)||String(merged.tradeId)!==String(trade.trade_id)||merged.tag!==trade.enter_tag)
  return unknown('ENTRY_JOURNAL_NOT_SETTLED');
 return {status:'verified',plan:p};
}

function slippage(reference,fill,unfavorableSign){
 const delta=fill.price.minus(reference).mul(unfavorableSign);
 // Compute currency directly from recorded notional, avoiding a division then
 // multiplication that can introduce a rounding tail for multi-fill averages.
 const amount=fill.cost.minus(reference.mul(fill.quantity)).mul(unfavorableSign);
 return {status:'verified',reason:null,orderIds:fill.orderIds??[fill.orderId],referencePrice:reference.toFixed(),fillPrice:fill.price.toSignificantDigits(20).toFixed(),
  filledAmount:fill.quantity.toFixed(),signedUnfavorableUsdt:amount.toFixed(),signedUnfavorableBps:delta.div(reference).mul(10000).toSignificantDigits(20).toFixed()};
}

function entryReview(trade,plan,fill,mode){
 if(plan.status!=='verified')return slipUnknown(plan.reason);
 if(fill.status!=='verified')return slipUnknown(fill.reason);
 const p=plan.plan,g=p.nativeEntryGuard,reference=number(g?.bridgeQuotePrice,{positive:true});
 if(!g||g.mode!==mode||g.pair!==trade.pair||g.snapshotId!==p.snapshotId||g.side!==(trade.is_short?'short':'long')||!reference||
  !time(g.quoteFetchedAt)||time(g.quoteFetchedAt)>time(p.createdAt))return slipUnknown('BRIDGE_QUOTE_IDENTITY_MISSING_OR_INVALID');
 return slippage(reference,fill,trade.is_short?-1:1);
}

function stopReview(trade,orders,protection,mode,observed){
 const classification='native-stop-execution';
 const fail=reason=>({...slipUnknown(reason),classification});
 const stops=orders.filter(o=>o.ft_order_side==='stoploss');
 if(stops.some(o=>!number(o.filled,{nonnegative:true})))return fail('STOP_FILLED_AMOUNT_UNKNOWN');
 const candidates=stops.filter(o=>number(o.filled,{positive:true}));
 if(candidates.length!==1)return fail(candidates.length?'MULTIPLE_FILLED_STOP_ORDERS':'FILLED_STOP_ORDER_MISSING');
 const order=candidates[0];if(order.ft_is_entry!==undefined&&order.ft_is_entry!==false)return fail('STOP_ENTRY_FLAG_INVALID');
 const fill=fillOf(order,trade.pair,observed);if(fill.status!=='verified')return fail(fill.reason);
 if(fill.filledAt<trade.open_timestamp||(!trade.is_open&&fill.filledAt>trade.close_timestamp))return fail('STOP_FILL_TIME_MISMATCH');
 if(!protection||protection.version!=='demo-native-stop-v1'||protection.mode!==mode||!Array.isArray(protection.attempts)||
  time(protection.asOf)===null||time(protection.asOf)>observed)return fail('STOP_PRICE_EVIDENCE_MISSING_OR_INVALID');
 const matches=protection.attempts.filter(a=>a?.orderId===order.order_id);
 if(matches.length!==1)return fail(matches.length?'AMBIGUOUS_STOP_PRICE_EVIDENCE':'EXACT_STOP_PRICE_EVIDENCE_MISSING');
 const a=matches[0],reference=number(a.stopPrice,{positive:true}),accepted=number(a.acceptedAmount,{positive:true}),confirmed=time(a.confirmedAt),
  evidenceObserved=a.observedAt===undefined?null:time(a.observedAt),asOf=time(protection.asOf);
 if(a.status!=='confirmed'||!['open','closed'].includes(a.orderStatus)||a.pair!==trade.pair||a.side!==(trade.is_short?'buy':'sell')||
  !reference||!accepted||!accepted.eq(fill.amount)||confirmed===null||confirmed<trade.open_timestamp||confirmed>fill.filledAt||confirmed>asOf||
  (a.observedAt!==undefined&&(evidenceObserved===null||evidenceObserved<confirmed||evidenceObserved>asOf)))
  return fail('STOP_PRICE_EVIDENCE_IDENTITY_MISMATCH');
 return {...slippage(reference,fill,trade.is_short?1:-1),classification};
}

function riskReview(plan,fill,actualLoss,mode){
 if(plan.status!=='verified')return riskUnknown(plan.reason,actualLoss);
 const p=plan.plan,budget=number(p.riskBudgetUsdt,{positive:true}),cap=number(p.maxEntryNotionalUsdt,{positive:true}),
  stop=number(p.stopFraction,{positive:true}),cost=number(p.riskCostFraction,{nonnegative:true}),reserve=number(p.riskPolicy?.reserveFraction,{nonnegative:true});
 const expected={version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'};
 if(!budget||!cap||!stop||stop.gt(1)||!cost||cost.gt(1)||!reserve||canonical(p.riskPolicy)!==canonical(expected))return riskUnknown('PLANNED_RISK_FIELDS_MISSING_OR_INVALID',actualLoss);
 const fraction=stop.plus(cost).plus(reserve),atCap=cap.mul(fraction),atFill=fill.status==='verified'?fill.cost.mul(fraction):null;
 return {status:'verified',reason:null,budgetUsdt:budget.toFixed(),atMaxEntryNotionalUsdt:atCap.toFixed(),atFilledEntryNotionalUsdt:atFill?.toFixed()??null,
  actualLossUsdt:actualLoss?.toFixed()??null,excessOverBudgetUsdt:actualLoss?Decimal.max(0,actualLoss.minus(budget)).toFixed():null,
  excessOverPlannedUsdt:actualLoss&&atFill?Decimal.max(0,actualLoss.minus(atFill)).toFixed():null,
  fillRiskReason:atFill?null:fill.reason,interpretation:'Plan stress arithmetic including recorded estimated costs/reserve; not a hard loss cap or an ATR-exit classification.'};
}

export function reviewExecutionQuality({mode,observedAt,trades,plansByTag={},journal=[],protection=null}={}){
 const observed=time(observedAt);
 if(!MODES.includes(mode)||observed===null||!Array.isArray(trades)||!Array.isArray(journal)||!plansByTag||typeof plansByTag!=='object'||Array.isArray(plansByTag))throw Error('EXECUTION_REVIEW_INPUT_INVALID');
 const rows=[],diagnostics=[],groups=new Map();let pnlComplete=true;
 for(const trade of trades){
  if(!Number.isSafeInteger(trade?.trade_id)||trade.trade_id<=0){diagnostics.push({code:'TRADE_ID_INVALID'});pnlComplete=false;continue;}
  if(!groups.has(trade.trade_id))groups.set(trade.trade_id,[]);groups.get(trade.trade_id).push(trade);
 }
 for(const [tradeId,copies] of groups){
  const t=copies[0],duplicateConflict=copies.some(c=>canonical(c)!==canonical(t));
  if(copies.length>1){diagnostics.push({tradeId,code:duplicateConflict?'CONFLICTING_TRADE_ID':'DUPLICATE_TRADE_ID_COLLAPSED'});if(duplicateConflict)pnlComplete=false;}
  const identity=!duplicateConflict&&typeof t.is_open==='boolean'&&typeof t.is_short==='boolean'&&
   (mode==='demo'?/^[A-Z0-9]+\/USDT$/.test(t.pair)&&t.is_short===false:/^[A-Z0-9]+\/USDT:USDT$/.test(t.pair))&&
   (t.exchange===undefined||t.exchange==='binance_demo')&&(t.quote_currency===undefined||t.quote_currency==='USDT')&&
   (t.base_currency===undefined||t.base_currency===t.pair.split('/')[0])&&
   t.trading_mode===(mode==='demo'?'spot':'futures')&&stamp(t.open_timestamp)&&t.open_timestamp<=observed&&
   (t.is_open||(stamp(t.close_timestamp)&&t.close_timestamp>=t.open_timestamp&&t.close_timestamp<=observed));
  const net=identity?number(t.profit_abs):null,actualLoss=net&&!t.is_open?Decimal.max(0,net.negated()):null;
  if(!identity||!net){pnlComplete=false;diagnostics.push({tradeId,code:!identity?'TRADE_IDENTITY_INVALID':'NET_PNL_UNAVAILABLE'});}
  const base={tradeId,mode,pair:typeof t.pair==='string'?t.pair:null,direction:typeof t.is_short==='boolean'?(t.is_short?'short':'long'):null,
   openedAt:asIso(t.open_timestamp),closedAt:asIso(t.close_timestamp),
   isOpen:typeof t.is_open==='boolean'?t.is_open:null,netRealizedUsdt:identity&&!t.is_open?net?.toFixed()??null:null,
   netUnrealizedUsdt:identity&&t.is_open?net?.toFixed()??null:null};
  if(!identity){rows.push({...base,plannedRisk:riskUnknown('TRADE_IDENTITY_INVALID',null),entrySlippage:slipUnknown('TRADE_IDENTITY_INVALID'),stopSlippage:{...slipUnknown('TRADE_IDENTITY_INVALID'),classification:'native-stop-execution'}});continue;}
  const orders=ordersOf(t),rawFill=orders.status==='verified'?entryFills(t,orders.orders,observed):orders,
   plan=exactPlan(t,{mode,plansByTag,journal,observed});
  // Exchange entries can precede Freqtrade's local trade.open_timestamp.
  // Exact plan creation is the lower bound; local trade close is the upper.
  const fill=rawFill.status==='verified'&&rawFill.fills.some(f=>(plan.status==='verified'&&f.filledAt<time(plan.plan.createdAt))||
   (!t.is_open&&f.filledAt>t.close_timestamp))?unknown('ENTRY_FILL_TIME_MISMATCH'):rawFill;
  rows.push({...base,plannedRisk:riskReview(plan,fill,actualLoss,mode),entrySlippage:entryReview(t,plan,fill,mode),
   stopSlippage:orders.status==='verified'?stopReview(t,orders.orders,protection,mode,observed):{...slipUnknown(orders.reason),classification:'native-stop-execution'}});
 }
 const verified=key=>rows.filter(row=>row[key].status==='verified'),sum=values=>values.reduce((n,v)=>n.plus(v),new Decimal(0)).toFixed();
 const entry=verified('entrySlippage'),stop=verified('stopSlippage');
 return {version:EXECUTION_QUALITY_REVIEW_VERSION,mode,observedAt,rows,diagnostics,
  summary:{inputTrades:trades.length,trades:rows.length,closedTrades:rows.filter(r=>r.isOpen===false).length,openTrades:rows.filter(r=>r.isOpen===true).length,
   pnlComplete,netRealizedUsdt:pnlComplete?sum(rows.filter(r=>!r.isOpen).map(r=>r.netRealizedUsdt)):null,
   netUnrealizedUsdt:pnlComplete?sum(rows.filter(r=>r.isOpen).map(r=>r.netUnrealizedUsdt)):null,
   verifiedEntrySlippage:entry.length,unknownEntrySlippage:rows.length-entry.length,verifiedStopSlippage:stop.length,unknownStopSlippage:rows.length-stop.length,
   knownRiskBudgets:verified('plannedRisk').length,lossesOverBudget:rows.filter(r=>r.plannedRisk.excessOverBudgetUsdt!==null&&new Decimal(r.plannedRisk.excessOverBudgetUsdt).gt(0)).length,
   signedEntrySlippageUsdt:entry.length?sum(entry.map(r=>r.entrySlippage.signedUnfavorableUsdt)):null,
   signedStopSlippageUsdt:stop.length?sum(stop.map(r=>r.stopSlippage.signedUnfavorableUsdt)):null},
  interpretation:'Positive signed slippage is unfavorable; negative is favorable. Slippage uses verified filled quantity and gross quote-price difference, not another fee deduction. Engine profit_abs is retained unchanged. Stop execution is not necessarily an initial ATR stop; unknown evidence stays unknown. These components do not by themselves reconcile all realized PnL.'};
}
