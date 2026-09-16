import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {CAPITAL_VERSION,normalizeSupply,supplyUsable,classifyContext,chainForPair,observeCapitalFlow,attributeTrade,summarizeCapitalTrades} from '../src/capital-flow.mjs';
import {createCapitalRecorder,readCapitalView,readObservationWindow} from '../src/capital-flow-store.mjs';
import {createDashboardServer} from '../src/dashboard.mjs';
const B=Date.parse('2026-09-15T00:00:00Z'),N=B+20000,D=86400000;
const raw=(decline=false)=>Array.from({length:8},(_,i)=>({date:String((B-(7-i)*D)/1000),totalCirculating:{peggedUSD:decline?108-i:100+i,peggedJPY:999999},totalCirculatingUSD:{peggedUSD:999999}}));
const source=(chain='Ethereum',at=N)=>normalizeSupply(raw(),{chain,observedAt:at});
function sample(short=false){
 const mode=short?'demo-futures':'demo',pair=short?'ETH/USDT:USDT':'ETH/USDT';
 const books=[-20000,-10000,0].map((delta,i)=>{const mid=100+(short?-1:1)*i*.001;
  return {at:N+delta,updateId:i+1,bids:Array.from({length:5},(_,k)=>[String(mid-.001-k*.001),short?'1':'3']),asks:Array.from({length:5},(_,k)=>[String(mid+.001+k*.001),short?'3':'1'])};});
 const proof={version:'sampled-demo-flow-v1',mode,pair,source:short?'https://demo-fapi.binance.com':'https://demo-api.binance.com',books,startTime:N-61500,endTime:N-1500,
  trades:[0,1,2].map(i=>({a:i+1,T:N-55000+i*25000,p:'100',q:'1',m:short}))};
 return {mode,observedAt:N,completedAt:N,markets:{[pair]:proof}};
}
const trade=(id,pnl,extra={})=>({trade_id:id,pair:'ETH/USDT',is_short:false,is_open:false,open_timestamp:N+1000,close_timestamp:N+60000,profit_abs:pnl,...extra});
test('supply has correct units, exact daily baselines, freshness, integrity and no lookahead',()=>{
 const s=source();assert.equal(s.supply,'107');assert.equal(s.bias,'expanding');assert.equal(supplyUsable(s,N),true);
 assert.equal(supplyUsable({...s,supply:'108'},N),false);
 assert.equal(supplyUsable(s,N-1),false);assert.equal(supplyUsable(s,N+30*60000+1),false);
 assert.equal(supplyUsable(source('Ethereum',B+3*D),B+3*D),false);
 assert.throws(()=>normalizeSupply([...raw(),raw().at(-1)],{chain:'all',observedAt:N}));
 assert.throws(()=>normalizeSupply(raw(),{chain:'all',observedAt:B-1}));
 const gap=raw();gap[6].date=String((B-D-1000)/1000);assert.throws(()=>normalizeSupply(gap,{chain:'all',observedAt:N}),/BASELINE/);
 const bad=raw();bad[7].totalCirculating.peggedUSD=null;assert.throws(()=>normalizeSupply(bad,{chain:'all',observedAt:N}));
});
test('chain background is scoped, missing context neutral to execution, and long/short classifications differ',()=>{
 assert.equal(chainForPair('UNI/USDT'),'all');assert.equal(chainForPair('NEAR/USDT'),'Near');assert.equal(chainForPair('SOL/USDT:USDT'),'Solana');
 assert.deepEqual(classifyContext(null,{now:N,long:true}),{group:'unavailable',advisoryRank:0});
 const sources={Ethereum:source()};
 const long=observeCapitalFlow(sample(),sources,N)[0],short=observeCapitalFlow(sample(true),sources,N).find(r=>r.direction==='short');
 assert.equal(long.flowEligible,true);assert.equal(long.group,'aligned');assert.equal(short.flowEligible,true);assert.equal(short.group,'opposed');
 const absent=observeCapitalFlow(sample(),{},N)[0];assert.equal(absent.flowEligible,long.flowEligible);assert.equal(absent.usedForEntries,false);
});
test('trade attribution requires pre-entry observations, original timestamps and source freshness',()=>{
 const obs=observeCapitalFlow(sample(),{Ethereum:source()},N),options={mode:'demo',startedAt:B,now:N+70000};
 assert.equal(attributeTrade(trade(1,'1'),obs,options).group,'aligned');
 assert.equal(attributeTrade(trade(1,'1',{open_timestamp:N-1}),obs,options).group,'unattributed');
 assert.equal(attributeTrade(trade(1,'1',{open_timestamp:N+45001}),obs,options).group,'unattributed');
 assert.equal(attributeTrade(trade(1,'1',{open_timestamp:B-1}),obs,options).group,'pre-start');
 const wrong=obs.map(o=>({...o,mode:'demo-futures'}));assert.equal(attributeTrade(trade(1,'1'),wrong,options).group,'unattributed');
 const expired=obs.map(o=>({...o,sourceObservedAt:N-30*60000}));assert.equal(attributeTrade(trade(1,'1'),expired,options).group,'unavailable');
});
test('real net PnL deduplicates mode identities, keeps losses, separates open trades and missing PnL',()=>{
 const ts=[trade(1,'.1'),trade(2,'.2'),trade(3,'-.5'),trade(4,'9',{is_open:true}),trade(5,'2',{open_timestamp:B-1})];
 const attributes=Object.fromEntries(ts.map(t=>[t.trade_id,attributeTrade(t,observeCapitalFlow(sample(),{Ethereum:source()},N),{mode:'demo',startedAt:B,now:N+70000})]));
 const r=summarizeCapitalTrades(ts,attributes,{mode:'demo',startedAt:B}),g=r.groups.find(g=>g.group==='aligned');
 assert.equal(r.rows.length,4);assert.equal(g.netUsdt,'-0.2');assert.equal(g.closed,3);assert.equal(g.open,1);assert.equal(g.wins,2);assert.equal(g.losses,1);assert.equal(g.closedTradeDrawdownUsdt,'0.5');
 assert.throws(()=>summarizeCapitalTrades([ts[0],ts[0]],attributes,{mode:'demo',startedAt:B}));
 ts[0].profit_abs=null;const incomplete=summarizeCapitalTrades(ts,attributes,{mode:'demo',startedAt:B}).groups.find(g=>g.group==='aligned');assert.equal(incomplete.netUsdt,null);assert.equal(incomplete.winRatePct,null);
});
test('recorder runs without trade writes, saves immutable pre-entry source and recovers attribution',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'capital-observer-'));let at=N,filled=false,fail=false,fetches=0;
 const options={directory,now:()=>at,flowFor:async mode=>({...sample(mode==='demo-futures'),completedAt:at}),historyFor:async mode=>{if(fail)throw Error('SECRET');return filled&&mode==='demo'?[trade(1,'.25')]:[];},fetchImpl:async url=>{assert.ok(url.startsWith('https://stablecoins.llama.fi/stablecoincharts/'));fetches++;return {ok:true,text:async()=>JSON.stringify(raw())};}};
 const recorder=await createCapitalRecorder(options);await recorder.tick();await recorder.settleSources();await recorder.settleHistory();
 at=N+500;await recorder.tick();
 at=N+600;
 // Use a new recorder to force a fresh sample without modifying any trade engine.
 const recovered=await createCapitalRecorder(options);await recovered.tick();await recovered.settleSources();await recovered.settleHistory();
 at=N+700;await recovered.tick();
 filled=true;at=N+31000;await recovered.tick();await recovered.settleHistory();const r=await recovered.tick();
 assert.equal(r.results[0].rows.length,1);assert.equal(r.usedForEntries,false);assert.equal(r.results[0].rows[0].group,'aligned');
 const before=await readFile(join(directory,'trades/demo-1.json'),'utf8');
 at=N+62000;await recovered.tick();await recovered.settleHistory();await recovered.tick();assert.equal(await readFile(join(directory,'trades/demo-1.json'),'utf8'),before);
 const view=await readCapitalView({directory,now:at});assert.equal(view.sources.length,5);assert.equal(view.sources[0].usable,true);
 assert.equal((await readCapitalView({directory,now:at+90001})).reason,'CAPITAL_OBSERVER_STALE');
 fail=true;at=N+93000;await recovered.tick();await recovered.settleHistory();const failed=await recovered.tick();assert.deepEqual(failed.results,[]);assert.ok(!JSON.stringify(failed).includes('SECRET'));assert.equal(Object.keys(failed.historyErrors).length,2);
 assert.equal(fetches,10);
});
test('slow history does not block sampling and stale PnL is cleared independently',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'capital-slow-'));let at=N;let release;
 const gate=new Promise(resolve=>{release=resolve;});let calls=0;
 const recorder=await createCapitalRecorder({directory,now:()=>at,flowFor:async mode=>({...sample(mode==='demo-futures'),completedAt:at}),
  fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(raw())}),historyFor:async()=>{calls++;await gate;return [];}});
 const deadline=()=>new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('SAMPLER_BLOCKED_BY_HISTORY')),500);timer.unref();});
 const first=await Promise.race([recorder.tick(),deadline()]);assert.equal(first.historyPending,true);
 at+=10000;await Promise.race([recorder.tick(),deadline()]);assert.equal(calls,2);
 const lines=(await readFile(join(directory,'observations-2026-09-15.jsonl'),'utf8')).trim().split('\n');assert.equal(lines.length,2);
 const pending=await readCapitalView({directory,now:at});assert.equal(pending.status,'observing');assert.equal(pending.historyStale,true);assert.deepEqual(pending.results,[]);
 release();await recorder.settleHistory();await recorder.settleSources();await recorder.tick();
 assert.equal((await readCapitalView({directory,now:at})).historyStale,false);
});
test('first discovery after long outage recovers actual pre-entry journal across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'capital-recovery-'));let at=N,filled=false;
 const options={directory,now:()=>at,flowFor:async mode=>({...sample(mode==='demo-futures'),completedAt:at}),
  fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify(raw())}),historyFor:async mode=>filled&&mode==='demo'?[trade(1,'.25')]:[]};
 const first=await createCapitalRecorder(options);await first.tick();await first.settleSources();await first.settleHistory();
 at=N+500;await first.tick();
 at=N+5*60000;filled=true;const recovered=await createCapitalRecorder(options);await recovered.tick();await recovered.settleHistory();await recovered.settleSources();
 const result=await recovered.tick();assert.equal(result.results[0].rows[0].group,'aligned');assert.equal(result.results[0].rows[0].observedAt,N+500);
});
test('bounded streaming recovery spans midnight and rejects torn journals',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'capital-midnight-'));
 const batch=at=>JSON.stringify({version:CAPITAL_VERSION,observations:[{observedAt:at}]})+'\n';
 await writeFile(join(directory,'observations-2026-09-14.jsonl'),batch(B-10000));await writeFile(join(directory,'observations-2026-09-15.jsonl'),batch(B+10000));
 assert.deepEqual((await readObservationWindow(directory,{from:B-15000,to:B+15000})).map(o=>o.observedAt),[B-10000,B+10000]);
 await writeFile(join(directory,'observations-2026-09-15.jsonl'),'{');await assert.rejects(readObservationWindow(directory,{from:B,to:B+15000}),/INCOMPLETE/);
});
test('dashboard capital route is read-only and protected by local origin',async t=>{
 const server=createDashboardServer({port:18109,capital:async()=>({version:CAPITAL_VERSION,usedForEntries:false})});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const call=(method='GET',origin)=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/api/capital-flow',method,headers:{Host:'127.0.0.1:18109',...(origin?{Origin:origin}:{})}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,data}));});req.on('error',reject);req.end();});
 assert.equal((await call()).status,200);assert.equal((await call('POST')).status,405);assert.equal((await call('GET','https://other.example')).status,403);
});
