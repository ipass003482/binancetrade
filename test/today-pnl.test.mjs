import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeToday,readTodayPnl,todayWindow} from '../src/today-pnl.mjs';
const now=Date.parse('2026-09-15T20:00:00+08:00'),start=Date.parse('2026-09-15T00:00:00+08:00');
const trade=(id,closed,pnl,extra={})=>({trade_id:id,is_open:false,open_timestamp:start-3600000,close_timestamp:closed,profit_abs:pnl,pair:'UNI/USDT',amount:1,open_rate:2,close_rate:3,...extra});
test('Taipei day includes midnight and overnight closes, all rows over50, excludes prior day',()=>{
 assert.equal(todayWindow(now).startAt,'2026-09-14T16:00:00.000Z');
 const rows=Array.from({length:61},(_,i)=>trade(i,start+i,'0.1'));
 rows.push(trade(99,start-1,'-99'),trade(100,null,'-.2',{is_open:true}));
 const result=summarizeToday(rows,{now,mode:'demo'});assert.equal(result.closedCount,61);assert.equal(result.realizedUsdt,'6.1');assert.equal(result.floatingUsdt,'-0.2');assert.equal(result.rows.length,62);assert.equal(result.rows[0].carriedIn,true);
});
test('missing PnL is unknown, never a zero; duplicate IDs and missing close times rejected',()=>{
 assert.equal(summarizeToday([trade(1,start,null)],{now}).realizedUsdt,null);
 assert.throws(()=>summarizeToday([trade(1,start,1),trade(1,start,1)],{now}),/HISTORY_ID_INVALID/);
 assert.throws(()=>summarizeToday([trade(1,null,1)],{now}),/CLOSE_TIME_MISSING/);
});
test('one unavailable account prevents combined total without hiding other account results',async()=>{
 const d=await readTodayPnl({session:null,now:()=>now,historyFor:async m=>{if(m==='demo-futures')throw Error('secret');return [trade(1,start,'-.25')];}});
 assert.equal(d.complete,false);assert.equal(d.realizedUsdt,null);assert.equal(d.modes[0].realizedUsdt,'-0.25');assert.ok(!JSON.stringify(d).includes('secret'));
});
test('both modes sum exactly and crossing midnight invalidates mixed-day reads',async()=>{
 const d=await readTodayPnl({session:null,now:()=>now,historyFor:async m=>[trade(1,start,m==='demo'?'0.1':'0.2')]});assert.equal(d.realizedUsdt,'0.3');assert.equal(d.closedCount,2);
 let n=0;await assert.rejects(readTodayPnl({session:null,now:()=>start+(n++?-0: -1),historyFor:async()=>[]}),/DAY_CHANGED_RETRY/);
});

test('future or backwards close times cannot silently produce a complete zero-PnL day',()=>{
 for(const closed of [now+1,start+86400000,start-3600001])
  assert.throws(()=>summarizeToday([trade(1,closed,'-1')],{now}),/CLOSE_TIME_INVALID/);
});

const session={schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',startedAt:new Date(start+12*3600000).toISOString(),modes:['demo','demo-futures']};
test('midday session excludes previous openings including IDs reused after reset',async()=>{
 const boundary=Date.parse(session.startedAt),fresh=trade(1,boundary+1000,'-.4',{open_timestamp:boundary});
 const old=trade(1,boundary+2000,'100',{open_timestamp:boundary-1});
 const d=await readTodayPnl({session,now:()=>now,historyFor:async()=>[old,fresh]});
 assert.deepEqual(d.session,session);assert.equal(d.startAt,session.startedAt);assert.equal(d.realizedUsdt,'-0.8');assert.equal(d.closedCount,2);
 assert.equal(d.modes[0].rows.length,1);assert.equal(d.modes[0].rows[0].carriedIn,false);
 const tomorrow=now+86400000;assert.equal(todayWindow(tomorrow,session).startAt,new Date(start+86400000).toISOString());
});
test('old open exposure and unknown open times cannot report a complete empty new run',()=>{
 const d=summarizeToday([trade(1,null,'-3',{is_open:true})],{session,now});
 assert.equal(d.complete,false);assert.equal(d.outsideSessionOpenCount,1);assert.equal(d.realizedUsdt,null);
 assert.equal(d.error,'OUTSIDE_SESSION_OPEN_POSITION');
 assert.throws(()=>summarizeToday([trade(1,start,1,{open_timestamp:null})],{session,now}),/SESSION_TRADE_TIME_INVALID/);
 for(const is_open of [undefined,'true',1])assert.throws(()=>summarizeToday([trade(1,start,-10,{is_open})],{session,now}),/SESSION_TRADE_STATUS_INVALID/);
});
test('bad session fails before native history is fetched',async()=>{
 let calls=0;await assert.rejects(readTodayPnl({session:{...session,id:'bad'},now:()=>now,historyFor:async()=>{calls++;return [];}}),/DEMO_SESSION_INVALID/);
 assert.equal(calls,0);
});
