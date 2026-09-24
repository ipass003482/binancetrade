import { timeframeSpec,tradingTimeframe } from './timeframe.mjs';
import { clockRange } from './exchange-clock.mjs';
export const FLOW_DECISION_CADENCE_VERSION='flow-minute-v1';
export const FLOW_DECISION_INTERVAL_MS=60000;
export const AI_ENTRY_CADENCE_VERSION='model-closed5m-first-minute-v1';
export const AI_ENTRY_INTERVAL_MS=300000;
export const AI_ENTRY_WINDOW_MS=60000;
// The minute watcher still records quotes, holdings and risk. A new pinned
// forecast belongs only to the first minute of its completed 5m candle.
// This scheduling decision never makes stale evidence eligible for execution.
export function aiEntryWindow(snapshot,now=Date.parse(snapshot.completedAt??snapshot.createdAt)){
 const timing=decisionTiming(snapshot),boundary=snapshot.candleBoundary;
 if(!['demo','demo-futures'].includes(snapshot.mode)||snapshot.timeframe!=='5m'||
  !Number.isSafeInteger(boundary)||boundary<=0||boundary%AI_ENTRY_INTERVAL_MS!==0)
  throw Error('AI_ENTRY_TIMING_INVALID');
 const range=clockRange(snapshot.clock,snapshot.mode,now);
 if(range.lower<boundary||range.upper>=boundary+AI_ENTRY_INTERVAL_MS)throw Error('AI_ENTRY_CANDLE_SUPERSEDED');
 const due=(!timing||timing.boundary===boundary)&&range.upper<boundary+AI_ENTRY_WINDOW_MS;
 return {version:AI_ENTRY_CADENCE_VERSION,due,candleBoundary:boundary,
  entryDeadline:boundary+AI_ENTRY_WINDOW_MS,nextEntryBoundary:due?boundary:boundary+AI_ENTRY_INTERVAL_MS,
  reason:due?null:'MODEL_NEXT_CANDLE_WAIT'};
}
// Legacy candle strategies retain their candle identity. Kev order-flow
// snapshots use only a fresh minute identity, with no candle fallback.
export function decisionTiming(snapshot){
 const keys=['decisionCadenceVersion','decisionIntervalMs','decisionBoundary'];
 const kevFlow=snapshot.entryPolicyVersion==='kev-order-flow-v1'||snapshot.timeframe==='order-flow';
 if(kevFlow){
  const boundary=snapshot.decisionBoundary;
  if(!['demo','demo-futures'].includes(snapshot.mode)||snapshot.entryPolicyVersion!=='kev-order-flow-v1'||
   snapshot.timeframe!=='order-flow'||Object.hasOwn(snapshot,'candleBoundary')||
   snapshot.decisionCadenceVersion!==FLOW_DECISION_CADENCE_VERSION||snapshot.decisionIntervalMs!==FLOW_DECISION_INTERVAL_MS||
   !Number.isSafeInteger(boundary)||boundary<=0||boundary%FLOW_DECISION_INTERVAL_MS!==0)
   throw Error('DECISION_TIMING_INVALID');
  return {boundary,intervalMs:FLOW_DECISION_INTERVAL_MS,deadline:boundary+FLOW_DECISION_INTERVAL_MS};
 }
 if(!keys.some(key=>Object.hasOwn(snapshot,key)))return null;
 const boundary=snapshot.decisionBoundary,candle=snapshot.candleBoundary;
 if(!['demo','demo-futures'].includes(snapshot.mode)||snapshot.timeframe!=='5m'||
  snapshot.decisionCadenceVersion!==FLOW_DECISION_CADENCE_VERSION||snapshot.decisionIntervalMs!==FLOW_DECISION_INTERVAL_MS||
  !Number.isSafeInteger(boundary)||boundary<=0||boundary%FLOW_DECISION_INTERVAL_MS!==0||
  !Number.isSafeInteger(candle)||candle%300000!==0||boundary<candle||boundary>=candle+300000)
  throw Error('DECISION_TIMING_INVALID');
 return {boundary,intervalMs:FLOW_DECISION_INTERVAL_MS,deadline:boundary+FLOW_DECISION_INTERVAL_MS};
}
export function clockDecisionBoundary(clock,mode,now=Date.now()){
 if(!['demo','demo-futures'].includes(mode))throw Error('DECISION_TIMING_MODE_REJECTED');
 const range=clockRange(clock,mode,now),boundary=Math.floor(range.lower/FLOW_DECISION_INTERVAL_MS)*FLOW_DECISION_INTERVAL_MS;
 if(Math.floor(range.upper/FLOW_DECISION_INTERVAL_MS)*FLOW_DECISION_INTERVAL_MS!==boundary)throw Error('CLOCK_DECISION_BOUNDARY_UNCERTAIN');
 return boundary;
}
export function clockBoundary(clock,mode,now=Date.now()){
 const CANDLE_MS=timeframeSpec(tradingTimeframe(mode)).ms;
 const range=clockRange(clock,mode,now);
 const boundary=Math.floor(range.lower/CANDLE_MS)*CANDLE_MS;
 if(Math.floor(range.upper/CANDLE_MS)*CANDLE_MS!==boundary)throw Error('CLOCK_CANDLE_BOUNDARY_UNCERTAIN');
 return boundary;
}
export function verifyEntryTiming({snapshot,pair,mode,clock,now=Date.now()}){
 if(snapshot.mode!==mode)throw Error('TIMING_MODE_MISMATCH');
 if(snapshot.entryPolicyVersion==='kev-order-flow-v1'||snapshot.timeframe==='order-flow'){
  const decision=decisionTiming(snapshot),matches=snapshot.markets?.filter(m=>m.pair===pair)??[];
  if(matches.length!==1||matches[0].mode!==mode||matches[0].timeframe!=='order-flow'||
   Object.hasOwn(matches[0],'candles')||Object.hasOwn(matches[0],'candleBoundary'))throw Error('TIMING_MARKET_MISMATCH');
  const range=clockRange(clock,mode,now);
  if(clockDecisionBoundary(clock,mode,now)!==decision.boundary||
   clockDecisionBoundary(snapshot.clock,mode,Date.parse(snapshot.createdAt))!==decision.boundary)
   throw Error('SIGNAL_DECISION_SUPERSEDED');
  return {boundary:decision.boundary,decisionBoundary:decision.boundary,decisionDeadline:decision.deadline,
   // Existing transport callers use this as a local-wall-clock expiry. It
   // reflects the minute deadline only; no candle enters this calculation.
   candleDeadline:Math.floor(decision.deadline-(range.upper-now))-1};
 }
 if((snapshot.timeframe??'15m')!==tradingTimeframe(mode))throw Error('TIMING_TIMEFRAME_MISMATCH');
 const CANDLE_MS=timeframeSpec(tradingTimeframe(mode)).ms;
 const matches=snapshot.markets?.filter(m=>m.pair===pair)??[];
 const candle=matches.length===1?matches[0].candles?.at(-1):null;
 const boundary=clockBoundary(clock,mode,now);
 if(!candle||candle.openTime!==boundary-CANDLE_MS||candle.closeTime!==boundary-1)throw Error('SIGNAL_CANDLE_SUPERSEDED');
 const originalBoundary=clockBoundary(snapshot.clock,mode,Date.parse(snapshot.createdAt));
 if(originalBoundary!==boundary||snapshot.candleBoundary!==boundary)throw Error('SIGNAL_CANDLE_SUPERSEDED');
 const range=clockRange(clock,mode,now);
 const decision=decisionTiming(snapshot);
 if(decision&&(clockDecisionBoundary(clock,mode,now)!==decision.boundary||
  clockDecisionBoundary(snapshot.clock,mode,Date.parse(snapshot.createdAt))!==decision.boundary))throw Error('SIGNAL_DECISION_SUPERSEDED');
 return {boundary,...(decision?{decisionBoundary:decision.boundary,decisionDeadline:decision.deadline}:{}),
  lastCandleCloseAt:new Date(boundary-1).toISOString(),
  candleDeadline:Math.floor((decision?.deadline??boundary+CANDLE_MS)-(range.upper-now))-1};
}
