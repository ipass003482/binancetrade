import { isEntry,isExit } from './mode.mjs';
import { join } from 'node:path';
import { lock,journalRead,journalAppend } from './io.mjs';
import Decimal from 'decimal.js';
// Fail closed on partial/open orders or missing precision. Attribution is not
// merely a near-equal stake: base-asset fees change the engine's stake value.
export function entryProof(base,t){
 try{
  const short=base.action==='open-short';
  if(!Number.isInteger(t.trade_id)||t.pair!==base.pair||t.enter_tag!==base.tag||t.is_short!==short)return null;
  if(base.action==='buy'&&t.trading_mode!=='spot')return null;
  if(base.action!=='buy'&&(t.trading_mode!=='futures'||t.leverage!==base.leverage))return null;
  // Native status/trades responses can omit ft_is_entry. In that schema the
  // entry side identifies candidates; exact tag, pair, settled fill, quantity,
  // cost and unique order checks below still establish the actual proof.
  // Never reinterpret an explicitly false or malformed entry flag.
  const entries=(t.orders??[]).filter(o=>o?.ft_is_entry===true||
   (o&&!Object.hasOwn(o,'ft_is_entry')&&o.ft_order_side===(short?'sell':'buy')));
  if(entries.length!==1)return null;
  const o=entries[0];
  if(o.pair!==base.pair||o.ft_order_tag!==base.tag||o.ft_order_side!==(short?'sell':'buy')||
   !String(o.order_id??'').trim()||o.is_open!==false||o.status!=='closed')return null;
  const d=v=>{if(v===null||v===undefined||v==='')throw Error();const n=new Decimal(v);if(!n.isFinite())throw Error();return n;};
  // Native Freqtrade rounds average to 8 decimals in JSON, but safe_price
  // retains the fill precision needed to verify cost. An invalid provided
  // safe_price must fail proof rather than fall back to a convenient average.
  const filled=d(o.filled),amount=d(o.amount),requested=d(t.amount_requested),price=d(Object.hasOwn(o,'safe_price')?o.safe_price:o.average),cost=d(o.cost);
  const precision=d(t.amount_precision);
  const step=t.precision_mode===4?precision:t.precision_mode===2&&precision.isInteger()&&precision.gte(0)&&precision.lte(18)?new Decimal(10).pow(precision.neg()):null;
  const budget=d(base.stakeUsdt).mul(base.leverage??1);
  if(!step||!step.gt(0)||!filled.gt(0)||!price.gt(0)||!cost.gt(0)||!budget.gt(0)||
   !d(o.remaining).isZero()||!filled.eq(amount)||!filled.mod(step).isZero()||
   requested.lt(filled)||requested.minus(filled).gte(step))return null;
  // Only numerical serialization noise, NOT an arbitrary sizing tolerance.
  const epsilon=new Decimal('0.00000001');
  if(cost.minus(filled.mul(price)).abs().gt(epsilon)||cost.gt(budget.plus(epsilon)))return null;
  // A tiny unrelated fill must not clear a large pending intent.
  if(budget.minus(cost).gt(step.mul(price).plus(epsilon)))return null;
  return {orderId:String(o.order_id),filled:filled.toFixed(),grossQuoteCost:cost.toFixed(),amountStep:step.toFixed()};
 }catch{return null;}
}
export async function reconcile(local,client){
 return lock(join(local,'execution.lock'),async()=>{
  await client.assertMode();
  const file=join(local,'orders.jsonl'),records=await journalRead(file),latest=new Map(records.map(r=>[r.id,r]));
  const pending=[...latest.values()].filter(r=>['pending','unknown'].includes(r.status));
  if(!pending.length)return {status:'clear'};
  const all=await client.history(),result=[];
  for(const item of pending){
   const base=records.find(r=>r.id===item.id&&r.status==='pending');
   if(!base||!isEntry(base.action)&&!isExit(base.action))throw new Error('JOURNAL_MISSING_INTENT');
   const matches=all.filter(t=>isEntry(base.action)?t.enter_tag===base.tag:t.trade_id===base.tradeId);
   const t=matches.length===1?matches[0]:null;
   const directionOk=base.action==='buy'||base.action==='sell'||(t&&t.is_short===base.action.endsWith('short'));
   const proof=t&&isEntry(base.action)?entryProof(base,t):null;
   const uniqueOrder=proof&&all.flatMap(x=>x.orders??[]).filter(o=>String(o.order_id)===proof.orderId&&o.pair===base.pair).length===1;
   const proven=t&&directionOk&&t.pair===base.pair&&(isEntry(base.action)
    ?proof&&uniqueOrder
    :t.is_open===false||t.orders?.some(o=>o.ft_order_side===(t.is_short?'buy':'sell')&&o.is_open===true));
   if(proven){
    const record={id:base.id,status:'reconciled',action:base.action,tradeId:t.trade_id,at:new Date().toISOString(),...(proof?{proof}:{})};
    await journalAppend(file,record);result.push(record);
   }else result.push({id:base.id,status:'unresolved',message:'No unique proof; no resend or reset.'});
  }
  return result;
 });
}
