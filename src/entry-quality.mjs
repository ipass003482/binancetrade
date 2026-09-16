import Decimal from 'decimal.js';
import { timeframeSpec } from './timeframe.mjs';
import { MODES,isEntry,isExit,isFutures } from './mode.mjs';

export const ENTRY_QUALITY_VERSION=1;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const result=(reasons,metrics=null)=>({eligible:reasons.length===0,reasons,metrics});
const timestamp=value=>typeof value==='string'?Date.parse(value):NaN;

function candleValues(candles,spec){
 const CANDLE_MS=spec.ms;
 if(!Array.isArray(candles)||candles.length<Math.max(20,spec.fourHourBars+1))throw Error('ENTRY_CANDLES_REQUIRED');
 return candles.map((c,i)=>{
  if(!record(c)||!Number.isSafeInteger(c.openTime)||c.openTime<0||c.openTime%CANDLE_MS!==0
   ||!Number.isSafeInteger(c.closeTime)||c.closeTime!==c.openTime+CANDLE_MS-1
   ||(i&&c.openTime!==candles[i-1].openTime+CANDLE_MS))throw Error('ENTRY_CANDLES_INVALID');
  const values={};
  for(const field of ['open','high','low','close','volume']){
   const raw=c[field];
   if(!['number','string'].includes(typeof raw)||(typeof raw==='string'&&!raw.trim()))throw Error('ENTRY_CANDLES_INVALID');
   try{values[field]=new Decimal(raw);}catch{throw Error('ENTRY_CANDLES_INVALID');}
   if(!values[field].isFinite()||(field==='volume'?values[field].lt(0):values[field].lte(0)))throw Error('ENTRY_CANDLES_INVALID');
  }
  const {open,high,low,close}=values;
  if(high.lt(Decimal.max(open,close,low))||low.gt(Decimal.min(open,close,high)))throw Error('ENTRY_CANDLES_INVALID');
  return values;
 });
}

// This gate enforces only the active prompts' numeric prerequisites. The h1/h4
// directions are the existing rolling close returns over 4/16 fifteen-minute
// bars; relative volume is the latest bar / the prior 19-bar mean. Qualitative
// structure, breakout confirmation and cost/price-space judgments remain with
// the analyst. Passing these prerequisites is not evidence of a trading edge.
export function evaluateEntryQuality({proposal,snapshot,analyst,now=Date.now()}={}){
 if(!record(proposal)||typeof proposal.action!=='string')throw Error('ENTRY_PROPOSAL_INVALID');
 // Exits and HOLD must remain available even without new-entry evidence.
 if(proposal.action==='hold'||isExit(proposal.action))return result([]);
 if(!isEntry(proposal.action))throw Error('ENTRY_ACTION_INVALID');
 if(!record(analyst)||!['active','conservative'].includes(analyst.style))throw Error('ENTRY_ANALYST_INVALID');
 if(analyst.style!=='active')return result([]);
 if(!Number.isSafeInteger(now)||now<0)throw Error('ENTRY_TIME_INVALID');
 if(!record(snapshot))return result(['ENTRY_SNAPSHOT_REQUIRED']);
 const spec=timeframeSpec(snapshot.timeframe),CANDLE_MS=spec.ms;
 const reasons=[],futures=isFutures(snapshot.mode),pair=proposal.pair;
 if(!MODES.includes(snapshot.mode)||(futures?proposal.action==='buy':proposal.action!=='buy'))return result(['ENTRY_ACTION_MODE_MISMATCH']);
 if(typeof pair!=='string'||!pair)return result(['ENTRY_PAIR_REQUIRED']);
 const asOf=timestamp(snapshot.createdAt);
 if(!Number.isFinite(asOf)||asOf>now||asOf<0)return result(['ENTRY_SNAPSHOT_TIME_INVALID']);
 if(snapshot.completedAt!==undefined){
  const completed=timestamp(snapshot.completedAt);
  if(!Number.isFinite(completed)||completed<asOf||completed>now)return result(['ENTRY_SNAPSHOT_TIME_INVALID']);
 }
 const marketId=(futures?'futures:':'spot:')+pair,technicalId='technical:'+pair;
 const evidence=Array.isArray(snapshot.evidence)?snapshot.evidence:[];
 for(const [id,kind] of [[marketId,'MARKET'],[technicalId,'TECHNICAL']]){
  const matches=evidence.filter(e=>record(e)&&e.id===id);
  if(matches.length!==1||matches[0].status!=='ok')reasons.push('ENTRY_'+kind+'_EVIDENCE_REQUIRED');
  else if(kind==='MARKET'?!record(matches[0].data)||matches[0].data.pair!==pair:matches[0].pair!==pair)
   reasons.push('ENTRY_'+kind+'_EVIDENCE_IDENTITY_INVALID');
 }
 if(!Array.isArray(proposal.evidenceIds)||!proposal.evidenceIds.includes(marketId))reasons.push('ENTRY_MARKET_CITATION_REQUIRED');
 const markets=Array.isArray(snapshot.markets)?snapshot.markets.filter(m=>record(m)&&m.pair===pair):[];
 if(markets.length!==1)return result([...reasons,'ENTRY_MARKET_REQUIRED']);
 const market=markets[0];
 if((futures?market.verifiedFutures:market.verifiedSpot)!==true)reasons.push('ENTRY_MARKET_UNVERIFIED');
 let values;
 try{values=candleValues(market.candles,spec);}catch(error){return result([...reasons,error.message]);}
 const candles=market.candles,lastCandle=candles.at(-1);
 // Anchor to collection start: later optional Web3 work must not move the
 // decision's candle boundary. The bridge separately enforces snapshot age.
 const boundary=snapshot.candleBoundary??Math.floor(asOf/CANDLE_MS)*CANDLE_MS;
 if(lastCandle.closeTime>=boundary)reasons.push('ENTRY_CANDLE_NOT_CLOSED');
 if(lastCandle.openTime!==boundary-CANDLE_MS)reasons.push('ENTRY_CANDLE_NOT_LATEST_COMPLETED');
 const mean=items=>items.reduce((sum,n)=>sum.plus(n),new Decimal(0)).div(items.length);
 const last=values.at(-1).close,closes=values.map(c=>c.close);
 const sma8=mean(closes.slice(-8)),sma20=mean(closes.slice(-20));
 const priorVolume=mean(values.slice(-20,-1).map(c=>c.volume)),volume=values.at(-1).volume;
 const long=proposal.action!=='open-short',direction=long?'long':'short';
 const metrics={version:ENTRY_QUALITY_VERSION,direction,timeframe:spec.timeframe,closedCandles:values.length,
  asOf:lastCandle.closeTime,snapshotAsOf:snapshot.createdAt,lastClose:last.toFixed(),sma8:sma8.toFixed(),sma20:sma20.toFixed(),
  return1hPct:last.div(closes.at(-1-spec.hourBars)).minus(1).mul(100).toFixed(),
  return4hPct:last.div(closes.at(-1-spec.fourHourBars)).minus(1).mul(100).toFixed(),
  volumeVsPrior19:priorVolume.eq(0)?null:volume.div(priorVolume).toFixed()};
 if(long?last.lte(closes.at(-1-spec.hourBars))||last.lte(closes.at(-1-spec.fourHourBars)):last.gte(closes.at(-1-spec.hourBars))||last.gte(closes.at(-1-spec.fourHourBars)))
  reasons.push('ENTRY_DIRECTION_NOT_ALIGNED');
 if(long?last.lte(sma8)||last.lte(sma20):last.gte(sma8)||last.gte(sma20))reasons.push('ENTRY_PRICE_NOT_BEYOND_BOTH_SMA');
 if(priorVolume.eq(0))reasons.push('ENTRY_RELATIVE_VOLUME_UNDEFINED');
 else if(volume.lt(priorVolume))reasons.push('ENTRY_RELATIVE_VOLUME_BELOW_ONE');
 return result(reasons,metrics);
}
