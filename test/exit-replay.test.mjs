import test from 'node:test';
import assert from 'node:assert/strict';
import { replayExit,compareExits,variants } from '../src/exit-replay.mjs';
const trade={trade_id:1,open_timestamp:1800000000000,open_rate:100,stake_amount:300,fee_open:.001,fee_close:.001,is_short:false,trading_mode:'spot'};
const bars=()=>Array.from({length:360},(_,i)=>({time:trade.open_timestamp+i*60000,open:100,high:100,low:100,close:100}));
test('flat-price replay includes both fees and additional exit slippage',()=>{
 const a=replayExit(trade,bars(),variants[0]);assert.ok(Math.abs(a.netUsdt+.6)<1e-9);assert.equal(a.reason,'horizon_mark');
 const b=replayExit(trade,bars(),variants[0],{slippageBps:10});assert.ok(b.netUsdt<a.netUsdt);
 assert.equal(replayExit(trade,bars(),variants[2]).holdingMinutes,120);
});
test('intrabar sequencing changes trailing exit; stop gaps never fill at stale stop',()=>{
 const b=bars();b[0]={...b[0],high:102,close:102};b[1]={...b[1],open:99,high:99,low:99,close:99};
 const lo=replayExit(trade,b,variants[1],{path:'low-first'}),hi=replayExit(trade,b,variants[1],{path:'high-first'});
 assert.equal(lo.reason,'trailing_gap');assert.equal(lo.price,99);assert.equal(hi.reason,'trailing_stop');assert.equal(hi.price,102*.996);
});
test('missing, duplicated, malformed candles and unsupported trades fail closed',()=>{
 assert.throws(()=>replayExit(trade,bars().slice(1),variants[0]),/COVERAGE/);
 const b=bars();b[2].time=b[1].time;assert.throws(()=>replayExit(trade,b,variants[0]),/INVALID_BARS/);
 assert.throws(()=>replayExit({...trade,fee_close:null},bars(),variants[0]),/UNSUPPORTED/);
 assert.throws(()=>replayExit({...trade,is_short:true},bars(),variants[0]),/UNSUPPORTED/);
});
test('comparisons use identical entries and label separate slippage scenarios',()=>{
 const c=compareExits([trade],{1:bars()});assert.equal(c.summary.length,12);assert.equal(c.results.length,24);
 assert.ok(c.summary.every(s=>s.trades===1&&s.sampledPathNetMinUsdt<=s.sampledPathNetMaxUsdt));
});
