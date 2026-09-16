import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStrategyReview,readStrategyReview} from '../src/strategy-review.mjs';
import {entryId} from '../src/entry-identity.mjs';
const observedAt='2026-09-16T01:00:00Z',at=Date.parse(observedAt),mode='demo';
function fixture(id,net,quality='flow-confirmed-exit-v2',open=false){
 const snapshotId=`00000000-0000-0000-0000-${String(id).padStart(12,'0')}`,key=entryId(snapshotId),tag='codex-'+key;
 const pending={id:key,status:'pending',snapshotId,tag,action:'buy',pair:'ETH/USDT',stakeUsdt:'100',
  at:new Date(at-60000).toISOString(),entryPolicyVersion:'order-flow-only-v1',executionQualityVersion:quality};
 const t={trade_id:id,pair:pending.pair,enter_tag:tag,is_short:false,trading_mode:'spot',is_open:open,
  open_timestamp:at-50000,close_timestamp:open?null:at-10000,profit_abs:net,stake_amount:100,leverage:1,
  amount_requested:1,amount_precision:.001,precision_mode:4,
  orders:[{ft_is_entry:true,ft_order_tag:tag,pair:pending.pair,ft_order_side:'buy',order_id:'o'+id,status:'closed',is_open:false,
   filled:1,amount:1,remaining:0,safe_price:100,cost:100}]};
 return {t,j:[pending,{id:key,status:'submitted',tradeId:id,at:new Date(at-40000).toISOString()}]};
}
const review=items=>buildStrategyReview({mode,observedAt,trades:items.map(x=>x.t),journal:items.flatMap(x=>x.j)});
test('new cohort does not absorb older wins or erase losses and reports actual net payoff',()=>{
 const a=fixture(1,'-.6','flow-strength-exit-v1'),b=fixture(2,'.2'),c=fixture(3,'-.4'),d=fixture(4,'.1',undefined,true);
 const r=review([a,b,c,d]),fresh=r.cohorts[0];
 assert.equal(r.complete,true);assert.equal(r.attributionComplete,true);assert.deepEqual(fresh.tradeIds,[2,3,4]);
 assert.equal(fresh.netRealizedUsdt,'-0.2');assert.equal(fresh.floatingUsdt,'0.1');assert.equal(fresh.winRate,.5);
 assert.equal(fresh.averageWinUsdt,'0.20000000');assert.equal(fresh.averageLossUsdt,'0.40000000');assert.equal(fresh.profitFactor,.5);
 assert.equal(r.aggregateNetRealizedUsdt,'-0.8');assert.equal(fresh.closedTradeDrawdownUsdt,'0.4');
});
test('a current cohort with zero closes is not claimed profitable',()=>{
 const r=review([fixture(1,'.7','flow-strength-exit-v1')]);assert.equal(r.cohorts[0].closedCount,0);
 assert.equal(r.cohorts[0].winRate,null);assert.equal(r.cohorts[0].profitFactor,null);assert.equal(r.cohorts[0].evidenceStatus,'no_closed_trades');
});

test('actual serialized fill cost noise and over-budget losses stay in their original cohort',()=>{
 const rounded=fixture(1,'.47902225');Object.assign(rounded.t,{amount_requested:.0445894,amount_precision:.001});
 Object.assign(rounded.t.orders[0],{filled:.044,amount:.044,safe_price:2399.80159,cost:105.59127});
 const r=review([rounded]);assert.equal(r.attributionComplete,true);assert.equal(r.cohorts[0].netRealizedUsdt,'0.47902225');
 const loss=fixture(2,'-1.7');Object.assign(loss.t.orders[0],{safe_price:101,cost:101});
 assert.equal(review([loss]).cohorts[0].netRealizedUsdt,'-1.7');
 const wrong=fixture(3,'-.8');wrong.t.orders[0].cost=101;
 assert.equal(review([wrong]).attributionComplete,false);assert.equal(review([wrong]).cohorts[0].closedCount,0);
 assert.equal(review([wrong]).cohorts.find(c=>c.key==='unattributed').netRealizedUsdt,'-0.8');
});

test('a provided reconciliation proof cannot contradict the actual entry order or quantity',()=>{
 const valid=fixture(1,'-.7');valid.j[1].status='reconciled';
 valid.j[1].proof={orderId:'o1',filled:'1',grossQuoteCost:'100',amountStep:'.001'};
 assert.equal(review([valid]).attributionComplete,true);
 for(const proof of [null,{...valid.j[1].proof,orderId:'WRONG'},{...valid.j[1].proof,filled:2},
  {...valid.j[1].proof,grossQuoteCost:99},{...valid.j[1].proof,amountStep:1}]){
  const x=structuredClone(valid);x.j[1].proof=proof;const r=review([x]);
  assert.equal(r.attributionComplete,false);assert.equal(r.aggregateNetRealizedUsdt,'-0.7');
  assert.equal(r.cohorts.find(c=>c.key==='unattributed').netRealizedUsdt,'-0.7');
 }
});

test('a settled entry missing from full history cannot become zero trades and zero PnL',()=>{
 const x=fixture(1,'-.5');const r=buildStrategyReview({mode,observedAt,trades:[],journal:x.j});
 assert.equal(r.complete,false);assert.equal(r.aggregateNetRealizedUsdt,null);assert.equal(r.cohorts[0].netRealizedUsdt,null);
 assert.ok(r.warnings.some(w=>w.reason==='SETTLED_ENTRY_MISSING_FROM_HISTORY'));
});
test('ambiguous or modified intent cannot assign a loss to the new cohort',()=>{
 for(const mutate of [x=>x.j.push({...x.j[0]}),x=>x.j[1].executionQualityVersion='other',x=>x.t.orders[0].ft_order_tag='wrong',x=>x.j[1].status='unknown',
  x=>x.j[1].tradeId=999,x=>x.j[0].at=observedAt,x=>x.j[1].action='open-short',x=>x.j[1].pair='SOL/USDT',
  x=>x.j[1].at='bad',x=>x.j[1].at=new Date(at+1000).toISOString(),x=>x.j[1].stakeUsdt='999',x=>x.j[1].leverage=3]){
  const x=fixture(1,'-.6');mutate(x);const r=review([x]);assert.equal(r.attributionComplete,false);
  const missing=r.warnings.some(w=>['SETTLED_ENTRY_MISSING_FROM_HISTORY','ENTRY_OUTCOME_UNRESOLVED'].includes(w.reason));
  assert.equal(r.cohorts[0].closedCount,0);assert.equal(r.cohorts.find(c=>c.key==='unattributed').netRealizedUsdt,missing?null:'-0.6');
  assert.equal(r.aggregateNetRealizedUsdt,missing?null:'-0.6');assert.equal(r.knownHistoryNetRealizedUsdt,'-0.6');
 }
});

test('pending, unknown and a settlement followed by unknown cannot become complete empty history',()=>{
 for(const states of [['pending'],['pending','unknown'],['pending','submitted','unknown']]){
  const x=fixture(1,'-.5'),journal=states.map((status,i)=>({...x.j[0],status,tradeId:status==='submitted'?1:undefined,at:new Date(at-60000+i*1000).toISOString()}));
  const r=buildStrategyReview({mode,observedAt,trades:[],journal});
  assert.equal(r.complete,false);assert.equal(r.attributionComplete,false);assert.equal(r.aggregateNetRealizedUsdt,null);
  assert.equal(r.cohorts[0].netRealizedUsdt,null);assert.ok(r.warnings.some(w=>w.reason==='ENTRY_OUTCOME_UNRESOLVED'));
  if(states.includes('submitted'))assert.ok(r.warnings.some(w=>w.reason==='SETTLED_ENTRY_MISSING_FROM_HISTORY'));
 }
});
test('unknown PnL and duplicate trade IDs are incomplete instead of zero profits',()=>{
 assert.equal(review([fixture(1,null)]).complete,false);
 assert.equal(review([fixture(1,null,undefined,true)]).cohorts[0].floatingUsdt,null);
 const x=fixture(1,1);assert.equal(review([x,x]).aggregateNetRealizedUsdt,null);
});
test('one unavailable mode does not hide another mode or expose error details',async()=>{
 const x=fixture(1,'-.2');const r=await readStrategyReview({session:null,now:()=>at,readFor:async m=>{if(m==='demo-futures')throw Error('credential-value');return {trades:[x.t],journal:x.j};}});
 assert.equal(r.complete,false);assert.equal(r.modes[0].aggregateNetRealizedUsdt,'-0.2');assert.equal(r.modes[1].cohorts.length,0);
 assert.ok(!JSON.stringify(r).includes('credential-value'));
});

test('execution diagnostic failure is explicit while verified PnL remains available',async()=>{
 const x=fixture(1,'-.2');const r=await readStrategyReview({session:null,now:()=>at,readFor:async()=>({trades:[x.t],journal:x.j,plansByTag:[]})});
 assert.equal(r.complete,false);assert.equal(r.modes[0].aggregateNetRealizedUsdt,'-0.2');
 assert.equal(r.modes[0].execution.available,false);assert.equal(r.modes[0].execution.diagnostics[0].reason,'EXECUTION_REVIEW_UNAVAILABLE');
});

const session={schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',startedAt:new Date(at-120000).toISOString(),modes:['demo','demo-futures']};
test('new session excludes old histories and late settlements before exact attribution and execution review',async()=>{
 const old=fixture(1,'100'),fresh=fixture(2,'-.4');
 old.t.open_timestamp=at-180000;old.j[0].at=new Date(at-190000).toISOString();
 fresh.t.trade_id=1;fresh.j[1].tradeId=1;
 const r=await readStrategyReview({session,now:()=>at,readFor:async()=>({trades:[old.t,fresh.t],journal:[...old.j,...fresh.j]})});
 assert.deepEqual(r.session,session);assert.equal(r.modes[0].aggregateNetRealizedUsdt,'-0.4');
 assert.equal(r.modes[0].attributionComplete,true);assert.deepEqual(r.modes[0].cohorts[0].tradeIds,[1]);
 assert.equal(r.modes[0].execution.rows.length,1);assert.equal(r.modes[0].execution.rows[0].tradeId,1);
 assert.match(r.modes[0].accounting,/this validation session/);
});
test('old open position remains an explicit incomplete session, not a zero-PnL pass',()=>{
 const old=fixture(1,'-10',undefined,true);old.t.open_timestamp=at-180000;old.j[0].at=new Date(at-190000).toISOString();
 const r=buildStrategyReview({mode,observedAt,session,trades:[old.t],journal:old.j});
 assert.equal(r.complete,false);assert.equal(r.outsideSessionOpenCount,1);assert.equal(r.aggregateNetRealizedUsdt,null);
 assert.ok(r.warnings.some(w=>w.reason==='OUTSIDE_SESSION_OPEN_POSITION'));
 for(const is_open of [undefined,'true',1])assert.throws(()=>buildStrategyReview({mode,observedAt,session,trades:[{...old.t,is_open}],journal:old.j}),/SESSION_TRADE_STATUS_INVALID/);
});
