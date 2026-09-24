import { join } from 'node:path';
import { timeframeSpec,tradingTimeframe } from './timeframe.mjs';
import { readExchangeClock,clockRange } from './exchange-clock.mjs';
import { closeBufferMs,nextDecisionBoundary,lastDecisionClaim } from './candle-schedule.mjs';
import { FLOW_DECISION_CADENCE_VERSION,FLOW_DECISION_INTERVAL_MS } from './entry-timing.mjs';
import { exists,readJson } from './io.mjs';
import { safeError,pidState } from './health.mjs';
export async function timeMonitor(local,mode,{getClock=readExchangeClock,now=()=>Date.now(),state=pidState,entryPolicyVersion}={}){
 const timeframe=tradingTimeframe(mode),CANDLE_MS=timeframeSpec(timeframe).ms;
 let clock=null,clockError=null,range=null;
 try{clock=await getClock(mode);range=clockRange(clock,mode,now());}catch(e){clockError=safeError(e);}
 const stopped=await exists(join(local,'STOP'));
 const health=await exists(join(local,'health.json'))?await readJson(join(local,'health.json')):{};
 const continuous=await exists(join(local,'continuous.json'))?await readJson(join(local,'continuous.json')):{};
 const kevFlow=mode!=='dry-run'&&(entryPolicyVersion??continuous.entryPolicyVersion)==='kev-order-flow-v1';
 const timingOptions=kevFlow?{entryPolicyVersion:'kev-order-flow-v1'}:{};
 const watch=await exists(join(local,'watch.lock'))?await readJson(join(local,'watch.lock')):null;
 const beat=await exists(join(local,'watch-heartbeat.json'))?await readJson(join(local,'watch-heartbeat.json')):null;
 const beatAge=now()-Date.parse(beat?.at);
 const running=!!watch&&state(watch.pid)==='alive'&&beat?.pid===watch.pid&&Number.isFinite(beatAge)&&beatAge>=0&&beatAge<=45000;
 const reference=range?(range.lower+range.upper)/2:null;
 const result={mode,timeframe:kevFlow?'order-flow':timeframe,candleMs:kevFlow?null:CANDLE_MS,...timingOptions,observedAt:new Date(now()).toISOString(),clock,clockError,serverNow:reference,
  ...(mode==='dry-run'?{}:{decisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,decisionIntervalMs:FLOW_DECISION_INTERVAL_MS}),
  stopped,watchRunning:running,scheduleStatus:stopped?'paused':running?'running':'not_running',
  nextCandleCloseAt:kevFlow||reference===null?null:new Date((Math.floor(reference/CANDLE_MS)+1)*CANDLE_MS).toISOString(),
  nextResearchAt:null,latestResearch:health.timing??null,stage:health.stage??'idle'};
 if(!stopped&&running&&reference!==null&&mode!=='dry-run'){
  const scheduled=Date.parse(health.nextResearchAt);
  const localDeadline=['waiting_candle','waiting_decision'].includes(health.stage)&&scheduled>now()?scheduled:
   nextDecisionBoundary(now(),await lastDecisionClaim(local),mode,timingOptions)+closeBufferMs(mode,timingOptions);
  result.nextResearchAt=new Date(localDeadline+range.offsetMs).toISOString();
 }
 return result;
}
