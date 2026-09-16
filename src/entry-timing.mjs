import { timeframeSpec,tradingTimeframe } from './timeframe.mjs';
import { clockRange } from './exchange-clock.mjs';
export const FLOW_DECISION_CADENCE_VERSION='flow-minute-v1';
export const FLOW_DECISION_INTERVAL_MS=60000;
// Candle identity remains 5m for ATR/model inputs; only flow decisions advance
// each minute. Partial or unrecognised timing contracts must never fall back.
export function decisionTiming(snapshot){
 const keys=['decisionCadenceVersion','decisionIntervalMs','decisionBoundary'];
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
