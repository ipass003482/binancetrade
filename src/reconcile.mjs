import { join } from 'node:path';
import { lock,journalRead,journalAppend } from './io.mjs';
export async function reconcile(local,client){
 return lock(join(local,'execution.lock'),async()=>{
  await client.assertMode();
  const file=join(local,'orders.jsonl'),records=await journalRead(file),latest=new Map(records.map(r=>[r.id,r]));
  const pending=[...latest.values()].filter(r=>['pending','unknown'].includes(r.status));
  if(!pending.length)return {status:'clear'};
  const all=await client.history(),result=[];
  for(const item of pending){
   const base=records.find(r=>r.id===item.id&&r.status==='pending');
   if(!base||!['buy','sell'].includes(base.action))throw new Error('JOURNAL_MISSING_INTENT');
   const matches=all.filter(t=>base.action==='buy'?t.enter_tag===base.tag:t.trade_id===base.tradeId);
   const t=matches.length===1?matches[0]:null;
   const proven=t&&t.pair===base.pair&&(base.action==='buy'
    ?Number(t.stake_amount)===Number(base.stakeUsdt)
    :t.is_open===false||t.orders?.some(o=>o.ft_order_side==='sell'&&o.is_open===true));
   if(proven){
    const record={id:base.id,status:'reconciled',action:base.action,tradeId:t.trade_id,at:new Date().toISOString()};
    await journalAppend(file,record);result.push(record);
   }else result.push({id:base.id,status:'unresolved',message:'No unique proof; no resend or reset.'});
  }
  return result;
 });
}
