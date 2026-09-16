import { jsonFetch } from './http.mjs';
export const MAX_CLOCK_OFFSET_MS=2000,MAX_CLOCK_RTT_MS=1500,CLOCK_TTL_MS=60000;
export function clockEndpoint(mode){
 const paths={'dry-run':'https://data-api.binance.vision/api/v3/time',demo:'https://demo-api.binance.com/api/v3/time','demo-futures':'https://demo-fapi.binance.com/fapi/v1/time'};
 if(!Object.hasOwn(paths,mode))throw Error('CLOCK_MODE_REJECTED');return paths[mode];
}
export function clockRange(clock,mode,now=Date.now(),maxAgeMs=CLOCK_TTL_MS){
 if(!clock||clock.mode!==mode||clock.source!==clockEndpoint(mode)||
  ![clock.serverTime,clock.requestStartedAt,clock.receivedAt].every(x=>Number.isSafeInteger(x)&&x>0)||
  !Number.isFinite(now))throw Error('CLOCK_INVALID');
 const rtt=clock.receivedAt-clock.requestStartedAt;
 if(rtt<0||rtt>MAX_CLOCK_RTT_MS)throw Error('CLOCK_RTT_REJECTED');
 const lowerOffset=clock.serverTime-clock.receivedAt,upperOffset=clock.serverTime-clock.requestStartedAt;
 if(Math.max(Math.abs(lowerOffset),Math.abs(upperOffset))>MAX_CLOCK_OFFSET_MS)throw Error('CLOCK_SKEW_REJECTED');
 if(now<clock.receivedAt||now-clock.receivedAt>maxAgeMs)throw Error('CLOCK_STALE');
 return {lower:now+lowerOffset,upper:now+upperOffset,offsetMs:(lowerOffset+upperOffset)/2,uncertaintyMs:rtt/2,rttMs:rtt};
}
export async function readExchangeClock(mode,{fetchImpl=fetch,now=()=>Date.now(),monotonic=()=>performance.now()}={}){
 const source=clockEndpoint(mode),requestStartedAt=now(),start=monotonic();
 const value=await jsonFetch(source,{fetchImpl,timeoutMs:5000});
 const receivedAt=now(),elapsed=monotonic()-start;
 if(Math.abs((receivedAt-requestStartedAt)-elapsed)>250)throw Error('CLOCK_JUMP_DETECTED');
 const clock={mode,source,requestStartedAt,receivedAt,serverTime:value?.serverTime};
 const range=clockRange(clock,mode,receivedAt);
 return {...clock,offsetMs:range.offsetMs,uncertaintyMs:range.uncertaintyMs,rttMs:range.rttMs};
}
