import { join } from 'node:path';
import { LOCAL } from './paths.mjs';
export const MODES=['dry-run','demo','demo-futures'];
export const isDemo=mode=>mode==='demo'||mode==='demo-futures';
export const isFutures=mode=>mode==='demo-futures';
export const isEntry=action=>['buy','open-long','open-short'].includes(action);
export const isExit=action=>['sell','close-long','close-short'].includes(action);
export function modeArgs(argv) {
 const args=[...argv],i=args.indexOf('--mode');let mode='dry-run';
 if(i!==-1){mode=args[i+1];args.splice(i,2);}
 if(!MODES.includes(mode)||args.includes('--mode'))throw new Error('MODE_REJECTED: dry-run, demo or demo-futures only');
 return {mode,args};
}
export function modeLocal(mode){if(!MODES.includes(mode))throw new Error('MODE_REJECTED');return mode==='dry-run'?LOCAL:join(LOCAL,mode);}
export function modePolicy(policy,mode){
 if(!MODES.includes(mode))throw new Error('MODE_REJECTED');
 const futures=isFutures(mode);
 return {...policy,mode,...(futures?{pairs:policy.pairs.map(p=>p+':USDT'),leverage:3,marginMode:'isolated',
  maxNotionalUsdt:'150',maxTotalNotionalUsdt:'150'}:{}),freqtrade:{...policy.freqtrade,
  ...(isDemo(mode)?{url:'http://127.0.0.1:'+(futures?'18084':'18082'),botName:'binance-trade-'+mode,strategy:futures?'CodexDemoFutures':'CodexDemoSpot'}:{})}};
}
