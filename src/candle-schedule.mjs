import { join } from 'node:path';
import { exists,readJson,writeJson } from './io.mjs';
import { timeframeSpec } from './timeframe.mjs';
import {FLOW_DECISION_CADENCE_VERSION,FLOW_DECISION_INTERVAL_MS,clockDecisionBoundary,decisionTiming} from './entry-timing.mjs';
export const CANDLE_MS=900000;
export const CLOSE_BUFFER_MS=5000;
// Demo futures may revise the just-closed volume/close for several seconds.
// The measured 5s->10s revisions motivate a 15s collection start, while all
// model/native first-minute expiry checks remain unchanged.
export function closeBufferMs(mode){return mode==='demo-futures'?15000:CLOSE_BUFFER_MS;}
export const START_GRACE_MS=60000;
export function cycleTimingLimits(mode,{health={},continuous={},timeframe}={}){
 const minute=['demo','demo-futures'].includes(mode)&&(continuous.decisionCadenceVersion===FLOW_DECISION_CADENCE_VERSION||
  health.timing?.decisionCadenceVersion===FLOW_DECISION_CADENCE_VERSION||health.stage==='waiting_decision');
 const intervalMs=minute?FLOW_DECISION_INTERVAL_MS:timeframeSpec(timeframe??(mode==='dry-run'?'15m':'5m')).ms;
 return {intervalMs,cycleMaxAgeMs:intervalMs*2+closeBufferMs(mode),startupGraceMs:intervalMs+closeBufferMs(mode)+60000};
}
// Called under the per-mode watch lock. Persist the claim BEFORE research:
// a failed/crashed cycle must not be retried for the same scheduled candle.
export async function lastClaim(local){
 const file=join(local,'candle-schedule.json');
 if(!await exists(file))return 0;
 const s=await readJson(file);
 if(s.version!==1||!Number.isSafeInteger(s.boundary)||s.boundary<0||s.boundary%timeframeSpec(s.timeframe).ms!==0)throw Error('INVALID_CANDLE_SCHEDULE');
 return s.boundary;
}
export function nextBoundary(now,last=0,timeframe='15m',mode){
 const CANDLE_MS=timeframeSpec(timeframe).ms;
 if(!Number.isFinite(now)||!Number.isSafeInteger(last)||last<0||last%CANDLE_MS!==0)throw Error('INVALID_SCHEDULE_TIME');
 return Math.max((Math.floor((now-closeBufferMs(mode))/CANDLE_MS)+1)*CANDLE_MS,last+CANDLE_MS);
}
export function slotReady(now,boundary,mode){return now>=boundary+closeBufferMs(mode)&&now<=boundary+CLOSE_BUFFER_MS+START_GRACE_MS;}
export async function claimBoundary(local,boundary,now=Date.now(),timeframe='15m',mode){
 const CANDLE_MS=timeframeSpec(timeframe).ms;
 if(!Number.isSafeInteger(boundary)||boundary%CANDLE_MS!==0||!slotReady(now,boundary,mode)||boundary<=await lastClaim(local))return false;
 await writeJson(join(local,'candle-schedule.json'),{version:1,timeframe,boundary,claimedAt:new Date(now).toISOString()});return true;
}
export function verifyScheduledCandles(snapshot,boundary,now=Date.now()){
 const CANDLE_MS=timeframeSpec(snapshot.timeframe).ms;
 if(!Number.isSafeInteger(boundary)||boundary%CANDLE_MS!==0||now<boundary||now>=boundary+CANDLE_MS||
  !Array.isArray(snapshot.markets)||!snapshot.markets.length||snapshot.markets.some(m=>{
   const c=m.candles?.at(-1);return c?.openTime!==boundary-CANDLE_MS||c?.closeTime!==boundary-1;
  }))throw Error('SCHEDULED_CANDLE_NOT_READY');
}
// The minute scheduler has its own durable claim; historical candle claims are
// retained. Serial watch/cycle locks plus claim-before-collect prevent retries
// after failure or restart and skip elapsed slots instead of catching up.
export async function lastDecisionClaim(local){
 const file=join(local,'decision-schedule.json');
 if(!await exists(file))return 0;
 const s=await readJson(file);
 if(s.version!==1||s.decisionCadenceVersion!==FLOW_DECISION_CADENCE_VERSION||
  s.decisionIntervalMs!==FLOW_DECISION_INTERVAL_MS||!Number.isSafeInteger(s.boundary)||s.boundary<0||
  s.boundary%FLOW_DECISION_INTERVAL_MS!==0)throw Error('INVALID_DECISION_SCHEDULE');
 return s.boundary;
}
export function nextDecisionBoundary(now,last=0,mode){
 if(!['demo','demo-futures'].includes(mode)||!Number.isFinite(now)||!Number.isSafeInteger(last)||last<0||last%FLOW_DECISION_INTERVAL_MS!==0)
  throw Error('INVALID_DECISION_SCHEDULE_TIME');
 return Math.max((Math.floor((now-closeBufferMs(mode))/FLOW_DECISION_INTERVAL_MS)+1)*FLOW_DECISION_INTERVAL_MS,last+FLOW_DECISION_INTERVAL_MS);
}
export async function claimDecisionBoundary(local,boundary,now=Date.now(),mode){
 if(!['demo','demo-futures'].includes(mode)||!Number.isSafeInteger(boundary)||boundary<=0||boundary%FLOW_DECISION_INTERVAL_MS!==0||
  !Number.isFinite(now)||now<boundary+closeBufferMs(mode)||now>=boundary+FLOW_DECISION_INTERVAL_MS||boundary<=await lastDecisionClaim(local))return false;
 await writeJson(join(local,'decision-schedule.json'),{version:1,decisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,
  decisionIntervalMs:FLOW_DECISION_INTERVAL_MS,boundary,claimedAt:new Date(now).toISOString()});return true;
}
export function verifyScheduledDecision(snapshot,boundary,now=Date.now()){
 const decision=decisionTiming(snapshot);
 if(!decision||decision.boundary!==boundary||clockDecisionBoundary(snapshot.clock,snapshot.mode,now)!==boundary)
  throw Error('SCHEDULED_DECISION_NOT_READY');
 // The most recent complete 5m candle may legitimately serve five separate
 // minute decisions; the live flow/quote and decision identities may not.
 verifyScheduledCandles(snapshot,snapshot.candleBoundary,now);
}
