import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {assessOrderFlow,assessSpotFlowContinuation,FLOW_ONLY_POLICY,FLOW_VERSION,SPOT_FLOW_CONTINUATION_VERSION,SPOT_FLOW_QUALITY_VERSION} from './order-flow.mjs';

export const SPOT_FLOW_OBSERVER_VERSION='spot-flow-observer-v1';
export const SPOT_FLOW_HORIZONS_MS=Object.freeze([60000,300000,900000]);
export const SPOT_FLOW_LATENESS_MS=20000;
export const SPOT_FLOW_COHORT_VERSION='spot-flow-anchor-cohort-v1';
const MAX_STREAMS=64;
const unavailable=reason=>({version:SPOT_FLOW_OBSERVER_VERSION,status:'unavailable',reason});
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const dec=v=>{if(!['string','number'].includes(typeof v))throw Error();const n=new Decimal(v);if(!n.isFinite()||n.lte(0)||Math.abs(n.e)>50)throw Error();return n;};
const optionalCost=(value,source)=>{
 if(value===null||value===undefined||typeof source!=='string'||!source.trim()||source.length>200)return null;
 try{if(!['number','string'].includes(typeof value))return null;const n=new Decimal(value);return n.isFinite()&&n.gte(0)&&n.lte(10000)?n.toFixed():null;}catch{return null;}
};
const streamKey=o=>`${o.policy}|${o.pair}`;
const validPolicy=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,99}$/.test(v);

// Legacy records have no cohort; never infer their continuation qualification.
// The recorded sampled quote is not the later bridge quote or a cost/capacity check.
export function validSpotFlowSignalCohort(o){
 if(o?.signalCohort===undefined)return true;
 try{
  const c=o.signalCohort;
  return c?.version===SPOT_FLOW_COHORT_VERSION&&c.entryPolicyVersion===o.policy&&validPolicy(c.executionQualityVersion)
   &&c.baseFlowVersion===FLOW_VERSION&&typeof c.baseFlowEligible==='boolean'&&c.baseFlowEligible===o.eligible
   &&c.priceContinuationVersion===SPOT_FLOW_CONTINUATION_VERSION&&typeof c.priceContinuationEligible==='boolean'
   &&c.quoteBasis==='last_sampled_book'&&integer(c.originQuoteAt)&&integer(c.quoteAt)&&c.originQuoteAt<c.quoteAt&&c.quoteAt===o.sampledAt
   &&c.quoteBid===o.bid&&c.quoteAsk===o.ask&&dec(c.quoteBid).lt(dec(c.quoteAsk))
   &&c.priceContinuationEligible===dec(c.quoteAsk).gt(dec(c.originAsk))
   &&c.baseAndContinuationEligible===(c.baseFlowEligible&&c.priceContinuationEligible)
   &&c.costsEvaluated===false&&c.capacityEvaluated===false&&c.orderEligibility===null;
 }catch{return false;}
}

// Observation only. This module has no I/O, order calls, entry gates or PnL.
// additionalCostBps excludes spread: ask-to-future-bid already contains it.
export function makeSpotFlowObservation(proof,{now,assessment,policy=FLOW_ONLY_POLICY,additionalCostBps=null,costSource=null}={}){
 try{
  if(!integer(now)||!validPolicy(policy)||proof?.mode!=='demo'||!/^([A-Z0-9]+)\/USDT$/.test(proof?.pair??''))return unavailable('OBSERVER_IDENTITY');
  const checked=assessOrderFlow(proof,{mode:'demo',pair:proof.pair,long:true,now});
  if(checked.status!=='ok')return unavailable(checked.reason??'OBSERVER_FLOW_INVALID');
  if(assessment&&(assessment.status!==checked.status||assessment.eligible!==checked.eligible))return unavailable('OBSERVER_ASSESSMENT_MISMATCH');
  const book=proof.books.at(-1),bid=dec(book.bids[0][0]),ask=dec(book.asks[0][0]);
  const bidQty=dec(book.bids[0][1]),askQty=dec(book.asks[0][1]),mid=bid.plus(ask).div(2);
  const weightedMid=ask.mul(bidQty).plus(bid.mul(askQty)).div(bidQty.plus(askQty));
  const amounts=proof.trades.map(t=>dec(t.p).mul(dec(t.q))),total=amounts.reduce((a,n)=>a.plus(n),new Decimal(0));
  const shares=amounts.map(n=>n.div(total));
  const additional=optionalCost(additionalCostBps,costSource);
  const continuation=assessSpotFlowContinuation(proof,{bid:bid.toFixed(),ask:ask.toFixed()});
  if(continuation.status!=='ok')return unavailable('OBSERVER_CONTINUATION_INVALID');
  const signalCohort={version:SPOT_FLOW_COHORT_VERSION,entryPolicyVersion:policy,executionQualityVersion:SPOT_FLOW_QUALITY_VERSION,
   baseFlowVersion:FLOW_VERSION,baseFlowEligible:checked.eligible,priceContinuationVersion:continuation.version,
   priceContinuationEligible:continuation.eligible,baseAndContinuationEligible:checked.eligible&&continuation.eligible,
   quoteBasis:'last_sampled_book',originQuoteAt:proof.books[0].at,originAsk:continuation.originAsk,
   quoteAt:book.at,quoteBid:bid.toFixed(),quoteAsk:ask.toFixed(),costsEvaluated:false,capacityEvaluated:false,orderEligibility:null};
  return {
   version:SPOT_FLOW_OBSERVER_VERSION,status:'ok',mode:'demo',policy,pair:proof.pair,
   source:proof.source,sampledAt:book.at,observedAt:now,proofSha256:createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
   bid:bid.toFixed(),ask:ask.toFixed(),mid:mid.toFixed(),eligible:checked.eligible,signalCohort,
   features:{top1Imbalance:bidQty.minus(askQty).div(bidQty.plus(askQty)).toFixed(),weightedMid:weightedMid.toFixed(),
    weightedMidOffsetBps:weightedMid.div(mid).minus(1).mul(10000).toFixed(),spreadBps:ask.minus(bid).div(mid).mul(10000).toFixed(),
    takerBuyNotionalShare:checked.takerShare,top5Imbalances:[...checked.bookImbalances],midChangeBps:checked.midChangeBps,
    aggregateTradeCount:amounts.length,totalAggTradeNotional:total.toFixed(),maxAggTradeNotionalShare:Decimal.max(...shares).toFixed(),
    sumSquaredNotionalShares:shares.reduce((a,s)=>a.plus(s.mul(s)),new Decimal(0)).toFixed(),
    distinctBookUpdateIds:new Set(proof.books.map(b=>b.updateId)).size},
   checks:{tape:new Decimal(checked.takerShare).gte('.55'),depth:checked.bookImbalances.every(v=>new Decimal(v).gt(0)),mid:new Decimal(checked.midChangeBps).gt(0)},
   additionalCostBps:additional,costSource:additional===null?null:costSource,
   interpretation:'eligible is base flow only; signalCohort separately records sampled-quote continuation, not later execution-quote, cost or capacity eligibility; not an order or PnL'
  };
 }catch{return unavailable('OBSERVER_DATA_INVALID');}
}

export function createSpotFlowObserverState({startedAt,anchorIntervalMs=60000,maxPending=2048}={}){
 if(!integer(startedAt)||!integer(anchorIntervalMs)||anchorIntervalMs<10000||anchorIntervalMs>900000||!integer(maxPending)||maxPending<3||maxPending>4096)throw Error('OBSERVER_OPTIONS');
 return {version:SPOT_FLOW_OBSERVER_VERSION,startedAt,lastNow:startedAt,anchorIntervalMs,maxPending,streams:{},pending:[]};
}

function observationValid(o,now){
 try{return o?.version===SPOT_FLOW_OBSERVER_VERSION&&o.status==='ok'&&o.mode==='demo'&&o.source==='https://demo-api.binance.com'
  &&validPolicy(o.policy)&&/^[A-Z0-9]+\/USDT$/.test(o.pair)&&/^[a-f0-9]{64}$/.test(o.proofSha256)
  &&integer(o.sampledAt)&&integer(o.observedAt)&&o.sampledAt<=o.observedAt&&o.observedAt<=now&&o.observedAt-o.sampledAt<=45000
  &&dec(o.bid).lt(dec(o.ask))&&dec(o.mid).eq(dec(o.bid).plus(dec(o.ask)).div(2))&&typeof o.eligible==='boolean'&&validSpotFlowSignalCohort(o);
 }catch{return false;}
}

function stateValid(s){
 const envelope=s?.version===SPOT_FLOW_OBSERVER_VERSION&&integer(s.startedAt)&&integer(s.lastNow)&&s.lastNow>=s.startedAt
  &&integer(s.anchorIntervalMs)&&s.anchorIntervalMs>=10000&&s.anchorIntervalMs<=900000&&integer(s.maxPending)&&s.maxPending>=3&&s.maxPending<=4096
  &&s.streams&&typeof s.streams==='object'&&!Array.isArray(s.streams)&&Object.keys(s.streams).length<=MAX_STREAMS
  &&Array.isArray(s.pending)&&s.pending.length<=s.maxPending;
 if(!envelope)return false;
 try{
  for(const [key,stream] of Object.entries(s.streams)){
   const [policy,pair,...rest]=key.split('|');
   if(rest.length||!validPolicy(policy)||!/^[A-Z0-9]+\/USDT$/.test(pair)||!integer(stream.lastObservedAt)
    ||stream.lastObservedAt<s.startedAt||stream.lastObservedAt>s.lastNow
    ||!(stream.lastAnchorAt===null||(integer(stream.lastAnchorAt)&&stream.lastAnchorAt>=s.startedAt&&stream.lastAnchorAt<=stream.lastObservedAt))
    ||!stream.lastNonOverlap||typeof stream.lastNonOverlap!=='object'||Array.isArray(stream.lastNonOverlap))return false;
   for(const [horizon,at] of Object.entries(stream.lastNonOverlap))if(!SPOT_FLOW_HORIZONS_MS.includes(Number(horizon))||!integer(at)||at<s.startedAt||stream.lastAnchorAt===null||at>stream.lastAnchorAt)return false;
  }
  const pendingIds=new Set();
  for(const p of s.pending){
   const key=streamKey(p),stream=s.streams[key],id=`${p.anchorId}:${p.horizonMs}`;
   if(!stream||!/^[a-f0-9]{64}$/.test(p.anchorId)||!/^[a-f0-9]{64}$/.test(p.proofSha256)||pendingIds.has(id)
    ||!integer(p.anchorAt)||p.anchorAt<s.startedAt||p.anchorAt>s.lastNow||stream.lastAnchorAt===null||p.anchorAt>stream.lastAnchorAt
    ||!SPOT_FLOW_HORIZONS_MS.includes(p.horizonMs)||typeof p.nonOverlap!=='boolean'||typeof p.eligible!=='boolean'
    ||!dec(p.bid).lt(dec(p.ask))||!dec(p.mid).eq(dec(p.bid).plus(dec(p.ask)).div(2))
    ||(p.additionalCostBps===null?p.costSource!==null:optionalCost(p.additionalCostBps,p.costSource)!==p.additionalCostBps)
    ||!validSpotFlowSignalCohort({...p,sampledAt:p.anchorAt}))return false;
   pendingIds.add(id);
  }
  return true;
 }catch{return false;}
}

const finish=(p,o,now)=>{
 const base={version:SPOT_FLOW_OBSERVER_VERSION,kind:'hypotheticalQuoteMarkout',mode:'demo',policy:p.policy,pair:p.pair,anchorId:p.anchorId,
  anchorAt:p.anchorAt,anchorProofSha256:p.proofSha256,horizonMs:p.horizonMs,targetAt:p.anchorAt+p.horizonMs,
  nonOverlap:p.nonOverlap,anchorEligible:p.eligible,recordedAt:now,additionalCostBps:p.additionalCostBps,costSource:p.costSource,
  ...(p.signalCohort===undefined?{}:{anchorSignalCohort:structuredClone(p.signalCohort)}),
  interpretation:'hypothetical quote movement before fees unless explicit additional costs supplied; no order or fill; not PnL'};
 if(!o)return {...base,status:'missing',reason:'NO_VALID_QUOTE_WITHIN_20S',observedAt:null,sampledAt:null,elapsedMs:null,lateByMs:null,
  observationProofSha256:null,rawQuoteMarkoutBps:null,midMarkoutBps:null,afterAdditionalCostBps:null};
 const raw=dec(o.bid).div(p.ask).minus(1).mul(10000);
 return {...base,status:'observed',observedAt:o.observedAt,sampledAt:o.sampledAt,elapsedMs:o.sampledAt-p.anchorAt,lateByMs:o.sampledAt-base.targetAt,
  observationProofSha256:o.proofSha256,bid:o.bid,ask:o.ask,mid:o.mid,rawQuoteMarkoutBps:raw.toFixed(),
  midMarkoutBps:dec(o.mid).div(p.mid).minus(1).mul(10000).toFixed(),
  afterAdditionalCostBps:p.additionalCostBps===null?null:raw.minus(p.additionalCostBps).toFixed()};
};

// Call on every sampler tick, including ticks with no valid proof, so pending
// windows expire honestly. A fresh state never creates pre-start anchors.
// Persist state and emitted records together; replaying already emitted state is
// idempotent. Outputs contain deterministic record IDs for append-side dedupe.
export function advanceSpotFlowObserver(state,{now,observations=[]}={}){
 const diagnostics={acceptedObservations:0,invalidObservations:0,duplicateObservations:0,preStartObservations:0,capacitySkipped:0};
 if(!stateValid(state)||!integer(now)||now<state.lastNow||!Array.isArray(observations))return {state,records:[],diagnostics:{...diagnostics,error:'OBSERVER_STATE_OR_TIME_INVALID'}};
 try{
  const next=structuredClone(state),records=[];
  const ordered=observations.filter(o=>{if(observationValid(o,now))return true;diagnostics.invalidObservations++;return false;})
   .sort((a,b)=>a.observedAt-b.observedAt||a.sampledAt-b.sampledAt||streamKey(a).localeCompare(streamKey(b)));
  for(const o of ordered){
   if(o.sampledAt<next.startedAt||o.observedAt<state.lastNow){diagnostics.preStartObservations++;continue;}
   const key=streamKey(o),existing=next.streams[key];
   if(existing&&o.sampledAt<=existing.lastObservedAt){diagnostics.duplicateObservations++;continue;}
   if(!existing&&Object.keys(next.streams).length>=MAX_STREAMS){diagnostics.capacitySkipped++;continue;}
   const stream=existing??{lastObservedAt:null,lastAnchorAt:null,lastNonOverlap:{}};
   stream.lastObservedAt=o.sampledAt;next.streams[key]=stream;diagnostics.acceptedObservations++;
   const remaining=[];
   for(const p of next.pending){
    const target=p.anchorAt+p.horizonMs;
    if(streamKey(p)===key&&o.sampledAt>=target&&o.sampledAt<=target+SPOT_FLOW_LATENESS_MS&&o.observedAt<=target+SPOT_FLOW_LATENESS_MS){
     records.push(finish(p,o,now));
    }else remaining.push(p);
   }
   next.pending=remaining;
   if(stream.lastAnchorAt!==null&&o.sampledAt-stream.lastAnchorAt<next.anchorIntervalMs)continue;
   if(next.pending.length+SPOT_FLOW_HORIZONS_MS.length>next.maxPending){diagnostics.capacitySkipped++;continue;}
   const id=createHash('sha256').update(`${SPOT_FLOW_OBSERVER_VERSION}|${key}|${o.sampledAt}|${o.proofSha256}`).digest('hex');
   const cost=optionalCost(o.additionalCostBps,o.costSource);
   records.push({...o,kind:'spot-flow-anchor',anchorId:id,recordedAt:now,additionalCostBps:cost,costSource:cost===null?null:o.costSource,horizonsMs:[...SPOT_FLOW_HORIZONS_MS],
    ...(o.signalCohort===undefined?{}:{signalCohort:structuredClone(o.signalCohort)})});
   stream.lastAnchorAt=o.sampledAt;
   for(const horizonMs of SPOT_FLOW_HORIZONS_MS){
    const last=stream.lastNonOverlap[horizonMs],nonOverlap=last===undefined||o.sampledAt-last>=horizonMs;
    if(nonOverlap)stream.lastNonOverlap[horizonMs]=o.sampledAt;
    next.pending.push({anchorId:id,anchorAt:o.sampledAt,policy:o.policy,pair:o.pair,proofSha256:o.proofSha256,
     bid:o.bid,ask:o.ask,mid:o.mid,eligible:o.eligible,horizonMs,nonOverlap,additionalCostBps:cost,costSource:cost===null?null:o.costSource,
     ...(o.signalCohort===undefined?{}:{signalCohort:structuredClone(o.signalCohort)})});
   }
  }
  next.pending=next.pending.filter(p=>{if(now>p.anchorAt+p.horizonMs+SPOT_FLOW_LATENESS_MS){records.push(finish(p,null,now));return false;}return true;});
  next.lastNow=now;
  for(const record of records)record.recordId=record.kind==='spot-flow-anchor'?`anchor:${record.anchorId}`:`markout:${record.anchorId}:${record.horizonMs}`;
  return {state:next,records,diagnostics};
 }catch{return {state,records:[],diagnostics:{...diagnostics,error:'OBSERVER_STATE_INVALID'}};}
}
