import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Decimal from 'decimal.js';
import {DEMO_RISK_POLICY_VERSION} from './demo-risk.mjs';
import { ROOT } from './paths.mjs';

export const NATIVE_PROTECTION_VERSION='demo-native-stop-v1';
export const NATIVE_ENTRY_GUARD_VERSION='kronos-native-entry-v12';
export const NATIVE_PROTECTION_ENGINE_VERSION='demo-rule-exits-v12';
export const NATIVE_PROTECTION_MAX_AGE_MS=60_000;
const runFile=promisify(execFile);

function fail(code){throw Object.assign(new Error(code),{code});}
function record(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function finitePositive(value){return typeof value==='number'&&Number.isFinite(value)&&value>0;}
function pidStatus(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return 'unknown';
 try{process.kill(pid,0);return 'alive';}catch(error){return error.code==='ESRCH'?'dead':'unknown';}
}
async function json(path,code){
 try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}catch{fail(code);}
}
async function processAncestry(){
 try{
  const {stdout}=await runFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
   join(ROOT,'scripts/supervisor-inventory.ps1'),'-ExcludePid',String(process.pid)],
   {windowsHide:true,timeout:10_000,maxBuffer:1024*1024});
  const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if(!Array.isArray(rows))fail('NATIVE_PROTECTION_PROCESS_INVENTORY_UNAVAILABLE');
  return rows;
 }catch{fail('NATIVE_PROTECTION_PROCESS_INVENTORY_UNAVAILABLE');}
}
function verifyLineage(rows,owner,nativePid,mode,pidState){
 if(!Array.isArray(rows)||!Number.isSafeInteger(nativePid)||nativePid<1||pidState(nativePid)!=='alive')
  fail('NATIVE_PROTECTION_ENGINE_LINEAGE_REJECTED');
 const index=new Map();
 for(const row of rows){
  if(!record(row)||!Number.isSafeInteger(row.pid)||row.pid<1||index.has(row.pid))fail('NATIVE_PROTECTION_ENGINE_LINEAGE_REJECTED');
  index.set(row.pid,row);
 }
 let pid=nativePid,seenChild=false;const seen=new Set();
 while(seen.size<8&&!seen.has(pid)){
  seen.add(pid);const row=index.get(pid);
  if(!row||row.mode!==mode||row.role!=='engine'||pidState(pid)!=='alive')break;
  if(pid===owner.pid){
   // A relative `src/cli.mjs engine` command has no absolute root in CIM.
   // Its identity is bound by the exact parent chain from root-verified Python
   // processes, including the child PID owned by the durable engine lock.
   if(seenChild)return;
   break;
  }
  if(row.projectVerified!==true||!Number.isSafeInteger(row.parentPid)||row.parentPid<1)break;
  if(pid===owner.childPid)seenChild=true;
  pid=row.parentPid;
 }
 fail('NATIVE_PROTECTION_ENGINE_LINEAGE_REJECTED');
}
function fresh(value,now,maxAgeMs,code){
 const time=typeof value==='string'?Date.parse(value):NaN;
 if(!Number.isFinite(time)||time>now||now-time>maxAgeMs)fail(code);
 return time;
}
function sameNumber(a,b){
 return finitePositive(a)&&finitePositive(b)&&new Decimal(a).minus(b).abs().lte(Decimal.max(new Decimal(b).abs().mul('0.0000000001'),'0.0000000001'));
}
function precisionTolerance(trade,key){
 // Freqtrade exposes CCXT precision_mode: DECIMAL_PLACES=2, TICK_SIZE=4.
 const value=trade[key];
 if(trade.precision_mode===4&&finitePositive(value))return new Decimal(value);
 if(trade.precision_mode===2&&Number.isSafeInteger(value)&&value>=0&&value<=18)return new Decimal(10).pow(-value);
 return null; // Unknown precision must not be guessed.
}
function protectionCovers(trade,stop){
 const quantityStep=precisionTolerance(trade,'amount_precision'),priceStep=precisionTolerance(trade,'price_precision');
 if(!quantityStep||!priceStep||!finitePositive(trade.amount)||!finitePositive(trade.stop_loss_abs))return false;
 const expectedQuantity=new Decimal(trade.amount).div(quantityStep).floor().mul(quantityStep);
 if(!sameNumber(stop.amount,expectedQuantity.toNumber()))return false;
 // Native sell stops round UP, buy stops round DOWN: neither direction may
 // silently loosen a stored protective price by one or more price ticks.
 const expectedStop=new Decimal(trade.stop_loss_abs).div(priceStep)[trade.is_short?'floor':'ceil']().mul(priceStep);
 return sameNumber(stop.stopPrice,expectedStop.toNumber());
}

/** Read-only bridge gate. `account` must be the fresh Freqtrade snapshot already
 * obtained for this execution. This function never queries or mutates a broker.
 * Historical acknowledgements alone are not proof of an active protective order.
 */
export async function assertNativeProtection({mode,local,account,pair,now,entryPolicyVersion,
 maxAgeMs=NATIVE_PROTECTION_MAX_AGE_MS,pidState=pidStatus,getProcessAncestry=processAncestry}={}){
 if(!['demo','demo-futures'].includes(mode))fail('NATIVE_PROTECTION_DEMO_REQUIRED');
 if(typeof local!=='string'||!local||typeof pair!=='string'||!pair||(now!==undefined&&!Number.isFinite(now))
    ||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||maxAgeMs>NATIVE_PROTECTION_MAX_AGE_MS)fail('NATIVE_PROTECTION_ARGUMENTS_INVALID');
 const futures=mode==='demo-futures',engine=account?.engine,orders=engine?.order_types;
 if(!record(engine)||engine.strategy_version!==NATIVE_PROTECTION_ENGINE_VERSION||engine.dry_run!==false
  ||engine.demo_trading!==true||engine.runmode!=='live'||engine.state!=='running'||engine.exchange!=='binance'
  ||engine.trading_mode!==(futures?'futures':'spot')||(futures&&engine.margin_mode!=='isolated')
  ||engine.strategy!==(futures?'CodexDemoFutures':'CodexDemoSpot')
  ||engine.bot_name!==(futures?'binance-trade-demo-futures':'binance-trade-demo')||engine.timeframe!=='5m'
  ||engine.stoploss_on_exchange!==true||!record(orders)||orders.stoploss_on_exchange!==true
  ||orders.stoploss!==(futures?'market':'limit')||orders.exit!=='market'||orders.emergency_exit!=='market'
  ||!Number.isInteger(orders.stoploss_on_exchange_interval)||orders.stoploss_on_exchange_interval<1
  ||orders.stoploss_on_exchange_interval>60||engine.use_custom_stoploss!==true
  ||!record(engine.minimal_roi)||Object.keys(engine.minimal_roi).length||engine.trailing_stop!==false)
  fail('NATIVE_PROTECTION_ENGINE_CONFIG_REJECTED');
 if(!Array.isArray(account.trades))fail('NATIVE_PROTECTION_ACCOUNT_INVALID');
 const [state,owner,lineage]=await Promise.all([
  json(join(local,'protection-readiness.json'),'NATIVE_PROTECTION_READINESS_UNAVAILABLE'),
  json(join(local,'engine.lock'),'NATIVE_PROTECTION_ENGINE_OWNER_UNAVAILABLE'),
  Promise.resolve().then(()=>getProcessAncestry()).catch(()=>fail('NATIVE_PROTECTION_PROCESS_INVENTORY_UNAVAILABLE'))]);
 now??=Date.now(); // Read-time freshness: avoid racing a native heartbeat during file reads.
 if(!record(owner)||owner.mode!==mode||!Number.isSafeInteger(owner.pid)||owner.pid<1
   ||!Number.isSafeInteger(owner.childPid)||owner.childPid<1||owner.pid===owner.childPid
   ||pidState(owner.pid)!=='alive'||pidState(owner.childPid)!=='alive')fail('NATIVE_PROTECTION_ENGINE_OWNER_REJECTED');
 if(!record(state)||state.version!==NATIVE_PROTECTION_VERSION||state.engineVersion!==NATIVE_PROTECTION_ENGINE_VERSION
   ||state.mode!==mode||state.configured!==true
   ||!record(state.capabilities)||!Array.isArray(state.attempts)||!Array.isArray(state.activeStops)
   ||!Number.isSafeInteger(state.unresolvedStops)||state.unresolvedStops<0)
   fail('NATIVE_PROTECTION_READINESS_INVALID');
 verifyLineage(lineage,owner,state.processId,mode,pidState);
 if(state.nativeEntryGuardVersion!==NATIVE_ENTRY_GUARD_VERSION)fail('NATIVE_MODEL_GUARD_RESTART_REQUIRED');
 if(entryPolicyVersion==='kev-order-flow-v1'&&state.kevEntryGuardVersion!=='kev-native-entry-v1')fail('NATIVE_KEV_GUARD_RESTART_REQUIRED');
 if(state.stopPriceVersion!=='stable-unarmed-stop-v1')fail('NATIVE_STOP_PRICE_RESTART_REQUIRED');
 if(state.riskPolicyVersion!==DEMO_RISK_POLICY_VERSION)fail('NATIVE_RISK_POLICY_RESTART_REQUIRED');
 // Freqtrade show_config filters this nested option out of its RPC response.
 // Require it from the fresh, process-bound native config attestation instead.
 if(!futures&&state.stopLimitRatio!==0.995)fail('NATIVE_STOP_LIMIT_RATIO_REJECTED');
 const checkedAt=fresh(state.asOf,now,maxAgeMs,'NATIVE_PROTECTION_READINESS_STALE'),ownerAt=Date.parse(owner.at);
 if(!Number.isFinite(ownerAt)||ownerAt>checkedAt||ownerAt>now)fail('NATIVE_PROTECTION_ENGINE_GENERATION_MISMATCH');
 const unresolved=state.attempts.filter(attempt=>record(attempt)&&['pending','unknown'].includes(attempt.status));
 if(state.unresolvedStops||unresolved.length)fail('NATIVE_PROTECTION_RECONCILIATION_REQUIRED');
 if(state.attempts.some(attempt=>!record(attempt)||!['confirmed','rejected'].includes(attempt.status)))
  fail('NATIVE_PROTECTION_READINESS_INVALID');
 const capability=state.capabilities[pair];
 if(!record(capability)||capability.status!=='capability_validated'
   ||capability.orderType!==(futures?'STOP_MARKET':'STOP_LOSS_LIMIT')||capability.reduceOnly!==futures
   ||capability.destination!==(futures?'demo-fapi.binance.com':'demo-api.binance.com'))
   fail('NATIVE_PROTECTION_PAIR_UNSUPPORTED');
 const active=new Map();
 for(const stop of state.activeStops){
  if(!record(stop)||typeof stop.orderId!=='string'||!stop.orderId||typeof stop.pair!=='string'
     ||!stop.pair||!['buy','sell'].includes(stop.side)||!finitePositive(stop.amount)||!finitePositive(stop.stopPrice))
   fail('NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
  const key=stop.pair+'\0'+stop.orderId;
  if(active.has(key))fail('NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
  const attempts=state.attempts.filter(a=>a.pair===stop.pair&&a.orderId===stop.orderId);
  if(attempts.length!==1)fail('NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
  const attempt=attempts[0];
  if(attempt.status!=='confirmed'||attempt.orderStatus!=='open'||attempt.protectionStatus!=='active'
    ||attempt.side!==stop.side||!sameNumber(attempt.acceptedAmount,stop.amount)||!sameNumber(attempt.stopPrice,stop.stopPrice)
    ||attempt.observedAt!==stop.observedAt)fail('NATIVE_PROTECTION_ACTIVE_PROOF_INVALID');
  const observed=fresh(stop.observedAt,now,maxAgeMs,'NATIVE_PROTECTION_ACTIVE_PROOF_STALE');
  if(observed<ownerAt||observed>checkedAt)fail('NATIVE_PROTECTION_ENGINE_GENERATION_MISMATCH');
  active.set(key,stop);
 }
 const protectedTrades=[],used=new Set(),tradeIds=new Set();
 for(const trade of account.trades){
  if(!record(trade)||!Number.isSafeInteger(trade.trade_id)||trade.trade_id<1||tradeIds.has(trade.trade_id)
    ||trade.is_open!==true||typeof trade.pair!=='string'||typeof trade.is_short!=='boolean'
    ||(!futures&&trade.is_short)||!Array.isArray(trade.orders))fail('NATIVE_PROTECTION_ACCOUNT_INVALID');
  tradeIds.add(trade.trade_id);
  const stops=trade.orders.filter(order=>order?.ft_order_side==='stoploss'&&order.is_open===true&&order.status==='open');
  if(stops.length!==1)fail('NATIVE_PROTECTION_POSITION_UNPROTECTED');
  const order=stops[0],key=trade.pair+'\0'+order.order_id,stop=active.get(key);
  if(!stop||order.pair!==trade.pair||stop.side!==(trade.is_short?'buy':'sell')||used.has(key)
    ||!sameNumber(order.amount,stop.amount)||!protectionCovers(trade,stop)
    ||(!futures&&order.filled!==0)||(order.filled!=null&&order.filled!==0)
    ||(!futures&&!sameNumber(order.remaining,order.amount))
    ||(order.remaining!=null&&!sameNumber(order.remaining,order.amount)))fail('NATIVE_PROTECTION_POSITION_UNPROTECTED');
  used.add(key);
  protectedTrades.push({tradeId:trade.trade_id,pair:trade.pair,side:trade.is_short?'short':'long',
    orderId:stop.orderId,amount:stop.amount,stopPrice:stop.stopPrice,observedAt:stop.observedAt});
 }
 // A fresh active order belonging to no currently-open trade requires explicit
 // reconciliation; do not reuse it to "protect" a different later position.
 if(used.size!==active.size)fail('NATIVE_PROTECTION_ORPHAN_ACTIVE_STOP');
 return {verified:true,mode,pair,engineVersion:NATIVE_PROTECTION_ENGINE_VERSION,
  nativeEntryGuardVersion:NATIVE_ENTRY_GUARD_VERSION,
  protectionVersion:NATIVE_PROTECTION_VERSION,engineProcessId:state.processId,launcherProcessId:owner.pid,
  readinessAt:state.asOf,checkedAt:new Date(now).toISOString(),openTrades:account.trades.length,
  protectedTrades,capability:'validated',newEntryProtection:'native_stop_after_fill'};
}
