import DecimalBase from 'decimal.js';

const Decimal=DecimalBase.clone({precision:40});
const decimal=value=>{
 if(!['string','number'].includes(typeof value)||String(value).length>128||!String(value).trim())return null;
 try{const n=new Decimal(value);return n.isFinite()&&(n.isZero()||Math.abs(n.e)<=50)?n:null;}catch{return null;}
};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const validId=value=>Number.isSafeInteger(value)&&value>0||typeof value==='string'&&/^[1-9]\d*$/.test(value);
const key=row=>JSON.stringify([String(row.tradeId),row.tag,row.pair,row.openedAt]);
const sum=values=>values.reduce((a,b)=>a.plus(b),new Decimal(0)).toFixed();

export function validateProfitObservation(row,mode){
 if(!row||row.schemaVersion!==1||row.source!=='freqtrade-demo-reported-pnl'||row.mode!==mode||
  !['demo','demo-futures'].includes(mode)||!validId(row.tradeId)||!/^codex-[a-f0-9]{32}$/.test(row.tag??'')||
  typeof row.pair!=='string'||!(mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/).test(row.pair)||
  typeof row.isOpen!=='boolean'||!iso(row.openedAt)||!iso(row.observedAt)||Date.parse(row.openedAt)>Date.parse(row.observedAt)||
  decimal(row.netUsdt)===null)throw Error('PROFIT_OBSERVATION_INVALID');
 return row;
}

// Identity comes from the reconciled forward report, never from time alone.
// profit_abs is copied from the engine; there is no price replay or estimated
// exit at an intrabar high. observedAt is API read time, not exchange quote time.
export function profitObservationBatch({report,trades}){
 if(report.validation?.evidenceComplete!==true)return [];
 const rows=[];
 for(const scope of ['strategy','probes'])for(const evidence of report[scope].trades){
  const matches=trades.filter(t=>String(t.trade_id)===String(evidence.tradeId)&&t.enter_tag===evidence.tag&&t.pair===evidence.pair);
  if(matches.length!==1)throw Error('PROFIT_TRADE_IDENTITY_AMBIGUOUS');
  const trade=matches[0],net=decimal(trade.profit_abs);
  if(net===null)continue;
  rows.push(validateProfitObservation({schemaVersion:1,source:'freqtrade-demo-reported-pnl',mode:report.mode,
   tradeId:trade.trade_id,tag:trade.enter_tag,pair:trade.pair,openedAt:evidence.openedAt,
   isOpen:trade.is_open,observedAt:report.asOf,netUsdt:net.toFixed()},report.mode));
 }
 return rows;
}

export function newProfitObservations(previous,batch,mode){
 const latest=new Map();
 for(const row of previous){validateProfitObservation(row,mode);const old=latest.get(key(row));
  if(old&&Date.parse(row.observedAt)<=Date.parse(old.observedAt))throw Error('PROFIT_OBSERVATION_TIME_INVALID');
  if(old?.isOpen===false&&row.isOpen)throw Error('PROFIT_CLOSED_TRADE_REOPENED');
  latest.set(key(row),row);
 }
 const result=[];
 for(const row of batch){validateProfitObservation(row,mode);const old=latest.get(key(row));
  if(old&&Date.parse(row.observedAt)<Date.parse(old.observedAt))throw Error('PROFIT_OBSERVATION_TIME_INVALID');
  if(old&&Date.parse(row.observedAt)===Date.parse(old.observedAt)){
   if(old.isOpen!==row.isOpen||old.netUsdt!==row.netUsdt)throw Error('PROFIT_OBSERVATION_CONFLICT');
   continue;
  }
  if(old?.isOpen===false&&row.isOpen)throw Error('PROFIT_CLOSED_TRADE_REOPENED');
  // Closed results are saved once, with subsequent accounting corrections kept.
  if(old?.isOpen===false&&!row.isOpen&&old.netUsdt===row.netUsdt)continue;
  result.push(row);latest.set(key(row),row);
 }
 return result;
}

function reviewTrade(evidence,trade,observations,asOf){
 const series=observations.filter(row=>key(row)===key(evidence)&&Date.parse(row.observedAt)<=Date.parse(asOf));
 const open=series.filter(row=>row.isOpen),net=decimal(trade?.profit_abs);
 const peak=open.length?open.reduce((a,b)=>decimal(a.netUsdt).gte(b.netUsdt)?a:b):null;
 let maxGap=0;
 for(let i=1;i<series.length;i++)maxGap=Math.max(maxGap,Date.parse(series[i].observedAt)-Date.parse(series[i-1].observedAt));
 // Never turn a missing fee into zero or subtract recorded fees a second time.
 // Freqtrade fee_*_cost is its quote-currency accounting, even if the paid
 // asset label is BNB. Original commission reconciliation is separate.
 const fees=['open',...(!evidence.isOpen?['close']:[])].map(side=>decimal(trade?.['fee_'+side+'_cost']));
 const feeComplete=fees.every(value=>value!==null&&value.gte(0));
 const positivePeak=peak&&decimal(peak.netUsdt).gt(0),giveback=positivePeak&&net?Decimal.max(0,decimal(peak.netUsdt).minus(net)):null;
 return {tradeId:evidence.tradeId,pair:evidence.pair,tag:evidence.tag,isOpen:evidence.isOpen,
  netRealizedUsdt:!evidence.isOpen?net?.toFixed()??null:null,
  netUnrealizedUsdt:evidence.isOpen?net?.toFixed()??null:null,
  exitReason:!evidence.isOpen&&typeof trade?.exit_reason==='string'?trade.exit_reason:null,
  holdingSeconds:(Date.parse(evidence.isOpen?asOf:evidence.closedAt)-Date.parse(evidence.openedAt))/1000,
  engineRecordedFeesUsdt:feeComplete?sum(fees):null,feeCoverage:evidence.isOpen?'entry_only':'entry_and_exit',
  openPnlSamples:open.length,firstObservedAt:series[0]?.observedAt??null,lastObservedAt:series.at(-1)?.observedAt??null,
  firstObservationDelaySeconds:series.length?(Date.parse(series[0].observedAt)-Date.parse(evidence.openedAt))/1000:null,
  sampledPeakNetUsdt:peak?.netUsdt??null,sampledPeakObservedAt:peak?.observedAt??null,
  sampledGivebackUsdt:giveback?.toFixed()??null,
  realizedToSampledPeakRatio:!evidence.isOpen&&positivePeak&&net?net.div(peak.netUsdt).toNumber():null,
  maxObservationGapSeconds:maxGap/1000};
}

export function buildProfitReview({report,trades,observations=[]}){
 if(report.validation?.evidenceComplete!==true)return {status:'incomplete_evidence',asOf:report.asOf,strategy:null,probes:null};
 // Validate retained history too; corruption cannot silently create a peak.
 newProfitObservations(observations,[],report.mode);
 const result={schemaVersion:1,status:'observed',asOf:report.asOf,source:'freqtrade-demo-reported-pnl',
  samplingBasis:'API read observations; no reconstruction of unobserved prices or executable peak exits.',
  feeBasis:'Engine quote-currency fee accounting already included in net PnL; open positions show entry fees only.',
  originalExchangeCommissions:null};
 for(const scope of ['strategy','probes']){
  const rows=report[scope].trades.map(evidence=>reviewTrade(evidence,trades.find(t=>String(t.trade_id)===String(evidence.tradeId)&&
   t.enter_tag===evidence.tag&&t.pair===evidence.pair),observations,report.asOf));
  const byExitReason=[];
  for(const reason of [...new Set(rows.filter(row=>!row.isOpen).map(row=>row.exitReason))].sort()){
   const closed=rows.filter(row=>!row.isOpen&&row.exitReason===reason),nets=closed.map(row=>decimal(row.netRealizedUsdt)),
    fees=closed.map(row=>decimal(row.engineRecordedFeesUsdt));
   byExitReason.push({exitReason:reason,closedTrades:closed.length,netRealizedUsdt:nets.every(n=>n!==null)?sum(nets):null,
    engineRecordedFeesUsdt:fees.every(n=>n!==null)?sum(fees):null,
    tradesWithOpenPnlSamples:closed.filter(row=>row.openPnlSamples>0).length});
  }
  result[scope]={trades:rows,byExitReason};
 }
 return result;
}
