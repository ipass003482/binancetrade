// Public chain context is a prospective research feature, never an entry gate.
import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import {assessOrderFlow} from './order-flow.mjs';

export const CAPITAL_VERSION='capital-flow-observer-v1';
export const CHAIN_NAMES=['all','Ethereum','Solana','BSC','Near'];
export const SOURCE_MAX_AGE_MS=48*3600000;
export const FETCH_MAX_AGE_MS=30*60000;
const DAY=86400000;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const number=v=>{if(!['string','number'].includes(typeof v)||String(v).trim()==='')throw Error('NUMBER_INVALID');const d=new Decimal(v);if(!d.isFinite()||Math.abs(d.e)>30)throw Error('NUMBER_INVALID');return d;};
const positive=v=>{const d=number(v);if(d.lte(0))throw Error('SUPPLY_INVALID');return d;};
const stamp=v=>Number.isSafeInteger(v)&&v>0;
export function normalizeSupply(raw,{chain,observedAt}){
 if(!CHAIN_NAMES.includes(chain)||!stamp(observedAt)||!Array.isArray(raw)||raw.length<8)throw Error('SUPPLY_SCHEMA');
 // Use nominal USD-pegged circulating supply only. Never sum different peg units,
 // market-cap price effects, unreleased coins, or a chain with the global total.
 const seen=new Set();let prior=0;
 const points=raw.map(row=>{
  const at=Number(row.date)*1000;
  if(!stamp(at)||at>observedAt||at<=prior||seen.has(at))throw Error('SUPPLY_TIME');prior=at;seen.add(at);
  return {at,supply:positive(row.totalCirculating?.peggedUSD).toFixed()};
 });
 const last=points.at(-1),day=points.find(p=>p.at===last.at-DAY),week=points.find(p=>p.at===last.at-7*DAY);
 if(!day||!week)throw Error('SUPPLY_BASELINE_MISSING');
 const change=p=>positive(last.supply).div(p.supply).minus(1).mul(100).toFixed();
 const one=change(day),seven=change(week);
 const bias=number(one).gt(0)&&number(seven).gt(0)?'expanding':number(one).lt(0)&&number(seven).lt(0)?'contracting':number(one).eq(0)&&number(seven).eq(0)?'neutral':'mixed';
 const out={version:CAPITAL_VERSION,provider:'DefiLlama',chain,source:'https://stablecoins.llama.fi/stablecoincharts/'+chain,
  observedAt,sourceAt:last.at,dayAt:day.at,weekAt:week.at,supply:last.supply,change1dPct:one,change7dPct:seven,bias,
  points:[week,day,last],metric:'USD-pegged nominal circulating supply; not exchange netflow',usedForEntries:false};
 return {...out,id:hash(out)};
}
export function supplyUsable(source,now){
 if(!source||source.version!==CAPITAL_VERSION||!CHAIN_NAMES.includes(source.chain)||!stamp(now))return false;
 const {id,...body}=source;
 return id===hash(body)&&stamp(source.observedAt)&&stamp(source.sourceAt)&&source.sourceAt<=source.observedAt&&source.observedAt<=now
  &&now-source.observedAt<=FETCH_MAX_AGE_MS&&now-source.sourceAt<=SOURCE_MAX_AGE_MS;
}
export function chainForPair(pair){return ({ETH:'Ethereum',SOL:'Solana',BNB:'BSC',NEAR:'Near'})[pair.split('/')[0]]??'all';}
export function classifyContext(source,{now,long}){
 if(typeof long!=='boolean'||!supplyUsable(source,now))return {group:'unavailable',advisoryRank:0};
 if(source.bias==='neutral'||source.bias==='mixed')return {group:source.bias,advisoryRank:0};
 const aligned=(source.bias==='expanding')===long;
 return {group:aligned?'aligned':'opposed',advisoryRank:aligned?1:-1};
}
export function observeCapitalFlow(sample,sources,now){
 if(!['demo','demo-futures'].includes(sample?.mode)||!stamp(now))return [];
 const rows=[];
 for(const [pair,proof] of Object.entries(sample.markets??{})){
  for(const long of sample.mode==='demo'?[true]:[true,false]){
   const flow=assessOrderFlow(proof,{mode:sample.mode,pair,long,now});
   const chain=chainForPair(pair),source=sources[chain],context=classifyContext(source,{now,long});
   rows.push({version:CAPITAL_VERSION,mode:sample.mode,pair,direction:long?'long':'short',observedAt:now,
    sampledAt:flow.sampledAt??null,flowValid:flow.status==='ok',flowEligible:flow.eligible===true,flowReason:flow.reason??null,
    proofSha256:hash(proof),takerShare:flow.takerShare??null,chain,scope:chain==='all'?'market-background':'chain-background',
    sourceId:source?.id??null,sourceObservedAt:source?.observedAt??null,sourceAt:source?.sourceAt??null,
    ...context,usedForEntries:false});
  }
 }
 return rows;
}
export function attributeTrade(trade,observations,{mode,startedAt,now}){
 if(!['demo','demo-futures'].includes(mode)||!Number.isInteger(trade.trade_id)||!stamp(trade.open_timestamp)
  ||typeof trade.is_short!=='boolean'||trade.open_timestamp>now)throw Error('TRADE_IDENTITY');
 const direction=trade.is_short?'short':'long';
 const identity={mode,tradeId:trade.trade_id,pair:trade.pair,direction,openedAt:trade.open_timestamp};
 if(trade.open_timestamp<startedAt)return {...identity,group:'pre-start',reason:'BEFORE_OBSERVER_START',observation:null};
 const eligible=observations.filter(o=>o.version===CAPITAL_VERSION&&o.mode===mode&&o.pair===trade.pair&&o.direction===direction
  &&o.flowValid&&stamp(o.observedAt)&&stamp(o.sampledAt)&&o.sampledAt<=o.observedAt
  &&o.observedAt<=trade.open_timestamp&&o.observedAt>=startedAt&&trade.open_timestamp-o.observedAt<=45000
  &&trade.open_timestamp-o.sampledAt<=45000&&o.observedAt<=now).sort((a,b)=>b.observedAt-a.observedAt);
 const observation=eligible[0]??null;
 // Source freshness must also hold at entry, not just at the preceding sample.
 const usable=observation&&observation.sourceObservedAt<=trade.open_timestamp&&observation.sourceAt<=trade.open_timestamp
  &&trade.open_timestamp-observation.sourceObservedAt<=FETCH_MAX_AGE_MS&&trade.open_timestamp-observation.sourceAt<=SOURCE_MAX_AGE_MS;
 return {...identity,group:observation?(usable?observation.group:'unavailable'):'unattributed',
  reason:observation?null:'NO_VALID_PRE_ENTRY_OBSERVATION',observation};
}
export function summarizeCapitalTrades(trades,attributions,{mode,startedAt}){
 const rows=[],ids=new Set();
 for(const t of trades){
  if(!Number.isInteger(t.trade_id)||ids.has(t.trade_id)||typeof t.is_open!=='boolean'||typeof t.is_short!=='boolean'||!stamp(t.open_timestamp)
   ||(!t.is_open&&(!stamp(t.close_timestamp)||t.close_timestamp<t.open_timestamp)))throw Error('TRADE_HISTORY_INVALID');
  ids.add(t.trade_id);if(t.open_timestamp<startedAt)continue;
  const a=attributions[t.trade_id];
  const matched=a?.mode===mode&&a?.pair===t.pair&&a?.openedAt===t.open_timestamp&&a?.direction===(t.is_short?'short':'long');
  let net=null;try{net=number(t.profit_abs).toFixed();}catch{}
  rows.push({mode,id:t.trade_id,pair:t.pair,direction:t.is_short?'short':'long',openedAt:t.open_timestamp,
   closedAt:t.close_timestamp??null,isOpen:t.is_open,netUsdt:net,group:matched?a.group:'unattributed',
   sourceId:matched?a.observation?.sourceId??null:null,observedAt:matched?a.observation?.observedAt??null:null});
 }
 const groups=['aligned','opposed','mixed','neutral','unavailable','unattributed'].map(group=>{
  const selected=rows.filter(r=>r.group===group),closed=selected.filter(r=>!r.isOpen),complete=closed.every(r=>r.netUsdt!==null);
  const sum=complete?closed.reduce((a,r)=>a.plus(r.netUsdt),new Decimal(0)):null;
  const wins=closed.filter(r=>r.netUsdt!==null&&number(r.netUsdt).gt(0)).length;
  const losses=closed.filter(r=>r.netUsdt!==null&&number(r.netUsdt).lt(0)).length;
  const winning=closed.filter(r=>r.netUsdt!==null&&number(r.netUsdt).gt(0)).reduce((n,r)=>n.plus(r.netUsdt),new Decimal(0));
  const losing=closed.filter(r=>r.netUsdt!==null&&number(r.netUsdt).lt(0)).reduce((n,r)=>n.plus(r.netUsdt),new Decimal(0));
  let equity=new Decimal(0),peak=equity,drawdown=equity;
  for(const r of [...closed].sort((a,b)=>a.closedAt-b.closedAt||a.id-b.id))if(r.netUsdt!==null){equity=equity.plus(r.netUsdt);peak=Decimal.max(peak,equity);drawdown=Decimal.max(drawdown,peak.minus(equity));}
  return {mode,group,closed:closed.length,open:selected.length-closed.length,complete,wins,losses,
   winRatePct:complete&&closed.length?new Decimal(wins).div(closed.length).mul(100).toFixed():null,
   netUsdt:sum?.toFixed()??null,averageNetUsdt:sum&&closed.length?sum.div(closed.length).toFixed():null,
   averageWinUsdt:complete&&wins?winning.div(wins).toFixed():null,averageLossUsdt:complete&&losses?losing.div(losses).toFixed():null,
   closedTradeDrawdownUsdt:complete?drawdown.toFixed():null};
 });
 return {mode,groups,rows};
}
