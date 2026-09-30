import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {loadPolicy} from './config.mjs';
import {FreqtradeClient} from './freqtrade.mjs';
import {modeLocal} from './mode.mjs';
import {readJson} from './io.mjs';
import {loadPortfolioConfig} from './portfolio.mjs';

export const KEV_PORTFOLIO_ELIGIBILITY_VERSION='kev-portfolio-positions-v1';
const MODES=['demo','demo-futures'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value;
};
const seal=body=>freeze({...body,proofSha256:digest(body)});
const identity=(snapshot,now)=>MODES.includes(snapshot?.mode)&&typeof snapshot.id==='string'&&snapshot.id.length>0&&
 Number.isSafeInteger(snapshot.decisionBoundary)&&snapshot.decisionBoundary>0&&snapshot.decisionBoundary%60000===0&&
 Number.isSafeInteger(now)&&now>=snapshot.decisionBoundary&&now<snapshot.decisionBoundary+60000;

// This is an exclusion-only advisory read. It does not reserve shared capital
// or authorize an entry; the bridge still reads and validates the complete
// portfolio under its cross-mode lock immediately before submitting.
export function buildKevPortfolioEligibility({snapshot,accounts,maxSnapshotAgeSeconds=15,now=Date.now()}={}){
 const base={version:KEV_PORTFOLIO_ELIGIBILITY_VERSION,snapshotId:snapshot?.id??null,mode:snapshot?.mode??null,
  decisionBoundary:snapshot?.decisionBoundary??null,assessedAt:Number.isSafeInteger(now)?new Date(now).toISOString():null,
  maxSnapshotAgeSeconds,finalPortfolioCheckRequired:true};
 const unavailable=reason=>seal({...base,status:'unavailable',reason,positions:[],accountObservedAt:{}});
 if(!identity(snapshot,now)||!Number.isInteger(maxSnapshotAgeSeconds)||maxSnapshotAgeSeconds<1||maxSnapshotAgeSeconds>15)
  return unavailable('KEV_PORTFOLIO_CONTEXT_INVALID');
 const positions=[],accountObservedAt={};
 for(const mode of MODES){
  const account=accounts?.[mode],engine=account?.engine,observed=Date.parse(account?.observedAt);
  if(!account||!Array.isArray(account.trades))return unavailable('KEV_PORTFOLIO_ACCOUNT_UNAVAILABLE');
  if(typeof account.observedAt!=='string'||!Number.isFinite(observed)||observed>now||now-observed>maxSnapshotAgeSeconds*1000)
   return unavailable('KEV_PORTFOLIO_ACCOUNT_STALE');
  if(engine?.demo_trading!==true||engine.dry_run!==false||engine.exchange!=='binance'||
   engine.trading_mode!==(mode==='demo'?'spot':'futures')||engine.state!=='running'||
   (mode==='demo-futures'&&engine.margin_mode!=='isolated'))return unavailable('KEV_PORTFOLIO_ACCOUNT_IDENTITY');
  accountObservedAt[mode]=account.observedAt;const seen=new Set();
  for(const trade of account.trades){
   if(!Number.isSafeInteger(trade?.trade_id)||trade.trade_id<=0||seen.has(trade.trade_id)||trade.is_open!==true||
    typeof trade.has_open_orders!=='boolean'||typeof trade.is_short!=='boolean'||(mode==='demo'&&trade.is_short)||
    typeof trade.pair!=='string'||!(mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/).test(trade.pair)||
    (trade.trading_mode!==undefined&&trade.trading_mode!==(mode==='demo'?'spot':'futures')))
    return unavailable('KEV_PORTFOLIO_POSITION_INVALID');
   if(trade.has_open_orders)return unavailable('KEV_PORTFOLIO_PENDING_ORDER');
   seen.add(trade.trade_id);positions.push({mode,tradeId:trade.trade_id,pair:trade.pair,base:trade.pair.split('/')[0],isShort:trade.is_short});
  }
 }
 return seal({...base,status:'ok',reason:null,positions,accountObservedAt});
}

export function kevPortfolioCandidateRejection({receipt,snapshot,pair,action,now=Date.now()}={}){
 if(!receipt||typeof receipt!=='object')return 'KEV_PORTFOLIO_CONTEXT_MISSING';
 const {proofSha256,...body}=receipt;
 if(proofSha256!==digest(body)||receipt.version!==KEV_PORTFOLIO_ELIGIBILITY_VERSION||
  receipt.snapshotId!==snapshot?.id||receipt.mode!==snapshot?.mode||receipt.decisionBoundary!==snapshot?.decisionBoundary||
  receipt.finalPortfolioCheckRequired!==true||!identity(snapshot,Date.parse(receipt.assessedAt))||
  !Number.isSafeInteger(now)||now<Date.parse(receipt.assessedAt)||!Array.isArray(receipt.positions))return 'KEV_PORTFOLIO_CONTEXT_INVALID';
 if(receipt.status!=='ok')return receipt.status==='unavailable'&&/^KEV_PORTFOLIO_[A-Z_]+$/.test(receipt.reason??'')
  ?receipt.reason:'KEV_PORTFOLIO_CONTEXT_INVALID';
 const mode=snapshot.mode,isShort=action==='open-short';
 if(typeof pair!=='string'||!(mode==='demo'?action==='buy'&&/^[A-Z0-9]+\/USDT$/.test(pair):
  ['open-long','open-short'].includes(action)&&/^[A-Z0-9]+\/USDT:USDT$/.test(pair)))return 'KEV_PORTFOLIO_CONTEXT_INVALID';
 const base=pair.split('/')[0];
 if(receipt.positions.some(position=>position.mode===mode&&position.base===base))return 'PORTFOLIO_DUPLICATE_POSITION';
 if(receipt.positions.some(position=>position.base===base&&position.isShort!==isShort))return 'PORTFOLIO_OPPOSITE_POSITION';
 return null;
}

async function clients(){
 return Object.fromEntries(await Promise.all(MODES.map(async mode=>[mode,
  new FreqtradeClient(await loadPolicy(mode),await readJson(join(modeLocal(mode),'api-auth.json')))])));
}

// Read both dedicated identities once, with no history/report writes. Timestamp
// each completed read independently; one slow mode must not freshen the other.
export async function readKevPortfolioEligibility({snapshot,getClients=clients,getConfig=loadPortfolioConfig,now=()=>Date.now()}={}){
 // Preserve transport/configuration failures for the workflow's observation
 // handling. A failed read must not be recorded as a successful HOLD cycle.
 const [broker,config]=await Promise.all([getClients(),getConfig()]);
 const accounts=Object.fromEntries(await Promise.all(MODES.map(async mode=>[mode,
  {...await broker[mode].snapshot(),observedAt:new Date(now()).toISOString()}])));
 return buildKevPortfolioEligibility({snapshot,accounts,maxSnapshotAgeSeconds:config.maxSnapshotAgeSeconds,now:now()});
}
