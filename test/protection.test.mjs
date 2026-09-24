import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNativeProtection } from '../src/protection.mjs';

async function fixture(t,{futures=false,position=false}={}){
 const local=await mkdtemp(join(tmpdir(),'native-protection-test-'));
 t.after(()=>rm(local,{recursive:true,force:true}));
 const now=Date.now(),iso=new Date(now).toISOString(),mode=futures?'demo-futures':'demo';
 const pair=futures?'ETH/USDT:USDT':'ETH/USDT';
 const owner={mode,pid:101,childPid:102,at:new Date(now-30_000).toISOString()};
 const engine={strategy_version:'demo-rule-exits-v12',dry_run:false,demo_trading:true,runmode:'live',state:'running',exchange:'binance',
  trading_mode:futures?'futures':'spot',margin_mode:futures?'isolated':'',strategy:futures?'CodexDemoFutures':'CodexDemoSpot',
  bot_name:futures?'binance-trade-demo-futures':'binance-trade-demo',timeframe:'5m',stoploss_on_exchange:true,
  order_types:{stoploss_on_exchange:true,stoploss:futures?'market':'limit',exit:'market',emergency_exit:'market',stoploss_on_exchange_interval:15},
  use_custom_stoploss:true,minimal_roi:{},trailing_stop:false};
 const state={version:'demo-native-stop-v1',engineVersion:'demo-rule-exits-v12',nativeEntryGuardVersion:'kronos-native-entry-v12',mode,processId:102,configured:true,asOf:iso,
  capabilities:{[pair]:{status:'capability_validated',orderType:futures?'STOP_MARKET':'STOP_LOSS_LIMIT',reduceOnly:futures,
    destination:futures?'demo-fapi.binance.com':'demo-api.binance.com'}},attempts:[],activeStops:[],unresolvedStops:0};
 const account={engine,trades:[]};
 if(!futures)engine.order_types.stoploss_on_exchange_limit_ratio=.995;
 state.riskPolicyVersion='native-stop-risk-v1';
 state.stopPriceVersion='stable-unarmed-stop-v1';
 state.stopLimitRatio=futures?null:.995;
 if(position){
  const side=futures?'buy':'sell',stopPrice=futures?2424:2376;
  state.attempts.push({status:'confirmed',pair,side,orderId:'9001',orderStatus:'open',protectionStatus:'active',
   acceptedAmount:.01,stopPrice,confirmedAt:iso,observedAt:iso});
  state.activeStops.push({pair,side,orderId:'9001',amount:.01,stopPrice,observedAt:iso});
  account.trades.push({trade_id:16,pair,is_open:true,is_short:futures,amount:.01,stop_loss_abs:stopPrice,
   precision_mode:4,amount_precision:.001,price_precision:.01,
   orders:[{pair,order_id:'9001',status:'open',is_open:true,ft_order_side:'stoploss',amount:.01,filled:0,remaining:.01}]});
 }
 const save=async()=>Promise.all([writeFile(join(local,'engine.lock'),JSON.stringify(owner)),
  writeFile(join(local,'protection-readiness.json'),JSON.stringify(state))]);
 const lineage=[{pid:101,parentPid:100,mode,role:'engine',projectVerified:false},
  {pid:102,parentPid:101,mode,role:'engine',projectVerified:true}];
 const args={mode,local,pair,account,now,pidState:()=> 'alive',getProcessAncestry:async()=>lineage};
 await save();return {args,state,owner,account,save,now,pair,local,lineage};
}
async function rejects(f,code){await f.save();await assert.rejects(assertNativeProtection(f.args),error=>error.code===code&&error.message===code);}

test('Kev entries require the loaded native Kev guard while historical checks remain compatible',async t=>{
 const f=await fixture(t);
 assert.equal((await assertNativeProtection(f.args)).verified,true);
 f.args.entryPolicyVersion='kev-order-flow-v1';
 await rejects(f,'NATIVE_KEV_GUARD_RESTART_REQUIRED');
 f.state.kevEntryGuardVersion='kev-native-entry-v1';await f.save();
 assert.equal((await assertNativeProtection(f.args)).verified,true);
});

test('new host rejects an old loaded risk guard and a wider native limit interval',async t=>{
 const f=await fixture(t);delete f.state.riskPolicyVersion;
 await rejects(f,'NATIVE_RISK_POLICY_RESTART_REQUIRED');
 f.state.riskPolicyVersion='native-stop-risk-v1';f.state.stopLimitRatio=.99;
 await rejects(f,'NATIVE_STOP_LIMIT_RATIO_REJECTED');
});

for(const futures of [false,true]){
 test(`${futures?'futures':'spot'} flat preflight validates engine/capability without claiming an active stop`,async t=>{
  const f=await fixture(t,{futures});const result=await assertNativeProtection(f.args);
  assert.equal(result.verified,true);assert.equal(result.openTrades,0);assert.deepEqual(result.protectedTrades,[]);
  assert.equal(result.newEntryProtection,'native_stop_after_fill');assert.equal(result.engineProcessId,102);
  assert.equal('attempts' in result,false);assert.equal('account' in result,false);
 });
 test(`${futures?'futures':'spot'} current native order must match the current trade and fresh exact protection`,async t=>{
  const f=await fixture(t,{futures,position:true});const result=await assertNativeProtection(f.args);
  assert.equal(result.protectedTrades.length,1);assert.equal(result.protectedTrades[0].tradeId,16);
  assert.equal(result.protectedTrades[0].orderId,'9001');
 });
}

test('legacy global ROI/trailing, disabled protection, wrong mode or old engine rejects before entry',async t=>{
 for(const patch of [{minimal_roi:{0:.03}},{trailing_stop:true},{stoploss_on_exchange:false},{use_custom_stoploss:false},
  {strategy_version:'demo-rule-exits-v5'},{strategy_version:'demo-rule-exits-v11'},{demo_trading:false},{dry_run:true},{trading_mode:'margin'},
  {order_types:{stoploss_on_exchange:true,stoploss:'market'}}]){
  const f=await fixture(t);Object.assign(f.account.engine,patch);await rejects(f,'NATIVE_PROTECTION_ENGINE_CONFIG_REJECTED');
 }
});
test('missing readiness or engine owner never becomes implicit approval',async t=>{
 const f=await fixture(t);await rm(join(f.local,'protection-readiness.json'));
 await assert.rejects(assertNativeProtection(f.args),{code:'NATIVE_PROTECTION_READINESS_UNAVAILABLE'});
 await f.save();await rm(join(f.local,'engine.lock'));
 await assert.rejects(assertNativeProtection(f.args),{code:'NATIVE_PROTECTION_ENGINE_OWNER_UNAVAILABLE'});
});

test('same v12 engine version without loaded native v2 guard cannot accept new entries',async t=>{
 for(const value of [undefined,'old','kronos-native-entry-v1']){
  const f=await fixture(t);f.state.nativeEntryGuardVersion=value;
  await rejects(f,'NATIVE_MODEL_GUARD_RESTART_REQUIRED');
 }
});
test('only the live current engine process may publish readiness',async t=>{
 for(const patch of [{pid:0},{childPid:0},{mode:'demo-futures'},{childPid:101}]){
  const f=await fixture(t);Object.assign(f.owner,patch);await rejects(f,'NATIVE_PROTECTION_ENGINE_OWNER_REJECTED');
 }
 for(const status of ['dead','unknown']){
  const f=await fixture(t);f.args.pidState=()=>status;await rejects(f,'NATIVE_PROTECTION_ENGINE_OWNER_REJECTED');
 }
 const f=await fixture(t);f.state.processId=999;await rejects(f,'NATIVE_PROTECTION_ENGINE_LINEAGE_REJECTED');
});
test('Windows venv native grandchild is verified through the exact engine lock child and launcher',async t=>{
 const f=await fixture(t);f.state.processId=103;
 f.lineage.push({pid:103,parentPid:102,mode:'demo',role:'engine',projectVerified:true});
 await f.save();assert.equal((await assertNativeProtection(f.args)).engineProcessId,103);
 for(const patch of [{parentPid:101},{mode:'demo-futures'},{role:'watch'},{projectVerified:false}]){
  const original={...f.lineage[2]};Object.assign(f.lineage[2],patch);
  await rejects(f,'NATIVE_PROTECTION_ENGINE_LINEAGE_REJECTED');Object.assign(f.lineage[2],original);
 }
});
test('process inventory failure remains a coded preflight rejection',async t=>{
 const f=await fixture(t);f.args.getProcessAncestry=async()=>{throw Error('untrusted process error');};
 await rejects(f,'NATIVE_PROTECTION_PROCESS_INVENTORY_UNAVAILABLE');
});
test('readiness is current and from after this engine launch',async t=>{
 for(const delta of [-60_001,1]){
  const f=await fixture(t);f.state.asOf=new Date(f.now+delta).toISOString();await rejects(f,'NATIVE_PROTECTION_READINESS_STALE');
 }
 const f=await fixture(t);f.owner.at=new Date(f.now+1).toISOString();await rejects(f,'NATIVE_PROTECTION_ENGINE_GENERATION_MISMATCH');
});
test('unresolved count or pending/unknown journal evidence independently blocks all entry',async t=>{
 for(const patch of [{unresolvedStops:1},{attempts:[{status:'pending'}]},{attempts:[{status:'unknown'}]}]){
  const f=await fixture(t);Object.assign(f.state,patch);await rejects(f,'NATIVE_PROTECTION_RECONCILIATION_REQUIRED');
 }
});
test('pair capability must explicitly match the correct Demo wire destination and stop type',async t=>{
 for(const patch of [{status:'unsupported_or_unverified'},{orderType:'STOP_MARKET'},{reduceOnly:true},{destination:'api.binance.com'}]){
  const f=await fixture(t);Object.assign(f.state.capabilities[f.pair],patch);await rejects(f,'NATIVE_PROTECTION_PAIR_UNSUPPORTED');
 }
});
test('historical confirmed or canceled orders cannot protect a new/current trade',async t=>{
 const f=await fixture(t,{position:true});f.state.activeStops=[];
 f.state.attempts[0].orderStatus='canceled';f.state.attempts[0].protectionStatus='resolved';
 await rejects(f,'NATIVE_PROTECTION_POSITION_UNPROTECTED');
 const g=await fixture(t,{position:true});g.account.trades[0].orders[0].order_id='different';
 await rejects(g,'NATIVE_PROTECTION_POSITION_UNPROTECTED');
});
test('a fresh capability heartbeat cannot hide an old actual order observation',async t=>{
 const f=await fixture(t,{position:true});
 f.state.activeStops[0].observedAt=f.state.attempts[0].observedAt=new Date(f.now-60_001).toISOString();
 await rejects(f,'NATIVE_PROTECTION_ACTIVE_PROOF_STALE');
});
test('under-sized, stale-price, partially filled or unknown-precision protection rejects',async t=>{
 for(const mutate of [f=>{f.account.trades[0].amount=.011;}, f=>{f.account.trades[0].stop_loss_abs=2376.02;},
  f=>{f.account.trades[0].orders[0].filled=.001;}, f=>{f.account.trades[0].orders[0].remaining=.009;},
  f=>{f.account.trades[0].precision_mode=null;}, f=>{f.account.trades[0].orders[0].is_open=false;}]){
  const f=await fixture(t,{position:true});mutate(f);await rejects(f,'NATIVE_PROTECTION_POSITION_UNPROTECTED');
 }
});
test('native amount flooring and direction-aware price precision match rather than requiring impossible exact decimals',async t=>{
 for(const futures of [false,true]){
  const f=await fixture(t,{futures,position:true});f.account.trades[0].amount=.0109;
  f.account.trades[0].stop_loss_abs=futures?2424.009:2375.991;
  await f.save();assert.equal((await assertNativeProtection(f.args)).verified,true);
 }
});
test('orphan active order, duplicate proof, or forged active summary requires reconciliation',async t=>{
 const f=await fixture(t,{position:true});f.account.trades=[];await rejects(f,'NATIVE_PROTECTION_ORPHAN_ACTIVE_STOP');
 const g=await fixture(t,{position:true});g.state.activeStops.push({...g.state.activeStops[0]});await rejects(g,'NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
 const h=await fixture(t,{position:true});h.state.attempts[0].acceptedAmount=.005;await rejects(h,'NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
});
test('gate error text never includes untrusted engine/config contents',async t=>{
 const f=await fixture(t);f.account.engine.strategy='sensitive-content';
 await rejects(f,'NATIVE_PROTECTION_ENGINE_CONFIG_REJECTED');
});


test('native process must attest unarmed stop stability before new entry',async t=>{
 const f=await fixture(t);
 delete f.state.stopPriceVersion;
 await writeFile(join(f.local,'protection-readiness.json'),JSON.stringify(f.state));
 await assert.rejects(assertNativeProtection(f.args),/NATIVE_STOP_PRICE_RESTART_REQUIRED/);
});
