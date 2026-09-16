import DecimalBase from 'decimal.js';

// Keep accounting isolated from other modules' Decimal settings. The supported
// input range is deliberately bounded: hostile exponents must not allocate huge
// fixed-point strings, underflow silently to zero or overflow a numeric ratio.
const Decimal=DecimalBase.clone({precision:512});

/**
 * Descriptive, offline evaluation of a single Freqtrade environment's outcomes.
 * No clients, filesystem, prices, credentials, model calls or promotion authority.
 * profit_abs is already net of the engine's fee/funding accounting. Extra costs
 * below are a hypothetical execution stress, never another deduction of fees.
 * tradeVersions maps trade_id to an immutable experiment fingerprint. Unknown
 * historical versions stay unversioned; they never count as current evidence.
 */
export const PERFORMANCE_DEFAULTS=Object.freeze({
 minClosedTrades:100,minCalendarDays:30,minProfitFactor:1.2,extraExecutionCostBpsPerSide:5
});
const MODES=['dry-run','demo','demo-futures'];
const decimal=value=>{
 if(!['number','string'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value)))return null;
 const raw=String(value);
 if(raw.length>256)return null;
 const match=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(raw);
 if(!match||(match[1]!==undefined&&Math.abs(Number(match[1]))>1000))return null;
 try{const d=new Decimal(raw);return d.isFinite()&&(d.isZero()||(d.e>=-100&&d.e<=100))&&d.sd()<=128?d:null;}catch{return null;}
};
const timestamp=value=>Number.isSafeInteger(value)&&value>0;
const day=value=>new Date(value).toISOString().slice(0,10);
const fingerprint=value=>typeof value==='string'&&value.trim()&&value!=='unversioned'?value:null;
const id=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):
 typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:null;
const sum=values=>values.reduce((a,b)=>a.plus(b),new Decimal(0));
function options(input){
 const out={...PERFORMANCE_DEFAULTS,...input};
 if(Object.keys(input).some(k=>!Object.hasOwn(PERFORMANCE_DEFAULTS,k))||
  !Number.isSafeInteger(out.minClosedTrades)||out.minClosedTrades<1||
  !Number.isSafeInteger(out.minCalendarDays)||out.minCalendarDays<1||
  !Number.isFinite(out.minProfitFactor)||out.minProfitFactor<=0||
  !Number.isFinite(out.extraExecutionCostBpsPerSide)||out.extraExecutionCostBpsPerSide<0||out.extraExecutionCostBpsPerSide>10000)
  throw new TypeError('PERFORMANCE_INVALID_THRESHOLDS');
 return out;
}
function statistics(rows,complete=true){
 const sorted=[...rows].sort((a,b)=>a.trade.close_timestamp-b.trade.close_timestamp||a.id.localeCompare(b.id));
 let cumulative=new Decimal(0),peak=new Decimal(0),drawdown=new Decimal(0),streak=0,maxStreak=0;
 for(const row of sorted){
  cumulative=cumulative.plus(row.net);peak=Decimal.max(peak,cumulative);drawdown=Decimal.max(drawdown,peak.minus(cumulative));
  streak=row.net.isNegative()?streak+1:0;maxStreak=Math.max(maxStreak,streak);
 }
 const wins=rows.filter(r=>r.net.gt(0)),losses=rows.filter(r=>r.net.lt(0));
 const grossWins=sum(wins.map(r=>r.net)),grossLosses=sum(losses.map(r=>r.net.negated()));
 const best=rows.length?rows.reduce((a,b)=>a.net.gte(b.net)?a:b):null;
 const first=sorted[0]?.trade.close_timestamp,last=sorted.at(-1)?.trade.close_timestamp;
 const ratio=grossLosses.gt(0)?grossWins.div(grossLosses).toNumber():null;
 const known={netRealizedUsdt:cumulative.toFixed(),grossWinsUsdt:grossWins.toFixed(),grossLossesUsdt:grossLosses.toFixed(),
  expectancyUsdt:rows.length?cumulative.div(rows.length).toSignificantDigits(20).toFixed():null,
  profitFactor:ratio!==null&&Number.isFinite(ratio)?ratio:null,
  profitFactorReason:ratio!==null?(Number.isFinite(ratio)?null:'numeric_range_exceeded'):rows.length?'no_losing_trades':'no_closed_trades',
  winRate:rows.length?wins.length/rows.length:null,
  bestTradeId:best?.trade.trade_id??null,bestTradeNetUsdt:best?.net.toFixed()??null,
  netWithoutBestTradeUsdt:best?cumulative.minus(best.net).toFixed():null,
  closedTradeDrawdownUsdt:drawdown.toFixed(),maxConsecutiveLosses:maxStreak};
 return {closedTrades:rows.length,winningTrades:wins.length,losingTrades:losses.length,
  breakevenTrades:rows.length-wins.length-losses.length,pnlComplete:complete,
  firstCloseAt:first?new Date(first).toISOString():null,lastCloseAt:last?new Date(last).toISOString():null,
  calendarDays:first?Math.round((Date.parse(day(last))-Date.parse(day(first)))/86400000)+1:0,
  observedCloseDays:new Set(rows.map(r=>day(r.trade.close_timestamp))).size,
  ...known,...(!complete?{netRealizedUsdt:null,expectancyUsdt:null,profitFactor:null,profitFactorReason:'invalid_or_incomplete_input',
   winRate:null,netWithoutBestTradeUsdt:null,closedTradeDrawdownUsdt:null,knownValidOutcomes:known}:{}),
  accountEquityDrawdownPercent:null};
}
function assess(summary,thresholds,{dataComplete=true,current=false}={}){
 // These are already validated, calculated strings, not new numeric evidence;
 // an aggregate may legitimately exceed one input value's supported range.
 const positive=value=>value!==null&&new Decimal(value).gt(0);
 const checks=[
  {name:'complete_input',passed:dataComplete,actual:dataComplete,required:true},
  {name:'closed_trades',passed:summary.closedTrades>=thresholds.minClosedTrades,actual:summary.closedTrades,required:thresholds.minClosedTrades},
  {name:'calendar_days',passed:summary.calendarDays>=thresholds.minCalendarDays,actual:summary.calendarDays,required:thresholds.minCalendarDays},
  {name:'profit_factor',passed:summary.profitFactor!==null&&summary.profitFactor>=thresholds.minProfitFactor,actual:summary.profitFactor,required:thresholds.minProfitFactor},
  {name:'positive_net',passed:positive(summary.netRealizedUsdt),actual:summary.netRealizedUsdt,required:'> 0'},
  {name:'positive_net_without_best_trade',passed:positive(summary.netWithoutBestTradeUsdt),actual:summary.netWithoutBestTradeUsdt,required:'> 0'}
 ];
 const insufficient=checks.slice(0,3).some(c=>!c.passed);
 return {status:insufficient?'insufficient_evidence':checks.some(c=>!c.passed)?'criteria_not_met':'preliminary_only',
  scope:current?'current_version_closed_trades':'all_version_closed_trades',promotionAuthorized:false,
  reasons:checks.filter(c=>!c.passed).map(c=>c.name),checks,
  note:'Research criteria only. Passing does not establish a stable edge, future profit or permission to trade.'};
}
function group(rows,keyFn){
 const groups=new Map();for(const row of rows){const key=keyFn(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,values])=>({key,summary:statistics(values)}));
}
function filledTurnover(row){
 const t=row.trade,orders=t.orders;
 if(!Array.isArray(orders)||!orders.length)return {reason:'missing_order_records'};
 const orderIds=new Set();let entry=new Decimal(0),exit=new Decimal(0),entryCount=0,exitCount=0,nativeExitCount=0;
 for(const o of orders){
  if(!o||typeof o!=='object')return {reason:'invalid_order_record'};
  const filled=decimal(o.filled),cost=decimal(o.cost),remaining=decimal(o.remaining),amount=decimal(o.amount);
  if(!filled||filled.lt(0)||!cost||cost.lt(0)||!remaining||remaining.lt(0)||!amount||!amount.gt(0)||o.is_open!==false)return {reason:'invalid_or_open_order'};
  const orderId=o.order_id??o.id;
  if(!((typeof orderId==='string'&&orderId.trim())||(typeof orderId==='number'&&Number.isSafeInteger(orderId)&&orderId>=0))||orderIds.has(String(orderId)))return {reason:'missing_or_duplicate_order_id'};
  orderIds.add(String(orderId));
  const quantityTolerance=Decimal.max(amount.abs().mul('1e-10'),'1e-12');
  if(filled.minus(amount).gt(quantityTolerance)||filled.plus(remaining).minus(amount).abs().gt(quantityTolerance))return {reason:'inconsistent_fill_quantity'};
  if(filled.isZero()){
   if(!cost.isZero()||!['closed','canceled','cancelled','expired','rejected'].includes(o.status))return {reason:'invalid_unfilled_order'};
   continue;
  }
  if(o.status!=='closed'||!remaining.isZero()||!cost.gt(0)||typeof o.ft_is_entry!=='boolean')return {reason:'incomplete_fill_record'};
  // Validate a recorded fill average when supplied; never substitute the limit
  // order price or reconstruct missing cost from it.
  if(o.average!==undefined&&o.average!==null){
   const average=decimal(o.average);
   if(!average||!average.gt(0))return {reason:'invalid_fill_average'};
   const expectedCost=filled.mul(average),costTolerance=Decimal.max(expectedCost.abs().mul('1e-8'),'1e-8');
   if(cost.minus(expectedCost).abs().gt(costTolerance))return {reason:'inconsistent_filled_quote_cost'};
  }
  // Freqtrade reports native protective fills as "stoploss", an exit role,
  // rather than buy/sell. Its direction follows the verified trade direction.
  const nativeStop=o.ft_order_side==='stoploss',expected=o.ft_is_entry?(t.is_short?'sell':'buy'):(t.is_short?'buy':'sell');
  if(nativeStop&&(o.ft_is_entry!==false||o.pair!==t.pair))return {reason:'order_direction_mismatch'};
  const side=nativeStop?expected:o.ft_order_side??o.side;
  if(side!==expected||(o.side!==undefined&&o.side!==null&&o.side!==side))return {reason:'order_direction_mismatch'};
  if(o.ft_is_entry){entry=entry.plus(cost);entryCount++;}else{exit=exit.plus(cost);if(nativeStop)nativeExitCount++;else exitCount++;}
 }
 if(!entryCount||!(exitCount+nativeExitCount))return {reason:'entry_or_exit_fills_missing'};
 // Installed Freqtrade counts nr_of_successful_exits by the buy/sell exit
 // side, excluding ft_order_side=stoploss. Validate that exact field meaning.
 for(const [key,count] of [['nr_of_successful_entries',entryCount],['nr_of_successful_exits',exitCount]])
  if(t[key]!==undefined&&(!Number.isSafeInteger(t[key])||t[key]!==count))return {reason:'fill_count_mismatch'};
 return {entry,exit};
}
function stress(rows,bps,complete){
 const missing=[],values=[];
 for(const row of rows){const value=filledTurnover(row);if(value.reason)missing.push({tradeId:row.trade.trade_id,reason:value.reason});else values.push(value);}
 const available=complete&&rows.length>0&&missing.length===0;
 const entry=sum(values.map(v=>v.entry)),exit=sum(values.map(v=>v.exit));
 const extra=entry.plus(exit).mul(bps).div(10000);
 return {available,extraExecutionCostBpsPerSide:bps,coveredTrades:values.length,requiredTrades:rows.length,missing,
  entryFilledQuoteTurnoverUsdt:available?entry.toFixed():null,exitFilledQuoteTurnoverUsdt:available?exit.toFixed():null,
  extraExecutionCostUsdt:available?extra.toFixed():null,
  stressedNetRealizedUsdt:available?sum(rows.map(r=>r.net)).minus(extra).toFixed():null,
  reason:available?null:!complete?'invalid_or_incomplete_input':!rows.length?'no_closed_trades':'filled_quote_turnover_unavailable',
  method:'Additional bps applied once to recorded entry cost and once to recorded exit cost; existing fees/funding are already in profit_abs.'};
}
export function evaluatePerformance({trades,observedAt,mode,tradeVersions={},currentVersion=null,thresholds={}}={}){
 const criteria=options(thresholds),diagnostics=[],rows=[],seen=new Map();
 const observation=typeof observedAt==='string'?Date.parse(observedAt):NaN;
 if(!Number.isFinite(observation))diagnostics.push({code:'INVALID_OBSERVED_AT'});
 if(!MODES.includes(mode))diagnostics.push({code:'INVALID_MODE'});
 if(!Array.isArray(trades))diagnostics.push({code:'INVALID_TRADES'});
 if(!tradeVersions||typeof tradeVersions!=='object'||Array.isArray(tradeVersions))throw new TypeError('PERFORMANCE_INVALID_VERSION_MAP');
 if(currentVersion!==null&&!fingerprint(currentVersion))throw new TypeError('PERFORMANCE_INVALID_CURRENT_VERSION');
 const input=Array.isArray(trades)?trades:[];
 for(const t of input){const key=id(t?.trade_id);if(key)seen.set(key,(seen.get(key)??0)+1);}
 for(const [index,t] of input.entries()){
  const codes=[],key=id(t?.trade_id);
  if(!t||typeof t!=='object'||Array.isArray(t)){diagnostics.push({index,code:'INVALID_TRADE'});continue;}
  if(!key)codes.push('INVALID_TRADE_ID');else if(seen.get(key)!==1)codes.push('DUPLICATE_TRADE_ID');
  if(typeof t.is_open!=='boolean')codes.push('INVALID_OPEN_STATUS');
  const pair=typeof t.pair==='string'?/^([A-Z0-9]+)\/USDT(?::USDT)?$/.exec(t.pair):null;
  if(!pair||['quote_currency','stake_currency','profit_currency'].some(k=>t[k]!==undefined&&t[k]!==null&&t[k]!=='USDT'))codes.push('INVALID_QUOTE_CURRENCY');
  if(pair&&((mode==='demo-futures')!==t.pair.endsWith(':USDT')))codes.push('TRADE_MODE_MISMATCH');
  if(t.trading_mode!==undefined&&t.trading_mode!==(mode==='demo-futures'?'futures':'spot'))codes.push('TRADE_MODE_MISMATCH');
  if(typeof t.is_short!=='boolean')codes.push('INVALID_DIRECTION');
  if(mode!=='demo-futures'&&t.is_short===true)codes.push('SPOT_SHORT_UNSUPPORTED');
  const leverage=decimal(t.leverage),stake=decimal(t.stake_amount);
  if(!leverage||!leverage.isInteger()||leverage.lt(1)||leverage.gt(3))codes.push('INVALID_LEVERAGE');
  else if(mode!=='demo-futures'&&!leverage.eq(1))codes.push('SPOT_LEVERAGE_UNSUPPORTED');
  if(!stake||!stake.gt(0))codes.push('INVALID_STAKE');
  if(!timestamp(t.open_timestamp)||!Number.isFinite(observation)||t.open_timestamp>observation)codes.push('INVALID_OPEN_TIMESTAMP');
  const net=decimal(t.profit_abs);
  if(t.is_open===false){
   if(net===null)codes.push('INVALID_NET_PNL');
   if(!timestamp(t.close_timestamp)||t.close_timestamp<t.open_timestamp||t.close_timestamp>observation)codes.push('INVALID_CLOSE_TIMESTAMP');
  }
  for(const code of codes)diagnostics.push({index,tradeId:t.trade_id??null,code});
  if(!codes.length&&t.is_open===false)rows.push({id:key,trade:t,net,version:fingerprint(tradeVersions[key])??'unversioned'});
 }
 const complete=diagnostics.length===0,summary=statistics(rows,complete);
 summary.inputTrades=input.length;summary.inputClosedTrades=input.filter(t=>t?.is_open===false).length;
 summary.openTrades=input.filter(t=>t?.is_open===true).length;summary.invalidTrades=new Set(diagnostics.filter(d=>d.index!==undefined).map(d=>d.index)).size;
 const currentRows=currentVersion?rows.filter(r=>r.version===currentVersion):[];
 const current=currentVersion?{fingerprint:currentVersion,summary:statistics(currentRows,complete),
  assessment:assess(statistics(currentRows,complete),criteria,{dataComplete:complete,current:true}),executionCostStress:stress(currentRows,criteria.extraExecutionCostBpsPerSide,complete)}:null;
 return {schemaVersion:1,mode,observedAt,thresholds:criteria,summary,diagnostics,
  assessment:current?.assessment??assess(summary,criteria,{dataComplete:complete}),
  aggregateAssessment:assess(summary,criteria,{dataComplete:complete}),currentVersion:current,
  daily:group(rows,r=>day(r.trade.close_timestamp)).map(({key,summary:s})=>({date:key,closedTrades:s.closedTrades,netRealizedUsdt:s.netRealizedUsdt})),
  cohorts:{pair:group(rows,r=>r.trade.pair),direction:group(rows,r=>r.trade.is_short?'short':'long'),
   leverage:group(rows,r=>decimal(r.trade.leverage)?.gt(0)?decimal(r.trade.leverage).toFixed():'unknown'),
   stake:group(rows,r=>decimal(r.trade.stake_amount)?.gt(0)?decimal(r.trade.stake_amount).toFixed():'unknown'),
   version:group(rows,r=>r.version)},
  executionCostStress:stress(rows,criteria.extraExecutionCostBpsPerSide,complete),
  limitations:[
   'Observed closed-trade results are descriptive. This is not a backtest, out-of-sample test or proof of stable profitability.',
   'profit_abs uses Freqtrade net fee/funding accounting; original commission reconciliation is outside this evaluation.',
   'Calendar days span first to last valid closed UTC dates; absent days are not invented as zero-return observations.',
   'Drawdown and loss streak use close-time ordering only; account equity, intratrade drawdown and capital-normalized returns are unavailable.',
   'Unknown versions are unversioned. Mixed historical versions and direction/leverage cohorts do not validate the current experiment.',
   'Stake cohorts use exact recorded stake_amount, so nearly identical filled amounts may form separate cohorts; intended order size is not inferred.',
   'Numeric evidence accepts at most 128 significant digits and nonzero decimal exponents -100 through 100; malformed or out-of-range inputs are rejected.',
   'Manual or model force exits remain included unless separate reliable attribution exists; force_exit alone does not identify an operator.',
   'The execution stress needs complete recorded filled order quote costs; it does not model liquidity, latency, gaps, funding changes or execution outages.'
  ]};
}
