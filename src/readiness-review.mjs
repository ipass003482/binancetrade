// Read-only evidence review. No order, strategy-change or promotion authority.
import Decimal from 'decimal.js';
import {evaluatePerformance} from './performance.mjs';
import {jsonFetch} from './http.mjs';

const MODES=['demo','demo-futures'];
const key=(mode,t)=>mode+':'+String(t.tradeId??t.trade_id);
const numeric=value=>{
 if(!['string','number'].includes(typeof value)||String(value).length>128)throw Error('READINESS_NUMBER_INVALID');
 const n=new Decimal(value);if(!n.isFinite()||(!n.isZero()&&Math.abs(n.e)>50))throw Error('READINESS_NUMBER_INVALID');return n;
};
const sum=rows=>rows.reduce((a,b)=>a.plus(b),new Decimal(0));
const taipeiMonth=timestamp=>new Date(timestamp+8*3600000).toISOString().slice(0,7);
const monthStart=month=>Date.parse(month+'-01T00:00:00+08:00');

export function buildReadinessReview({portfolio,histories,currentVersion,thresholds,observedAt}={}){
 const at=Date.parse(observedAt),start=Date.parse(portfolio?.startedAt);
 if(portfolio?.source!=='freqtrade-demo-portfolio'||portfolio.evidenceComplete!==true||
  !Number.isFinite(at)||!Number.isFinite(start)||start>at||!currentVersion||
  !Array.isArray(portfolio.byVersion)||!Array.isArray(portfolio.total?.trades)||
  !Number.isFinite(Date.parse(portfolio.asOf))||Math.abs(at-Date.parse(portfolio.asOf))>15000)
  throw Error('READINESS_PORTFOLIO_UNVERIFIED');
 const members=new Map(),rows=[],modeReviews={};
 for(const group of portfolio.byVersion){
  if(!['strategy','execution_probe'].includes(group.purpose)||typeof group.version!=='string'||!group.version||!Array.isArray(group.trades))
   throw Error('READINESS_ATTRIBUTION_INVALID');
  for(const ref of group.trades){
   const id=key(ref.mode,ref);
   if(!MODES.includes(ref.mode)||members.has(id))throw Error('READINESS_ATTRIBUTION_INVALID');
   members.set(id,{...ref,purpose:group.purpose,version:group.version});
  }
 }
 const expected=new Set(portfolio.total.trades.map(t=>key(t.mode,t)));
 if(expected.size!==portfolio.total.trades.length||expected.size!==members.size||[...members.keys()].some(k=>!expected.has(k)))
  throw Error('READINESS_ATTRIBUTION_INVALID');
 for(const mode of MODES){
  const history=histories?.[mode],selected=[],versions={};
  if(!Array.isArray(history)||new Set(history.map(t=>t.trade_id)).size!==history.length)throw Error('READINESS_HISTORY_INVALID');
  for(const ref of [...members.values()].filter(t=>t.mode===mode)){
   const trade=history.find(t=>String(t.trade_id)===String(ref.tradeId));
   if(!trade||trade.pair!==ref.pair||trade.enter_tag!==ref.tag||trade.is_open!==ref.isOpen||
    !Number.isSafeInteger(trade.open_timestamp)||trade.open_timestamp<start||trade.open_timestamp>at)
    throw Error('READINESS_HISTORY_CHANGED');
   if(!trade.is_open&&(!Number.isSafeInteger(trade.close_timestamp)||trade.close_timestamp<trade.open_timestamp||
     trade.close_timestamp>at||!numeric(trade.profit_abs).eq(numeric(ref.netRealizedUsdt))))throw Error('READINESS_HISTORY_CHANGED');
   rows.push({mode,ref,trade});
   if(ref.purpose==='strategy'){selected.push(trade);versions[trade.trade_id]=ref.version;}
  }
  const evaluation=evaluatePerformance({trades:selected,tradeVersions:versions,currentVersion,thresholds,mode,observedAt});
  if(!evaluation.summary.pnlComplete)throw Error('READINESS_HISTORY_INVALID');
  const parameterVariants=Object.fromEntries([...new Set(Object.values(versions))].filter(v=>v.startsWith(currentVersion+'/volume-forward-v1/'))
   .map(variant=>[variant,evaluatePerformance({trades:selected,tradeVersions:versions,currentVersion:variant,thresholds,mode,observedAt}).currentVersion]));
  modeReviews[mode]={currentVersion:evaluation.currentVersion,parameterVariants,allStrategyVersions:evaluation.summary,
   byPair:evaluation.cohorts.pair,byDirection:evaluation.cohorts.direction};
 }
 const months=new Map();
 function monthRecord(month){
  if(!months.has(month))months.set(month,{month,calendarMonthClosed:month<taipeiMonth(at),
   experimentCoversMonthStart:start<=monthStart(month),groups:[]});
  return months.get(month);
 }
 monthRecord(taipeiMonth(at));
 const groups=new Map();
 for(const {mode,ref,trade} of rows.filter(r=>!r.trade.is_open)){
  const month=taipeiMonth(trade.close_timestamp),id=JSON.stringify([month,mode,ref.purpose,ref.version]);
  if(!groups.has(id))groups.set(id,{month,mode,purpose:ref.purpose,version:ref.version,trades:[]});
  groups.get(id).trades.push(trade);
 }
 for(const group of groups.values()){
  const nets=group.trades.map(t=>numeric(t.profit_abs)),fees=[];let feesComplete=true;
  for(const t of group.trades)for(const side of ['open','close']){
   try{const n=numeric(t['fee_'+side+'_cost']);if(n.lt(0))throw Error('NEGATIVE_FEE');fees.push(n);}catch{feesComplete=false;}
  }
  const net=sum(nets),feeTotal=feesComplete?sum(fees):null;
  monthRecord(group.month).groups.push({mode:group.mode,purpose:group.purpose,version:group.version,
   closedTrades:nets.length,winningTrades:nets.filter(n=>n.gt(0)).length,losingTrades:nets.filter(n=>n.lt(0)).length,
   netRealizedUsdt:net.toFixed(),closedTradeRecordedFeesUsdt:feeTotal?.toFixed()??null,
   netPlusRecordedFeesUsdt:feeTotal?net.plus(feeTotal).toFixed():null,
   tradeIds:group.trades.map(t=>t.trade_id)});
 }
 return {schemaVersion:1,source:'freqtrade-demo-readiness-review',observedAt,currentVersion,timeZone:'Asia/Taipei',
  portfolioAsOf:portfolio.asOf,capitalUsdt:portfolio.capitalUsdt,netPnlUsdt:portfolio.netPnlUsdt,
  sampledMaxDrawdownUsdt:portfolio.sampledMaxDrawdownUsdt,thresholds,modeReviews,
  monthlyRealized:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)),
  openTrades:rows.filter(r=>r.trade.is_open).map(({mode,ref})=>({mode,tradeId:ref.tradeId,pair:ref.pair,version:ref.version})),
  monthlyEquityReturns:null,liveExecutionEvidence:null,monthlyProfitabilityValidated:false,promotionAuthorized:false,
  notes:[
   'Monthly rows allocate each closed trade lifetime net PnL to its Taipei close month. They are not mark-to-market monthly returns; month-boundary unrealized marks are not reconstructed.',
   'Open losses remain in the shared equity/PnL and drawdown. No short sample is annualized or projected into monthly income.',
   'Fees are descriptive and already in profit_abs. Adding them back tests whether fees alone explain losses; signed funding remains included.',
   'The existing 100-trade/30-day/PF 1.2 research criteria are unchanged. They do not establish live readiness or monthly profit; each mode and version is assessed separately.',
   'Extra-cost stress is hypothetical, clearly separate from actual Demo results. Passing preliminary criteria is not authorization to switch to real money.'
  ]};
}

const SOURCES={
 demo:['https://demo-api.binance.com/api/v3/ticker/bookTicker','https://data-api.binance.vision/api/v3/ticker/bookTicker'],
 'demo-futures':['https://demo-fapi.binance.com/fapi/v1/ticker/bookTicker','https://fapi.binance.com/fapi/v1/ticker/bookTicker']
};
export async function collectMarketComparison({pairsByMode,fetchImpl=fetch,now=()=>Date.now()}={}){
 const rows=[];
 for(const mode of MODES){
  const pairs=pairsByMode?.[mode];
  if(!Array.isArray(pairs)||pairs.length>10||new Set(pairs).size!==pairs.length||pairs.some(p=>typeof p!=='string'||
   !(mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/).test(p)))throw Error('COMPARISON_PAIRS_INVALID');
  for(const pair of pairs){
   const symbol=pair.split(':')[0].replace('/','');
   try{
    const values=await Promise.all(SOURCES[mode].map(async source=>{
     const startedAt=now(),book=await jsonFetch(source+'?symbol='+symbol,{fetchImpl,timeoutMs:6000}),receivedAt=now();
     if(book.symbol!==symbol)throw Error('COMPARISON_SYMBOL_INVALID');
     const bid=numeric(book.bidPrice),ask=numeric(book.askPrice);
     if(bid.lte(0)||ask.lt(bid)||receivedAt<startedAt)throw Error('COMPARISON_QUOTE_INVALID');
     return {source,startedAt,receivedAt,bid:bid.toFixed(),ask:ask.toFixed(),mid:bid.plus(ask).div(2).toFixed(),
      spreadBps:ask.minus(bid).div(bid.plus(ask).div(2)).mul(10000).toFixed(),exchangeUpdateAt:Number.isSafeInteger(book.time)?book.time:null};
    }));
    const [demo,production]=values,skewMs=Math.abs(demo.receivedAt-production.receivedAt),
     bounded=skewMs<=5000&&values.every(v=>v.receivedAt-v.startedAt<=5000);
    rows.push({mode,pair,status:bounded?'observed':'timing_unbounded',demo,production,receiptSkewMs:skewMs,
     midDifferenceBps:bounded?numeric(demo.mid).minus(production.mid).div(production.mid).mul(10000).toFixed():null});
   }catch(error){rows.push({mode,pair,status:'unavailable',error:/^[A-Z][A-Z0-9_]+/.exec(String(error.message))?.[0]??'COMPARISON_READ_FAILED'});}
  }
 }
 return {source:'public-order-book-comparison',observedAt:new Date(now()).toISOString(),readOnly:true,rows,
  note:'Unsigned GET market data only. Quotes are near-contemporaneous HTTP observations, not synchronized fills or an arbitrage signal. Equal quotes cannot prove equal depth, fees, slippage or live profitability.'};
}
