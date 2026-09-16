// Explicit operator-authorized Demo connectivity test, never a strategy signal.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exists,readJson,writeJson } from './io.mjs';
export const PROBE_VERSION='demo-execution-probe-v1';
export function probeFillEvidence(trade){
 const side=trade?.is_short?'sell':'buy',opposite=side==='buy'?'sell':'buy';
 // /status has compact orders without ft_is_entry/average; side plus exact
 // entry tag and exchange fill fields still prove a completed entry order.
 const filled=(o,entry)=>o&&(o.ft_is_entry===entry||o.ft_is_entry===undefined)&&o.pair===trade.pair&&o.ft_order_side===(entry?side:opposite)
  &&typeof o.order_id==='string'&&o.order_id.length>0&&o.status==='closed'&&o.is_open===false
  &&Number.isFinite(o.filled)&&o.filled>0&&Number.isFinite(o.cost)&&o.cost>0&&o.remaining===0
  &&Number.isSafeInteger(o.order_filled_timestamp)&&o.order_filled_timestamp>0
  &&(!entry||o.ft_order_tag===trade.enter_tag);
 const orders=Array.isArray(trade?.orders)?trade.orders:[],entry=orders.filter(o=>filled(o,true)),exit=orders.filter(o=>filled(o,false));
 return {entryVerified:entry.length===1,roundTripVerified:trade?.is_open===false&&entry.length===1&&exit.length===1&&entry[0].order_id!==exit[0].order_id,
  entryOrderIds:entry.map(o=>o.order_id),exitOrderIds:exit.map(o=>o.order_id)};
}
export function probeSpec(mode){
 if(!['demo','demo-futures'].includes(mode))throw Error('PROBE_DEMO_ONLY');
 return {pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',action:mode==='demo'?'buy':'open-short',stakeUsdt:'25',
  purpose:'execution_probe',ruleVersion:PROBE_VERSION,timeframe:'5m',stopFraction:.005,targetFraction:.005,maxHoldingSeconds:90,maxHoldingBars:1};
}
export async function createProbePermit(local,mode,snapshot,{allowDemoOrders=false,now=Date.now()}={}){
 if(allowDemoOrders!==true)throw Error('PROBE_EXPLICIT_AUTHORIZATION_REQUIRED');
 const spec=probeSpec(mode),owner=await readJson(join(local,'cycle.lock'));
 if(owner.pid!==process.pid||await exists(join(local,'watch.lock')))throw Error('PROBE_EXCLUSIVE_CYCLE_REQUIRED');
 const permit={id:randomUUID(),mode,snapshotId:snapshot.id,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+120000).toISOString(),ownerPid:process.pid,...spec};
 await writeJson(join(local,'probe-permits',permit.id+'.json'),permit);return permit;
}
export async function validateProbePermit({local,id,proposal,snapshot,mode,now=Date.now()}){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id??''))throw Error('PROBE_PERMIT_INVALID');
 const spec=probeSpec(mode),permit=await readJson(join(local,'probe-permits',id+'.json'));
 const owner=await readJson(join(local,'cycle.lock'));
 if(owner.pid!==process.pid||permit.ownerPid!==process.pid||await exists(join(local,'watch.lock')))throw Error('PROBE_EXCLUSIVE_CYCLE_REQUIRED');
 if(permit.id!==id||permit.mode!==mode||snapshot.mode!==mode||permit.snapshotId!==snapshot.id||proposal.snapshotId!==snapshot.id||permit.consumedAt
  ||!Number.isFinite(Date.parse(permit.createdAt))||!Number.isFinite(Date.parse(permit.expiresAt))
  ||now<Date.parse(permit.createdAt)||now>=Date.parse(permit.expiresAt)||Date.parse(permit.expiresAt)-Date.parse(permit.createdAt)!==120000
  ||Object.entries(spec).some(([k,v])=>permit[k]!==v)||proposal.pair!==spec.pair||proposal.action!==spec.action||proposal.stakeUsdt!==spec.stakeUsdt
  ||(mode==='demo-futures'&&proposal.leverage!==1))throw Error('PROBE_PERMIT_REJECTED');
 return permit;
}
