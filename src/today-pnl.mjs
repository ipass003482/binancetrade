import Decimal from 'decimal.js';
import {join} from 'node:path';
import {loadPolicy} from './config.mjs';
import {modeLocal} from './mode.mjs';
import {readJson} from './io.mjs';
import {FreqtradeClient} from './freqtrade.mjs';
import {readDemoSession,validateDemoSession,sessionTrades,sessionOpenCount} from './demo-session.mjs';

const MODES=['demo','demo-futures'];
const numeric=v=>{if(!['number','string'].includes(typeof v)||String(v).trim()==='')return null;try{const d=new Decimal(v);return d.isFinite()?d:null;}catch{return null;}};
const stamp=v=>Number.isSafeInteger(v)&&v>0?v:null;
export function todayWindow(now=Date.now(),session=null){
 const date=new Date(now+8*3600000).toISOString().slice(0,10);
 const midnight=Date.parse(date+'T00:00:00+08:00');
 return {date,timeZone:'Asia/Taipei',startAt:new Date(Math.max(midnight,session?Date.parse(session.startedAt):midnight)).toISOString(),endAt:new Date(midnight+86400000).toISOString()};
}
export function summarizeToday(trades,{now=Date.now(),mode,session=null}={}){
 if(session)session=validateDemoSession(session,{now});
 const outsideSessionOpenCount=sessionOpenCount(trades,session);
 trades=sessionTrades(trades,session);
 if(!Array.isArray(trades))throw Error('HISTORY_UNAVAILABLE');
 const window=todayWindow(now,session),start=Date.parse(window.startAt),end=Date.parse(window.endAt),ids=new Set();
 const rows=[];let realized=new Decimal(0),floating=new Decimal(0),closedCount=0,openCount=0,wins=0,losses=0,complete=outsideSessionOpenCount===0;
 for(const t of trades){
  if(!Number.isInteger(t.trade_id)||ids.has(t.trade_id))throw Error('HISTORY_ID_INVALID');ids.add(t.trade_id);
  if(typeof t.is_open!=='boolean')throw Error('HISTORY_STATUS_INVALID');
  const opened=stamp(t.open_timestamp),closed=stamp(t.close_timestamp);
  if(!t.is_open&&!closed)throw Error('CLOSE_TIME_MISSING');
  if(!opened||opened>now)throw Error('OPEN_TIME_INVALID');
  if(!t.is_open&&(closed>now||closed<opened))throw Error('CLOSE_TIME_INVALID');
  if(!t.is_open&&(closed<start||closed>=end))continue;
  const pnl=numeric(t.profit_abs);if(!pnl)complete=false;
  if(t.is_open){openCount++;if(pnl)floating=floating.plus(pnl);}else{closedCount++;if(pnl){realized=realized.plus(pnl);if(pnl.gt(0))wins++;if(pnl.lt(0))losses++;}}
  rows.push({mode,id:t.trade_id,pair:typeof t.pair==='string'?t.pair:'—',direction:t.is_short===true?'short':'long',isOpen:t.is_open,
   openedAt:new Date(opened).toISOString(),closedAt:closed?new Date(closed).toISOString():null,carriedIn:opened<start,
   amount:numeric(t.amount)?.toFixed()??null,openRate:numeric(t.open_rate)?.toFixed()??null,
   closeRate:numeric(t.is_open?t.current_rate:t.close_rate)?.toFixed()??null,netUsdt:pnl?.toFixed()??null,
   exitReason:typeof t.exit_reason==='string'?t.exit_reason:null});
 }
 return {mode,complete,outsideSessionOpenCount,...(outsideSessionOpenCount?{error:'OUTSIDE_SESSION_OPEN_POSITION'}:{}),closedCount,openCount,wins,losses,realizedUsdt:complete?realized.toFixed():null,floatingUsdt:complete?floating.toFixed():null,
  rows:rows.sort((a,b)=>Number(b.isOpen)-Number(a.isOpen)||Date.parse(b.closedAt??b.openedAt)-Date.parse(a.closedAt??a.openedAt))};
}
export async function readTodayPnl({now=()=>Date.now(),readSession=readDemoSession,session:providedSession,historyFor=async mode=>{
 const policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(modeLocal(mode),'api-auth.json')));return client.history();
}}={}){
 const started=now(),session=providedSession===undefined?await readSession({now:started}):providedSession;
 if(session)validateDemoSession(session,{now:started});
 const results=await Promise.allSettled(MODES.map(async mode=>({mode,trades:await historyFor(mode)}))),observed=now();
 if(todayWindow(started).date!==todayWindow(observed).date)throw Error('DAY_CHANGED_RETRY');
 const modes=results.map((r,index)=>{if(r.status==='fulfilled'){try{return summarizeToday(r.value.trades,{mode:MODES[index],now:observed,session});}catch{}}
  return {mode:MODES[index],complete:false,error:'當次交易紀錄不完整，請重新整理',realizedUsdt:null,floatingUsdt:null,closedCount:null,openCount:null,rows:[]};});
 const complete=modes.every(m=>m.complete),sum=k=>complete?modes.reduce((n,m)=>n.plus(m[k]),new Decimal(0)).toFixed():null;
 return {...todayWindow(observed,session),session,observedAt:new Date(observed).toISOString(),source:'Binance Demo / Freqtrade',complete,modes,
  realizedUsdt:sum('realizedUsdt'),floatingUsdt:sum('floatingUsdt'),closedCount:complete?modes.reduce((s,m)=>s+m.closedCount,0):null,
  openCount:complete?modes.reduce((s,m)=>s+m.openCount,0):null};
}
