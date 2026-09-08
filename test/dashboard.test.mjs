import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { DashboardStore } from '../ui/store.mjs';
import { createDashboardServer, readEngine } from '../src/dashboard.mjs';

test('preview never requests account or market services',async()=>{
 let calls=0;const store=new DashboardStore({fetchImpl:async()=>{calls++;throw new Error('NO_NETWORK');}});
 await store.refresh({preview:true,pair:'ETH/USDT',mode:'demo'});
 assert.equal(calls,0);assert.equal(store.state.market.pair,'ETH/USDT');assert.equal(store.state.data.mode,'demo');assert.equal(store.state.loading,false);
});

test('a superseded response cannot overwrite the selected environment',async()=>{
 const pending=[];const store=new DashboardStore({fetchImpl:url=>new Promise(resolve=>pending.push({url,resolve}))});
 const first=store.refresh();const second=store.refresh({mode:'demo'});
 pending[2].resolve({ok:true,json:async()=>({mode:'demo'})});pending[3].resolve({ok:true,json:async()=>({mode:'demo',pair:'BTC/USDT'})});await second;
 pending[0].resolve({ok:true,json:async()=>({mode:'dry-run'})});pending[1].resolve({ok:true,json:async()=>({mode:'dry-run'})});await first;
 assert.equal(store.state.data.mode,'demo');assert.equal(store.state.market.mode,'demo');assert.equal(store.state.loading,false);
});

test('account failure preserves independently available market data',async()=>{
 const store=new DashboardStore({fetchImpl:async url=>url.includes('/api/dashboard')?{ok:false}:{ok:true,json:async()=>({pair:'BTC/USDT'})}});
 await store.refresh();assert.equal(store.state.data,null);assert.ok(store.state.error);assert.equal(store.state.market.pair,'BTC/USDT');assert.equal(store.state.marketError,null);assert.equal(store.state.loading,false);
});

test('dashboard rejects cross-site reads, writes, unlisted files and unsupported modes',async t=>{
 let reads=0;const server=createDashboardServer({port:18109,state:async mode=>{reads++;return {mode};},quote:async()=>({pair:'BTC/USDT'})});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'127.0.0.1:18109',...headers}},res=>{let body='';res.setEncoding('utf8');res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end();
 });
 assert.equal((await call('/api/dashboard',{Host:'attacker.example'})).status,403);
 assert.equal((await call('/api/dashboard',{Origin:'https://attacker.example'})).status,403);
 assert.equal((await call('/api/dashboard',{'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await call('/api/dashboard',{},'POST')).status,405);
 assert.equal((await call('/local/api-auth.json')).status,404);
 assert.equal((await call('/api/dashboard?mode=live')).status,503);
 assert.equal(reads,0);
 const state=await call('/api/dashboard?mode=demo');assert.equal(state.status,200);assert.deepEqual(JSON.parse(state.body),{mode:'demo'});assert.equal(reads,1);
 const page=await call('/');assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);assert.match(page.body,/Binance trade/);
});


test('transport does not pass the store as the native fetch receiver',async()=>{
 const receivers=[];
 const store=new DashboardStore({fetchImpl:async function(){receivers.push(this);return {ok:true,json:async()=>({ok:true})};}});
 await store.refresh();assert.deepEqual(receivers,[undefined,undefined]);assert.equal(store.state.error,null);assert.equal(store.state.data.ok,true);
});

test('engine view maps account and closed trades without exposing extra fields',async()=>{
 const open={trade_id:3,is_open:true,pair:'BTC/USDT',stake_amount:25,open_rate:60000,current_rate:60100,profit_abs:.04,profit_ratio:.0016,secret:'DO_NOT_EXPOSE',orders:[{apiKey:'DO_NOT_EXPOSE'}]};
 const old={trade_id:1,is_open:false,pair:'ETH/USDT',stake_amount:25,open_rate:2000,close_rate:2080,profit_abs:1,close_timestamp:1,close_date:'2026-09-01T10:00:00Z',exit_reason:'roi',apiKey:'DO_NOT_EXPOSE'};
 const recent={...old,trade_id:2,profit_abs:2,close_timestamp:2,close_date:'2026-09-01T11:00:00Z'};
 const view=await readEngine({snapshot:async()=>({engine:{password:'DO_NOT_EXPOSE'},balance:{total:1003,secret:'DO_NOT_EXPOSE'},trades:[open]}),history:async()=>[old,open,recent]});
 assert.deepEqual(view.account,{total:1003,positions:[{id:3,pair:'BTC/USDT',stake:25,openRate:60000,currentRate:60100,profit:.04,profitRatio:.0016}]});
 assert.equal(view.summary.netRealizedUsdt,'3');assert.deepEqual(view.trades.map(t=>t.id),[2,1]);assert.equal(view.trades[0].closedAt,'2026-09-01T11:00:00Z');assert.equal(view.historyError,null);assert.ok(!JSON.stringify(view).includes('DO_NOT_EXPOSE'));
});

test('history errors preserve current account while incomplete history is explicit',async()=>{
 const view=await readEngine({snapshot:async()=>({balance:{total:1000},trades:[]}),history:async()=>{throw new Error('HISTORY_CHANGED: sensitive details');}});
 assert.deepEqual(view.account,{total:1000,positions:[]});assert.equal(view.summary,null);assert.equal(view.trades,null);assert.equal(view.historyError,'HISTORY_CHANGED');assert.ok(!JSON.stringify(view).includes('sensitive'));
});

test('an unverified snapshot never produces a connected account view',async()=>{
 let historyCalled=false;await assert.rejects(readEngine({snapshot:async()=>{throw new Error('ENGINE_IDENTITY_REJECTED');},history:async()=>{historyCalled=true;return [];}}),/ENGINE_IDENTITY_REJECTED/);assert.equal(historyCalled,false);
});
