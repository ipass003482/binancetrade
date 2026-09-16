import test from 'node:test';
import assert from 'node:assert/strict';
import { web3,market } from '../src/research.mjs';
import { jsonFetch } from '../src/http.mjs';
import { safeEnv } from '../src/codex.mjs';
test('audit without results cannot expose a low risk rating',async()=>{
 const r=await web3('query-token-audit','audit',{binanceChainId:'56',contractAddress:'0x55d398326f99059ff775485246999027b3197955'},
  {fetchImpl:async()=>new Response(JSON.stringify({success:true,data:{hasResult:false,isSupported:true,riskLevel:0}}))});
 assert.equal(r.status,'unavailable');assert.equal(r.data.riskLevel,undefined);
});
test('no arbitrary URL or trading commands in research interface',async()=>{
 await assert.rejects(web3('binance','order',{}),/Unsupported/);
 await assert.rejects(web3('query-address-info','positions',{address:'0x0',chainId:'56',offset:0}),/invalid EVM/);
});
test('HTTP 200 business error is not usable market data',async()=>{
 await assert.rejects(jsonFetch('https://example.invalid',{fetchImpl:async()=>new Response('{"success":false,"code":"100"}')}),/UPSTREAM/);
});
test('CEX identity checks full symbol and trading status',async()=>{
 const mock=async(url)=>new Response(JSON.stringify(String(url).endsWith('/time')?{serverTime:Date.now()}:String(url).includes('exchangeInfo')
  ?{symbols:[{symbol:'BTCUSDT',baseAsset:'FAKE',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]}
  :String(url).includes('bookTicker')?{bidPrice:'1',askPrice:'1.1'}:[]));
 await assert.rejects(market('BTC/USDT',{fetchImpl:mock}),/NOT_A_VERIFIED/);
});
test('research subprocess gets no broker/provider secrets from environment',()=>{
 const env=safeEnv({Path:'node',SYSTEMROOT:'windows',BINANCE_API_KEY:'secret',FREQTRADE__DRY_RUN:'false',OPENAI_API_KEY:'secret'});
 assert.deepEqual(env,{Path:'node',SYSTEMROOT:'windows'});
});
