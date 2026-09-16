import test from 'node:test';
import assert from 'node:assert/strict';
import { collect,market } from '../src/research.mjs';
import { technicalSummary,ResearchSchema } from '../src/research-profile.mjs';
import { loadPolicy } from '../src/config.mjs';
function bars(timeframe='15m'){
 const ms=timeframe==='5m'?300000:900000,n=timeframe==='5m'?96:32,end=Math.floor(Date.now()/ms)*ms;
 return Array.from({length:n},(_,i)=>[end-(n-i)*ms,'100','102','99','101','10',end-(n-1-i)*ms-1]);
}
function fetchMock(url){
 const u=new URL(url),symbol=u.searchParams.get('symbol')??'BTCUSDT';
 if(u.pathname.endsWith('/time'))return Promise.resolve(new Response(JSON.stringify({serverTime:Date.now()})));
 return Promise.resolve(new Response(JSON.stringify(u.pathname.endsWith('exchangeInfo')
  ?{symbols:[{symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]}
  :u.pathname.endsWith('bookTicker')?{symbol,bidPrice:'100',askPrice:'100.01'}:bars(u.searchParams.get('interval')??'15m'))));
}
test('Demo collector uses only Demo market URLs and produces closed-candle summaries',async()=>{
 const p=await loadPolicy('demo'),hosts=[];
 const snapshot=await collect(p,{includeWeb3:false,fetchImpl:u=>{hosts.push(new URL(u).hostname);return fetchMock(u);}});
 assert.ok(hosts.every(h=>h==='demo-api.binance.com'));
 assert.equal(snapshot.mode,'demo');
 assert.equal(snapshot.evidence.filter(e=>e.id.startsWith('technical:')).length,p.pairs.length);
 const m=snapshot.markets[0];assert.equal(technicalSummary(m.candles,m.timeframe).sma20,'101');
});
test('bad or discontinuous OHLCV does not create misleading indicators',()=>{
 const candles=bars().map(b=>({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4],volume:b[5],closeTime:b[6]}));
 candles[10].close='NaN';assert.throws(()=>technicalSummary(candles),/INVALID_CANDLE/);
 candles[10].close='101';candles[10].openTime-=1;assert.throws(()=>technicalSummary(candles),/INVALID_CANDLE/);
});
test('explicit token and wallet mapping uses all four skills; missing audit stays unavailable',async()=>{
 const p=await loadPolicy(),calls=[],token={chainId:'56',contractAddress:'0x1111111111111111111111111111111111111111',
  relationship:'wrapped-proxy',source:'https://example.invalid/verified-mapping',note:'Synthetic mapping for test only'};
 const profile=ResearchSchema.parse({version:1,pairs:{'BTC/USDT':{chainTokens:[token],
  wallets:[{chainId:'56',address:'0x2222222222222222222222222222222222222222',label:'Public test wallet'}]}}});
 const s=await collect(p,{profile,fetchImpl:fetchMock,queryWeb3:async(skill,command)=>{
  calls.push([skill,command]);
  if(command==='audit')throw new Error('UPSTREAM_ERROR');
  return {status:'ok',data:{sample:true},source:'https://web3.binance.com',fetchedAt:new Date().toISOString()};
 }});
 assert.equal(new Set(calls.map(c=>c[0])).size,4);
 assert.equal(s.evidence.find(e=>e.id.endsWith(':audit')).status,'unavailable');
 assert.equal(s.evidence.find(e=>e.id.endsWith(':dynamic')).relationship.kind,'wrapped-proxy');
 assert.match(s.researchCoverage.find(r=>r.pair==='ETH/USDT').note,/No verified/);
});
test('without mappings do not auto-audit similarly named wrapped tokens',async()=>{
 const p=await loadPolicy(),calls=[];
 await collect(p,{profile:{pairs:{}},fetchImpl:fetchMock,queryWeb3:async(skill,command)=>{
  calls.push(command);return {status:'ok',data:[]};
 }});
 assert.deepEqual(calls.sort(),[...p.pairs.map(()=> 'search'),'token-rank']);
});
