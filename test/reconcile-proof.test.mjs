import test from 'node:test';
import assert from 'node:assert/strict';
import { entryProof,reconcile } from '../src/reconcile.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journalAppend,journalRead } from '../src/io.mjs';
const intent={id:'a'.repeat(32),status:'pending',at:new Date().toISOString(),action:'buy',pair:'BTC/USDT',tag:'codex-test',stakeUsdt:'300'};
function trade(){return {trade_id:8,pair:intent.pair,enter_tag:intent.tag,is_short:false,trading_mode:'spot',
 stake_amount:299.5,amount_requested:.0038008,amount_precision:.00001,precision_mode:4,
 orders:[{ft_is_entry:true,ft_order_tag:intent.tag,pair:intent.pair,ft_order_side:'buy',order_id:'123',
 status:'closed',is_open:false,filled:.0038,amount:.0038,remaining:0,average:78924.93,cost:299.914734}]};}
test('entry proof tolerates quantity rounding and base-fee stake change, not arbitrary mismatches',()=>{
 assert.equal(entryProof(intent,trade()).orderId,'123');
 for(const mutate of [t=>t.is_short=true,t=>t.trading_mode='futures',t=>t.enter_tag='other',t=>t.amount_precision=null,
  t=>t.orders.push({...t.orders[0]}),t=>t.orders[0].order_id='',t=>t.orders[0].ft_order_tag='other',
  t=>t.orders[0].status='canceled',t=>t.orders[0].is_open=true,t=>t.orders[0].remaining=.00001,
  t=>t.orders[0].cost=300.1,t=>t.orders[0].filled=.0001,t=>t.amount_requested=.004,
  t=>t.orders[0].average=78000,t=>t.orders[0].ft_order_side='sell']){
  const t=trade();mutate(t);assert.equal(entryProof(intent,t),null);
 }
 assert.equal(entryProof({...intent,stakeUsdt:3000},trade()),null);
});
test('native unrounded safe_price proves rounded-average fills without loosening cost checks',()=>{
 const base={...intent,pair:'DOGE/USDT'};
 const t={...trade(),pair:base.pair,amount_requested:2000,amount_precision:1,
  orders:[{...trade().orders[0],pair:base.pair,amount:2000,filled:2000,
   average:0.14999999,safe_price:0.149999994,cost:299.999988}]};
 assert.equal(entryProof(base,t).grossQuoteCost,'299.999988');
 const roundedOnly=structuredClone(t);delete roundedOnly.orders[0].safe_price;
 assert.equal(entryProof(base,roundedOnly),null);
 // The rounded value would verify this incorrect cost; the precise one must win.
 const wrongCost=structuredClone(t);wrongCost.orders[0].cost=299.99998;
 assert.equal(entryProof(base,wrongCost),null);
 assert.equal(entryProof({...base,stakeUsdt:'299.99998'},t),null);
});

test('malformed provided safe_price cannot fall back to an otherwise valid average',()=>{
 for(const value of [undefined,null,'',NaN,Infinity,'invalid',true,0,-1]) {
  const t=trade();t.orders[0].safe_price=value;
  assert.equal(entryProof(intent,t),null,String(value));
 }
 const t=trade();t.orders[0].safe_price='78924.93';
 assert.equal(entryProof(intent,t).orderId,'123');
});

test('reconciliation requires unique order proof and never resubmits',async()=>{
 const local=await mkdtemp(join(tmpdir(),'entry-proof-'));await journalAppend(join(local,'orders.jsonl'),intent);
 const t=trade();let history=[t,{...t,trade_id:9,enter_tag:'other'}];
 const client={assertMode:async()=>{},history:async()=>history,submit:()=>assert.fail('must not resend')};
 assert.equal((await reconcile(local,client))[0].status,'unresolved');
 history=[t];assert.equal((await reconcile(local,client))[0].status,'reconciled');
 assert.equal((await journalRead(join(local,'orders.jsonl'))).at(-1).proof.orderId,'123');
 assert.equal((await reconcile(local,client)).status,'clear');
});

test('native response without entry flag uses side and retains all identity/fill checks',()=>{
 const t=trade();delete t.orders[0].ft_is_entry;
 t.orders.push({ft_order_side:'stoploss',status:'open',is_open:true});
 assert.equal(entryProof(intent,t).orderId,'123');
 for(const mutate of [x=>x.orders[0].ft_is_entry=false,x=>x.orders[0].ft_is_entry=null,
  x=>x.orders[0].ft_is_entry='true',x=>x.orders[0].ft_is_entry=undefined,
  x=>x.orders[0].ft_order_tag='other',x=>x.orders[0].ft_order_side='sell',
  x=>x.orders[0].filled=.001,x=>x.orders[0].status='open',
  x=>x.orders[0].cost=300.1,x=>x.orders.push({...x.orders[0]})]){
  const changed=structuredClone(t);mutate(changed);assert.equal(entryProof(intent,changed),null);
 }
 const short={...intent,action:'open-short',leverage:1};
 const st=structuredClone(t);st.is_short=true;st.trading_mode='futures';st.leverage=1;st.orders[0].ft_order_side='sell';
 assert.equal(entryProof(short,st).orderId,'123');
 st.orders[0].ft_order_side='buy';assert.equal(entryProof(short,st),null);
});

test('missing-entry-flag reconciliation appends one proof and never resubmits',async()=>{
 const local=await mkdtemp(join(tmpdir(),'native-entry-proof-'));
 await journalAppend(join(local,'orders.jsonl'),intent);
 await journalAppend(join(local,'orders.jsonl'),{id:intent.id,status:'unknown',at:new Date().toISOString()});
 const t=trade();delete t.orders[0].ft_is_entry;
 const client={assertMode:async()=>{},history:async()=>[t],submit:()=>assert.fail('must not resend')};
 assert.equal((await reconcile(local,client))[0].status,'reconciled');
 assert.equal((await reconcile(local,client)).status,'clear');
 const rows=await journalRead(join(local,'orders.jsonl'));
 assert.equal(rows.length,3);assert.equal(rows[1].status,'unknown');assert.equal(rows[2].proof.orderId,'123');
});
