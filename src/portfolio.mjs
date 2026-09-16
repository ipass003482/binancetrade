import {join} from 'node:path';
import DecimalBase from 'decimal.js';
import {ROOT} from './paths.mjs';
import {readJson} from './io.mjs';
import {evaluatePerformance} from './performance.mjs';
import {stopExecutionReserve} from './demo-risk.mjs';

const Decimal=DecimalBase.clone({precision:64});
const MODES=['demo','demo-futures'];
export const PORTFOLIO_SOURCE='freqtrade-demo-portfolio';
export const PORTFOLIO_DEFAULTS=Object.freeze({version:1,capitalUsdt:'2000',maxGrossExposureUsdt:'1050',
 maxOpenRiskUsdt:'4',maxDailyLossUsdt:'50',maxDrawdownUsdt:'100',maxSnapshotAgeSeconds:15,blockOppositeSameBase:true});
const fail=code=>{throw new Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const key=value=>Number.isSafeInteger(value)&&value>0?String(value):typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:null;
const text=value=>typeof value==='string'&&value.trim()===value&&value.length>0;
const decimal=value=>{
 if(!['number','string'].includes(typeof value))return null;
 const raw=String(value);if(raw.length>128||!(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).test(raw))return null;
 try{const d=new Decimal(raw);return d.isFinite()&&(d.isZero()||(d.e>=-30&&d.e<=30))&&d.sd()<=64?d:null;}catch{return null;}
};
const number=(value,code)=>decimal(value)??fail(code);
const sum=values=>values.reduce((a,b)=>a.plus(b),new Decimal(0));
const fresh=(value,now,seconds)=>timestamp(value)&&now-Date.parse(value)>=0&&now-Date.parse(value)<=seconds*1000;

/** Hard upper bounds preserve the authorized Demo envelope. Lower settings are allowed. */
export function validatePortfolioConfig(config){
 if(!object(config)||Object.keys(config).some(name=>!Object.hasOwn(PORTFOLIO_DEFAULTS,name))||config.version!==1||
  config.blockOppositeSameBase!==true||!Number.isInteger(config.maxSnapshotAgeSeconds)||
  config.maxSnapshotAgeSeconds<1||config.maxSnapshotAgeSeconds>15)fail('PORTFOLIO_CONFIG_INVALID');
 const out={...config};
 for(const name of ['capitalUsdt','maxGrossExposureUsdt','maxOpenRiskUsdt','maxDailyLossUsdt','maxDrawdownUsdt']){
  const d=number(config[name],'PORTFOLIO_CONFIG_INVALID');
  if(d.lte(0)||d.gt(PORTFOLIO_DEFAULTS[name]))fail('PORTFOLIO_CONFIG_INVALID');out[name]=d.toFixed();
 }
 if(new Decimal(out.maxGrossExposureUsdt).gt(out.capitalUsdt)||new Decimal(out.maxDailyLossUsdt).gt(out.capitalUsdt)||
  new Decimal(out.maxDrawdownUsdt).gt(out.capitalUsdt))fail('PORTFOLIO_CONFIG_INVALID');
 return out;
}
export async function loadPortfolioConfig(file=join(ROOT,'config','portfolio.json')){
 return validatePortfolioConfig(await readJson(file));
}

function planRisk(plan,{pair,isShort,notional,entry=false}){
 if(!object(plan))fail('PORTFOLIO_PLAN_MISSING');
 const stop=number(plan.stopFraction,'PORTFOLIO_PLAN_INVALID'),cost=number(plan.riskCostFraction,'PORTFOLIO_PLAN_INVALID');
 const budget=number(plan.riskBudgetUsdt,'PORTFOLIO_PLAN_INVALID');
 if(plan.pair!==pair||plan.isShort!==isShort||!text(plan.ruleVersion)||stop.lte(0)||stop.gt('.02')||
  cost.lt(0)||cost.gt(1)||budget.lte(0)||budget.gt(1))fail('PORTFOLIO_PLAN_INVALID');
 const reserve=stopExecutionReserve(plan,{mode:pair.includes(':')?'demo-futures':'demo',
  required:entry&&plan.ruleVersion==='kronos-direction-v12'});
 const risk=notional.mul(stop.plus(cost).plus(reserve));
 if(entry){
  const cap=number(plan.maxEntryNotionalUsdt,'PORTFOLIO_PLAN_INVALID');
  if(cap.lte(0)||notional.gt(cap)||risk.gt(budget))fail('PORTFOLIO_PLAN_INVALID');
 }
 return risk;
}

function openPosition(trade,mode){
 const futures=mode==='demo-futures';
 if(!object(trade)||!key(trade.trade_id)||trade.is_open!==true||typeof trade.has_open_orders!=='boolean'||
  typeof trade.is_short!=='boolean'||(!futures&&trade.is_short)||typeof trade.pair!=='string'||
  !(futures?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(trade.pair)||
  (trade.trading_mode!==undefined&&trade.trading_mode!==(futures?'futures':'spot')))fail('PORTFOLIO_POSITION_INVALID');
 const leverage=number(trade.leverage,'PORTFOLIO_POSITION_INVALID'),margin=number(trade.stake_amount,'PORTFOLIO_POSITION_INVALID');
 const amount=number(trade.amount,'PORTFOLIO_POSITION_MARK_UNAVAILABLE'),mark=number(trade.current_rate,'PORTFOLIO_POSITION_MARK_UNAVAILABLE');
 const pnl=number(trade.profit_abs,'PORTFOLIO_POSITION_MARK_UNAVAILABLE');
 if(!leverage.isInteger()||leverage.lt(1)||leverage.gt(futures?3:1)||margin.lte(0)||amount.lte(0)||mark.lte(0))
  fail('PORTFOLIO_POSITION_MARK_UNAVAILABLE');
 // No netting between spot and derivatives. Retain the larger of entry cost
 // and current marked notional, so an adverse or favorable mark cannot shrink
 // the original allocation used by this guard.
 const notional=Decimal.max(margin.mul(leverage),amount.mul(mark));
 return {mode,tradeId:trade.trade_id,pair:trade.pair,base:trade.pair.split('/')[0],isShort:trade.is_short,margin,notional,pnl};
}

function verifyJournal(records){
 if(!Array.isArray(records))fail('PORTFOLIO_JOURNAL_INVALID');
 const statuses=new Set(['pending','unknown','submitted','reconciled','rejected','hold']),latest=new Map();
 for(const row of records){
  if(!object(row)||!text(row.id)||!statuses.has(row.status)||!timestamp(row.at))fail('PORTFOLIO_JOURNAL_INVALID');
  latest.set(row.id,row.status);
 }
 if([...latest.values()].some(status=>status==='pending'||status==='unknown'))fail('PORTFOLIO_UNRESOLVED_SUBMISSION');
}

function portfolioPositions(accounts,plans,config,now){
 const positions=[];
 for(const mode of MODES){
  const account=accounts?.[mode];
  if(!object(account)||!Array.isArray(account.trades))fail('PORTFOLIO_ACCOUNT_UNAVAILABLE');
  if(!fresh(account.observedAt,now,config.maxSnapshotAgeSeconds))fail('PORTFOLIO_ACCOUNT_STALE');
  if(account.engine?.demo_trading!==true||account.engine?.dry_run!==false||account.engine?.exchange!=='binance'||
   account.engine?.trading_mode!==(mode==='demo-futures'?'futures':'spot'))fail('PORTFOLIO_ACCOUNT_IDENTITY');
  const seen=new Set();
  for(const trade of account.trades){
   const position=openPosition(trade,mode),id=String(position.tradeId);
   if(seen.has(id)||trade.has_open_orders)fail('PORTFOLIO_POSITION_INVALID');seen.add(id);
   position.risk=planRisk(plans?.[mode+':'+id],position);positions.push(position);
  }
 }
 return positions;
}

/** Actual current gross exposure including every baseline-excluded position. */
export function summarizePortfolioExposure({accounts,plans,config=PORTFOLIO_DEFAULTS,now=Date.now()}={}){
 const checked=validatePortfolioConfig(config),positions=portfolioPositions(accounts,plans,checked,now);
 return {asOf:new Date(now).toISOString(),grossUsdt:sum(positions.map(position=>position.notional)).toFixed(),
  estimatedOpenRiskUsdt:sum(positions.map(position=>position.risk)).toFixed(),allocatedMarginUsdt:sum(positions.map(position=>position.margin)).toFixed(),
  positions:positions.map(position=>({mode:position.mode,tradeId:position.tradeId,pair:position.pair,isShort:position.isShort,
   notionalUsdt:position.notional.toFixed(),riskUsdt:position.risk.toFixed()})),limits:checked};
}

/**
 * Entry-only, pure guard. Caller holds one cross-mode portfolio lock from the
 * fresh reads through submission/journal persistence. Never feeds broker total
 * balances into capital. Exit/HOLD remains available without fresh valuation.
 * accounts[mode] is FreqtradeClient.snapshot() plus observedAt (read completion).
 * plans is keyed by `${mode}:${trade_id}`. performance is a fresh report below.
 */
export function assessPortfolio({proposal,mode,accounts,plans={},journalByMode,entryPlan,performance,
 config=PORTFOLIO_DEFAULTS,now=Date.now()}={}){
 const p=validatePortfolioConfig(config);
 if(!MODES.includes(mode)||!object(proposal)||!Number.isFinite(now))fail('PORTFOLIO_PROPOSAL_INVALID');
 if(['hold','sell','close-long','close-short'].includes(proposal.action))return {action:proposal.action,checked:false,reason:'not_an_entry'};
 const futures=mode==='demo-futures',isShort=proposal.action==='open-short';
 if(!(futures?['open-long','open-short'].includes(proposal.action):proposal.action==='buy')||
  !(futures?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(proposal.pair))fail('PORTFOLIO_PROPOSAL_INVALID');
 const stake=number(proposal.stakeUsdt,'PORTFOLIO_PROPOSAL_INVALID');
 const leverage=futures?number(proposal.leverage,'PORTFOLIO_PROPOSAL_INVALID'):new Decimal(1);
 if(stake.lte(0)||!leverage.isInteger()||leverage.lt(1)||leverage.gt(futures?3:1))fail('PORTFOLIO_PROPOSAL_INVALID');
 const positions=portfolioPositions(accounts,plans,p,now);let dailyRealized=new Decimal(0);
 for(const accountMode of MODES){
  const account=accounts?.[accountMode];
  verifyJournal(journalByMode?.[accountMode]);
  const today=new Date(now).toISOString().slice(0,10),daily=account.daily;
  if(daily?.stake_currency!=='USDT'||!Array.isArray(daily.data))fail('PORTFOLIO_DAILY_STATE_UNAVAILABLE');
  const rows=daily.data.filter(row=>row?.date===today);
  if(rows.length!==1)fail('PORTFOLIO_DAILY_STATE_UNAVAILABLE');
  dailyRealized=dailyRealized.plus(number(rows[0].abs_profit,'PORTFOLIO_DAILY_STATE_UNAVAILABLE'));
 }
 if(!object(performance)||performance.source!==PORTFOLIO_SOURCE||performance.evidenceComplete!==true||
  performance.capitalUsdt!==p.capitalUsdt||!timestamp(performance.startedAt)||
  performance.sample?.startedAt!==performance.startedAt)fail('PORTFOLIO_PERFORMANCE_INCOMPLETE');
 if(!fresh(performance.asOf,now,p.maxSnapshotAgeSeconds))fail('PORTFOLIO_PERFORMANCE_STALE');
 const equity=number(performance.budgetEquityUsdt,'PORTFOLIO_PERFORMANCE_INCOMPLETE');
 const maxDrawdown=number(performance.sampledMaxDrawdownUsdt,'PORTFOLIO_PERFORMANCE_INCOMPLETE');
 if(maxDrawdown.lt(0))fail('PORTFOLIO_PERFORMANCE_INCOMPLETE');
 // Historical maximum is intentional: recovery above the threshold does not
 // silently remove a drawdown pause. The durable sample chain is the latch.
 if(maxDrawdown.gte(p.maxDrawdownUsdt)||performance.drawdownLimitBreached===true)fail('PORTFOLIO_DRAWDOWN_LIMIT');
 const dailyNet=dailyRealized.plus(sum(positions.map(position=>position.pnl)));
 if(dailyNet.lte(new Decimal(p.maxDailyLossUsdt).negated()))fail('PORTFOLIO_DAILY_LOSS_LIMIT');
 const base=proposal.pair.split('/')[0];
 if(positions.some(position=>position.mode===mode&&position.base===base))fail('PORTFOLIO_DUPLICATE_POSITION');
 if(positions.some(position=>position.base===base&&position.isShort!==isShort))fail('PORTFOLIO_OPPOSITE_POSITION');
 const notional=stake.mul(leverage),risk=planRisk(entryPlan,{pair:proposal.pair,isShort,notional,entry:true});
 const gross=sum(positions.map(position=>position.notional)).plus(notional);
 const openRisk=sum(positions.map(position=>position.risk)).plus(risk);
 const margin=sum(positions.map(position=>position.margin)).plus(stake);
 if(gross.gt(p.maxGrossExposureUsdt))fail('PORTFOLIO_GROSS_EXPOSURE_LIMIT');
 if(openRisk.gt(p.maxOpenRiskUsdt))fail('PORTFOLIO_OPEN_RISK_LIMIT');
 if(margin.gt(Decimal.min(p.capitalUsdt,equity)))fail('PORTFOLIO_CAPITAL_LIMIT');
 return {action:proposal.action,checked:true,mode,asOf:new Date(now).toISOString(),capitalUsdt:p.capitalUsdt,
  budgetEquityUsdt:equity.toFixed(),grossExposureAfterUsdt:gross.toFixed(),openRiskAfterUsdt:openRisk.toFixed(),
  allocatedMarginAfterUsdt:margin.toFixed(),dailyNetUsdt:dailyNet.toFixed(),newEntryRiskUsdt:risk.toFixed(),
  sampledMaxDrawdownUsdt:maxDrawdown.toFixed(),positions:positions.map(position=>({mode:position.mode,
   tradeId:position.tradeId,pair:position.pair,isShort:position.isShort,notionalUsdt:position.notional.toFixed(),riskUsdt:position.risk.toFixed()}))};
}

function groupStats(tradesByMode,asOf,warnings,scope){
 let realized=new Decimal(0),unrealized=new Decimal(0),fees=new Decimal(0),feeComplete=true,valid=true;
 let closed=0,open=0,wins=0,losses=new Decimal(0),winning=new Decimal(0);
 const records=[];
 for(const mode of MODES){
  const trades=tradesByMode[mode]??[],evaluation=evaluatePerformance({trades,mode,observedAt:asOf});
  if(evaluation.diagnostics.length){valid=false;for(const diagnostic of evaluation.diagnostics)warnings.push({scope,mode,...diagnostic});}
  for(const trade of trades){
   const net=decimal(trade.profit_abs);
   if(trade.is_open===false){
    closed++;if(net){realized=realized.plus(net);if(net.gt(0)){wins++;winning=winning.plus(net);}else if(net.lt(0))losses=losses.minus(net);}
    else valid=false;
   }else if(trade.is_open===true){
    open++;
    try{openPosition(trade,mode);unrealized=unrealized.plus(net);}catch{valid=false;warnings.push({code:'PORTFOLIO_POSITION_MARK_UNAVAILABLE',scope,mode,tradeId:trade.trade_id});}
   }
   for(const side of trade.is_open===false?['open','close']:['open']){
    const fee=decimal(trade['fee_'+side+'_cost']);
    // Freqtrade stores fee cost in quote units regardless of the paid-asset
    // label. Keep this as engine accounting, not original commission proof.
    if(fee===null||fee.lt(0))feeComplete=false;else fees=fees.plus(fee);
   }
   records.push({mode,tradeId:trade.trade_id,pair:trade.pair,tag:trade.enter_tag,isOpen:trade.is_open,
    netRealizedUsdt:trade.is_open===false?net?.toFixed()??null:null,
    unrealizedUsdt:trade.is_open===true?net?.toFixed()??null:null});
  }
 }
 return {closedTrades:closed,openTrades:open,pnlComplete:valid,netRealizedUsdt:valid?realized.toFixed():null,
  unrealizedUsdt:valid?unrealized.toFixed():null,netPnlUsdt:valid?realized.plus(unrealized).toFixed():null,
  knownNetRealizedUsdt:realized.toFixed(),knownUnrealizedUsdt:unrealized.toFixed(),winRate:valid&&closed?wins/closed:null,
  averageNetRealizedUsdt:valid&&closed?realized.div(closed).toSignificantDigits(20).toFixed():null,
  profitFactor:valid&&losses.gt(0)?winning.div(losses).toNumber():null,
  engineFeesUsdt:feeComplete?fees.toFixed():null,knownEngineFeesUsdt:fees.toFixed(),feesComplete:feeComplete,
  originalExchangeCommissions:null,trades:records};
}

function slippage(tradesByMode,quotes,asOf){
 let amount=new Decimal(0),covered=0,required=0;const missing=[];
 for(const mode of MODES)for(const trade of tradesByMode[mode]){
  if(!Array.isArray(trade.orders)||!trade.orders.length){missing.push({mode,tradeId:trade.trade_id,reason:'filled_orders_missing'});continue;}
  const seen=new Set();let entries=0,exits=0;
  for(const order of trade.orders){
   const filled=decimal(order?.filled);if(filled?.isZero())continue;
   required++;const id=order?.order_id??order?.id,quote=quotes?.[mode]?.[String(id)],average=decimal(order?.average);
   const reference=decimal(quote?.price),side=order?.ft_order_side??order?.side,cost=decimal(order?.cost),remaining=decimal(order?.remaining),quantity=decimal(order?.amount);
   const expectedSide=order?.ft_is_entry?(trade.is_short?'sell':'buy'):(trade.is_short?'buy':'sell');
   if(!text(String(id??''))||seen.has(String(id))||!filled?.gt(0)||!average?.gt(0)||!cost?.gt(0)||!remaining?.isZero()||
    !quantity?.gt(0)||!filled.eq(quantity)||typeof order?.ft_is_entry!=='boolean'||side!==expectedSide||
    order?.is_open!==false||order?.status!=='closed'||!reference?.gt(0)||
    quote?.side!==side||quote?.pair!==trade.pair||quote?.source!==(mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com')||
    !fresh(quote?.observedAt,Date.parse(quote?.submittedAt),15)||Date.parse(quote?.submittedAt)>Date.parse(asOf)||
    cost.minus(filled.mul(average)).abs().gt(Decimal.max(cost.abs().mul('1e-8'),'1e-8'))){
    missing.push({mode,tradeId:trade.trade_id,orderId:id??null,reason:'fill_or_pre_submit_quote_evidence_missing'});continue;
   }
   seen.add(String(id));covered++;if(order.ft_is_entry)entries++;else exits++;
   amount=amount.plus(average.minus(reference).mul(filled).mul(side==='buy'?1:-1));
  }
  if(!entries||(trade.is_open===false&&!exits))missing.push({mode,tradeId:trade.trade_id,reason:'entry_or_exit_fill_quote_coverage_missing'});
 }
 const complete=required>0&&covered===required&&missing.length===0;
 return {actualSignedSlippageUsdt:complete?amount.toFixed():null,coveredOrders:covered,requiredOrders:required,missing,
  method:'Signed filled average minus contemporaneous pre-submit side quote, times actual filled quantity; positive is adverse. Already reflected in actual PnL, not deducted again.'};
}

/**
 * Combined $2,000 budget ledger; no account balance or external deposit input.
 * baseline = {startedAt,source:'freqtrade-demo',historyCompleteByMode:{demo:true,'demo-futures':true},
 * excludedTradeIdsByMode:{demo:[], 'demo-futures':[]},
 * tagAttributionByMode:{demo:{[exactEnterTag]:{purpose:'strategy'|'execution_probe',version:string}},'demo-futures':{}}}.
 * All baseline-existing trade IDs, including positions, must be excluded here;
 * they remain included by assessPortfolio in actual exposure and daily loss.
 * samples are prior report.sample records, persisted append-only by the caller.
 */
export function buildPortfolioReport({histories,baseline,config=PORTFOLIO_DEFAULTS,asOf,samples=[],executionQuotesByMode={}}={}){
 const p=validatePortfolioConfig(config),warnings=[],ignored=[];
 if(!object(baseline)||!timestamp(baseline.startedAt)||!timestamp(asOf)||Date.parse(baseline.startedAt)>Date.parse(asOf))fail('PORTFOLIO_BASELINE_INVALID');
 if(baseline.source!=='freqtrade-demo')warnings.push({code:'PORTFOLIO_SOURCE_UNATTESTED'});
 const all={demo:[],'demo-futures':[]},strategy={demo:[],'demo-futures':[]},probes={demo:[],'demo-futures':[]},versions=new Map();
 for(const mode of MODES){
  const history=histories?.[mode],excluded=baseline.excludedTradeIdsByMode?.[mode],tags=baseline.tagAttributionByMode?.[mode];
  if(!Array.isArray(history)||baseline.historyCompleteByMode?.[mode]!==true)warnings.push({code:'PORTFOLIO_HISTORY_INCOMPLETE',mode});
  if(!Array.isArray(excluded)||excluded.some(id=>!key(id))||new Set(excluded?.map(key)).size!==excluded?.length||!object(tags)){
   warnings.push({code:'PORTFOLIO_BASELINE_INVALID',mode});continue;
  }
  const exclude=new Set(excluded.map(key)),seen=new Set();
  for(const trade of Array.isArray(history)?history:[]){
   const id=key(trade?.trade_id);
   if(!object(trade)||!id||seen.has(id)){warnings.push({code:'PORTFOLIO_TRADE_INVALID_OR_DUPLICATE',mode,tradeId:trade?.trade_id??null});continue;}
   seen.add(id);
   if(exclude.has(id)){ignored.push({mode,tradeId:trade.trade_id,reason:'baseline_excluded'});continue;}
   if(!Number.isSafeInteger(trade.open_timestamp)||trade.open_timestamp<Date.parse(baseline.startedAt)){
    warnings.push({code:'PORTFOLIO_UNLISTED_BASELINE_TRADE',mode,tradeId:trade.trade_id});continue;
   }
   const attribution=Object.hasOwn(tags,trade.enter_tag)?tags[trade.enter_tag]:null;
   if(!object(attribution)||!['strategy','execution_probe'].includes(attribution.purpose)||!text(attribution.version)||
    (trade.trial_version!==undefined&&trade.trial_version!==attribution.version)||
    (trade.strategyVersion!==undefined&&trade.strategyVersion!==attribution.version)){
    warnings.push({code:'PORTFOLIO_TRADE_UNATTRIBUTED',mode,tradeId:trade.trade_id});continue;
   }
   all[mode].push(trade);(attribution.purpose==='strategy'?strategy:probes)[mode].push(trade);
   const versionKey=attribution.purpose+':'+attribution.version;
   if(!versions.has(versionKey))versions.set(versionKey,{purpose:attribution.purpose,version:attribution.version,trades:{demo:[],'demo-futures':[]}});
   versions.get(versionKey).trades[mode].push(trade);
  }
  for(const id of exclude)if(!seen.has(id))warnings.push({code:'PORTFOLIO_BASELINE_TRADE_MISSING',mode,tradeId:id});
 }
 const total=groupStats(all,asOf,warnings,'all'),strategySummary=groupStats(strategy,asOf,[],'strategy'),probeSummary=groupStats(probes,asOf,[],'probes');
 const byVersion=[...versions.values()].map(group=>({purpose:group.purpose,version:group.version,...groupStats(group.trades,asOf,[],'version')}));
 let peak=new Decimal(p.capitalUsdt),maxDrawdown=new Decimal(0),lastAt=Date.parse(baseline.startedAt)-1,maxGap=0,validSamples=0;
 if(!Array.isArray(samples))warnings.push({code:'PORTFOLIO_SAMPLES_INVALID'});
 for(const sample of Array.isArray(samples)?samples:[]){
  const value=decimal(sample?.budgetEquityUsdt),at=Date.parse(sample?.asOf);
  if(!object(sample)||sample.source!==PORTFOLIO_SOURCE||sample.evidenceComplete!==true||sample.startedAt!==baseline.startedAt||
   sample.capitalUsdt!==p.capitalUsdt||!value||!Number.isFinite(at)||at<Date.parse(baseline.startedAt)||at> Date.parse(asOf)||at<=lastAt){
   warnings.push({code:'PORTFOLIO_SAMPLE_INVALID',asOf:timestamp(sample?.asOf)?sample.asOf:null});continue;
  }
  if(validSamples)maxGap=Math.max(maxGap,at-lastAt);lastAt=at;validSamples++;
  peak=Decimal.max(peak,value);maxDrawdown=Decimal.max(maxDrawdown,peak.minus(value));
 }
 const equity=total.netPnlUsdt===null?null:new Decimal(p.capitalUsdt).plus(total.netPnlUsdt);
 let currentDrawdown=null;
 if(equity){
  if(validSamples)maxGap=Math.max(maxGap,Date.parse(asOf)-lastAt);
  peak=Decimal.max(peak,equity);currentDrawdown=peak.minus(equity);maxDrawdown=Decimal.max(maxDrawdown,currentDrawdown);
 }
 const complete=warnings.length===0&&total.pnlComplete;
 const sample={source:PORTFOLIO_SOURCE,asOf,startedAt:baseline.startedAt,capitalUsdt:p.capitalUsdt,
  evidenceComplete:complete,budgetEquityUsdt:complete?equity.toFixed():null};
 return {schemaVersion:1,source:PORTFOLIO_SOURCE,asOf,startedAt:baseline.startedAt,capitalUsdt:p.capitalUsdt,evidenceComplete:complete,
  netRealizedUsdt:complete?total.netRealizedUsdt:null,unrealizedUsdt:complete?total.unrealizedUsdt:null,
  netPnlUsdt:complete?total.netPnlUsdt:null,budgetEquityUsdt:sample.budgetEquityUsdt,
  returnPct:complete?equity.minus(p.capitalUsdt).div(p.capitalUsdt).mul(100).toFixed():null,
  sampledMaxDrawdownUsdt:complete?maxDrawdown.toFixed():null,currentDrawdownUsdt:complete?currentDrawdown.toFixed():null,
  drawdownLimitBreached:complete?maxDrawdown.gte(p.maxDrawdownUsdt):null,
  sampleCount:validSamples+1,maxSampleGapSeconds:maxGap/1000,sample,total,strategy:strategySummary,probes:probeSummary,byVersion,
  executionCosts:slippage(all,executionQuotesByMode,asOf),ignored,warnings,
  notes:[
   'Capital is the configured shared Demo budget, never the full exchange Demo balance. Deposits, transfers and excluded baseline trades do not create strategy profit.',
   'profit_abs is Freqtrade net accounting including recorded fees/funding; recorded engine fees and measured slippage are descriptive and are not subtracted again.',
   'Connectivity probes consume the budget but are separate from strategy performance and every version has its own cohort.',
   'Drawdown is measured from persisted budget-equity samples plus the current read; it can miss unsampled intracycle extremes. Historical threshold breaches remain latched.',
   'The caller must attest both complete Demo histories, persist every valid sample and hold a cross-mode lock for new-entry checks. This module never places an order.'
  ]};
}
