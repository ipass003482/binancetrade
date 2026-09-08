import { join } from 'node:path';
import { LOCAL } from './paths.mjs';
export function modeArgs(argv) {
 const args=[...argv],i=args.indexOf('--mode');let mode='dry-run';
 if(i!==-1){mode=args[i+1];args.splice(i,2);}
 if(!['dry-run','demo'].includes(mode)||args.includes('--mode'))throw new Error('MODE_REJECTED: dry-run or demo only');
 return {mode,args};
}
export function modeLocal(mode){if(!['dry-run','demo'].includes(mode))throw new Error('MODE_REJECTED');return mode==='demo'?join(LOCAL,'demo'):LOCAL;}
export function modePolicy(policy,mode){
 if(!['dry-run','demo'].includes(mode))throw new Error('MODE_REJECTED');
 return {...policy,mode,freqtrade:{...policy.freqtrade,...(mode==='demo'?{url:'http://127.0.0.1:18082',botName:'binance-trade-demo',strategy:'CodexDemoSpot'}:{})}};
}
