import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture,engineConfig,trendCandles,clockFixture } from './fixtures.mjs';
import { loadPolicy,ProposalSchema,FuturesProposalSchema } from '../src/config.mjs';
import { modeLocal } from '../src/mode.mjs';
import { assess } from '../src/risk.mjs';
import { execute } from '../src/bridge.mjs';
import { reconcile } from '../src/reconcile.mjs';
import { journalRead,journalAppend } from '../src/io.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { market,collect } from '../src/research.mjs';
import { buildAnalystPrompt } from '../src/analyst.mjs';
import { makeEngineConfig } from '../src/engine-config.mjs';
import { DashboardStore,previewData } from '../ui/store.mjs';
const filters=[{filterType:'LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},
 {filterType:'MARKET_LOT_SIZE',minQty:'0.001',maxQty:'1000',stepSize:'0.001'},{filterType:'MIN_NOTIONAL',notional:'5'}];
async function futureFixture(action='open-short'){
 const f=await fixture();f.policy={...await loadPolicy('demo-futures'),leverage:3,maxStakeUsdt:'50',maxExposureUsdt:'50',maxOpenTrades:2,maxNotionalUsdt:'150',maxTotalNotionalUsdt:'150',maxDailyLossUsdt:'20',maxEntriesPerDay:4};f.snapshot.mode=f.policy.mode;f.snapshot.timeframe='5m';f.snapshot.candleBoundary=Math.floor(f.now/300000)*300000;
 const pair='BTC/USDT:USDT';f.proposal={...f.proposal,action,pair,leverage:3,evidenceIds:['futures:'+pair]};
 f.snapshot.clock=clockFixture(f.now,f.policy.mode);
 f.snapshot.evidence=[{id:'futures:'+pair,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}];
 f.snapshot.markets=[{...f.snapshot.markets[0],pair,mode:f.policy.mode,source:'https://demo-fapi.binance.com',verifiedSpot:false,verifiedFutures:true,filters,candles:trendCandles(f.now,action.endsWith('short')?'short':'long','5m')}];
 f.snapshot.markets[0].clock=f.snapshot.clock;f.executionQuote=structuredClone(f.snapshot.markets[0]);return f;
}
function position(pair='ETH/USDT:USDT',isShort=true){return {trade_id:7,pair,has_open_orders:false,is_short:isShort,is_open:true,
 trading_mode:'futures',leverage:3,stake_amount:25,amount:.75,current_rate:100,profit_abs:0,total_profit_abs:0};}
const local=()=>mkdtemp(join(tmpdir(),'binance-futures-'));

test('four-symbol futures mode has separate state and isolated engine identity',async()=>{
 const p=await loadPolicy('demo-futures');
 assert.deepEqual(p.pairs,['BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','BNB/USDT:USDT']);
 assert.notEqual(modeLocal('demo'),modeLocal(p.mode));
 const c=makeEngineConfig(p,{});assert.equal(c.trading_mode,'futures');assert.equal(c.margin_mode,'isolated');
 assert.equal(c.dry_run,false);assert.equal(c.exchange.demo_trading,true);assert.equal(c.api_server.listen_port,18084);
});

test('spot and futures schemas cannot silently reinterpret each other',async()=>{
 const f=await futureFixture();assert.throws(()=>ProposalSchema.parse(f.proposal));
 assert.throws(()=>FuturesProposalSchema.parse({...f.proposal,action:'sell'}));
 for(const leverage of [0,3.1,4,100])assert.throws(()=>FuturesProposalSchema.parse({...f.proposal,leverage}));
 for(const action of ['open-long','open-short'])assert.equal(assess({...f,proposal:{...f.proposal,action}}).action,action);
});

test('futures limits reject excess notional, margin, stale/spot quotes, min quantity and mixed daily entries',async()=>{
 for(const [change,pattern] of [
  [f=>{f.policy.maxNotionalUsdt='74';},/NOTIONAL/],
  [f=>{f.account.trades=[{...position(),current_rate:200}];},/NOTIONAL/],
  [f=>{f.account.trades=[{...position(),stake_amount:30,leverage:2}];},/EXPOSURE/],
  [f=>{f.policy.marginMode='cross';},/LEVERAGE_MODE/],
  [f=>{f.executionQuote.source='https://fapi.binance.com';},/FUTURES_DEMO_QUOTE/],
  [f=>{f.executionQuote.verifiedFutures=false;},/EXECUTION_QUOTE/],
  [f=>{f.executionQuote.fetchedAt=new Date(f.now-16000).toISOString();},/STALE_EXECUTION/],
  [f=>{f.executionQuote.filters.find(x=>x.filterType==='MIN_NOTIONAL').notional='100';},/QUANTITY_LIMIT/],
  [f=>{f.executionQuote.filters=[];},/FILTERS_REQUIRED/],
  [f=>{f.records=['open-long','open-short','open-long','open-short'].map(action=>({action,status:'pending',at:new Date(f.now).toISOString()}));},/ENTRY_RATE/]
 ]){const f=await futureFixture();change(f);assert.throws(()=>assess(f),pattern);}
});

test('short quote drift compares bid and closing matches the existing side despite entry stop',async()=>{
 const f=await futureFixture();f.executionQuote.bid='95';assert.throws(()=>assess(f),/PRICE_MOVED/);
 f.proposal={...f.proposal,action:'close-short',stakeUsdt:'0',leverage:1};f.account.trades=[position(f.proposal.pair)];f.stopped=true;
 f.account.daily.data[0].abs_profit=-100;assert.equal(assess(f).tradeId,7);
 f.proposal.action='close-long';assert.throws(()=>assess(f),/DIRECTION_MISMATCH/);
});

test('native client passes long/short and leverage only to futures entries, all closes use trade ID',async()=>{
 const f=await futureFixture(),calls=[],c={...engineConfig(f.policy),dry_run:false,runmode:'live',demo_trading:true,trading_mode:'futures',margin_mode:'isolated',short_allowed:true};
 const client=new FreqtradeClient(f.policy,{username:'fake',password:'fake'},{fetchImpl:async(u,o)=>{
  calls.push({path:new URL(u).pathname,body:o.body?JSON.parse(o.body):null});return new Response(JSON.stringify(c));
 }});
 for(const action of ['open-long','open-short']){
  await client.submit({...f.proposal,action},'codex-test',null);
  assert.equal(calls.at(-1).body.side,action==='open-short'?'short':'long');assert.equal(calls.at(-1).body.leverage,3);assert.equal(calls.at(-1).body.stakeamount,25);
 }
 for(const action of ['close-long','close-short']){await client.submit({...f.proposal,action,stakeUsdt:'0'},'tag',7);assert.deepEqual(calls.at(-1),{path:'/api/v1/forceexit',body:{tradeid:7,ordertype:'market'}});}
 c.margin_mode='cross';await assert.rejects(client.assertMode(),/IDENTITY_REJECTED/);
 c.margin_mode='isolated';c.demo_trading=false;await assert.rejects(client.assertMode(),/IDENTITY_REJECTED/);
});

test('unknown short entry stays blocked until direction and leverage are proven',async()=>{
 const f=await futureFixture(),dir=await local();let tag;
 f.getDecisionConfig=async()=>({demoEngine:'ai'});
 f.portfolioEntryFn=async(_opts,run)=>run(async()=>({checked:true}));f.protectionCheckFn=async()=>({verified:true});
 f.snapshot.costFacts={mode:'demo-futures',kind:'costs',readOnly:true,source:'https://demo-fapi.binance.com',observedAt:f.snapshot.createdAt,
  rates:[{pair:f.proposal.pair,status:'ok',buyRate:'0.0004',sellRate:'0.0004'}]};
 f.executionQuote.fundingRate='0';
 await assert.rejects(execute({...f,now:()=>f.now,local:dir,getQuote:async()=>f.executionQuote,client:{snapshot:async()=>f.account,submit:async(p,t)=>{tag=t;throw new Error('SIMULATED_TIMEOUT');}}}),/SIMULATED_TIMEOUT/);
 const rows=await journalRead(join(dir,'orders.jsonl'));assert.equal(rows[0].action,'open-short');assert.equal(rows[0].leverage,3);assert.equal(rows.at(-1).status,'unknown');
 const t={...position(f.proposal.pair,false),enter_tag:tag,amount_requested:0.75,amount_precision:0.001,precision_mode:4,
  orders:[{ft_is_entry:true,ft_order_tag:tag,pair:f.proposal.pair,ft_order_side:'sell',order_id:'test-order',
   status:'closed',is_open:false,filled:0.75,amount:0.75,remaining:0,average:100,cost:75}]};
 const client={assertMode:async()=>{},history:async()=>[t]};
 assert.equal((await reconcile(dir,client))[0].status,'unresolved');
 t.is_short=true;t.leverage=2;assert.equal((await reconcile(dir,client))[0].status,'unresolved');
 t.leverage=3;assert.equal((await reconcile(dir,client))[0].status,'reconciled');
});

test('pending close-short reconciles against a buy-side reduce-position order',async()=>{
 const dir=await local(),t=position('BTC/USDT:USDT');t.orders=[{ft_order_side:'buy',is_open:true}];
 await journalAppend(join(dir,'orders.jsonl'),{id:'a'.repeat(32),at:new Date().toISOString(),status:'pending',action:'close-short',tradeId:7,pair:t.pair,stakeUsdt:'0'});
 assert.equal((await reconcile(dir,{assertMode:async()=>{},history:async()=>[t]}))[0].status,'reconciled');
});

function publicMock(url){
 const u=new URL(url),symbol=u.searchParams.get('symbol')??'BTCUSDT',end=Math.floor(Date.now()/300000)*300000;
 let value;
 if(u.pathname.endsWith('/time'))value={serverTime:Date.now()};
 else if(u.pathname.endsWith('exchangeInfo'))value={symbols:['BTC','ETH','SOL','BNB'].map(base=>({symbol:base+'USDT',baseAsset:base,quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',status:'TRADING',filters}))};
 else if(u.pathname.endsWith('bookTicker'))value={symbol,bidPrice:'100',askPrice:'100.01'};
 else if(u.pathname.endsWith('premiumIndex'))value={symbol,markPrice:'100',lastFundingRate:'0.0001',nextFundingTime:end+28800000};
 else value=Array.from({length:96},(_,i)=>[end-(96-i)*300000,'100','102','99','101','10',end-(95-i)*300000-1]);
 return Promise.resolve(new Response(JSON.stringify(value)));
}
test('futures collector verifies all four contracts on the dedicated public Demo route',async()=>{
 const p=await loadPolicy('demo-futures'),urls=[];
 const s=await collect(p,{includeWeb3:false,fetchImpl:u=>{urls.push(u);return publicMock(u);}});
 assert.equal(s.markets.length,4);assert.ok(urls.every(u=>u.startsWith('https://demo-fapi.binance.com/fapi/')));
 assert.equal(s.evidence.filter(e=>e.id.startsWith('futures:')).length,4);assert.ok(s.markets.every(m=>m.verifiedFutures&&!m.verifiedSpot&&m.fundingRate==='0.0001'));
 await assert.rejects(market('BTC/USDT',{mode:'demo-futures',fetchImpl:publicMock}),/INVALID_MARKET_PAIR/);
});

test('futures analyst and dashboard preserve market identity and label leverage',async()=>{
 const f=await futureFixture(),{prompt}=await buildAnalystPrompt(f);
 assert.ok(prompt.includes('open-short'));assert.ok(prompt.includes('"maxLeverage":3'));assert.ok(!prompt.includes('No leverage, shorting'));
 const store=new DashboardStore({fetchImpl:async()=>{throw new Error('Preview must not fetch');}});
 await store.refresh({preview:true,mode:'demo-futures',pair:'SOL/USDT'});assert.equal(store.state.pair,'SOL/USDT:USDT');
 assert.equal(store.state.data.account.positions[1].isShort,true);assert.equal(store.state.data.policy.maxLeverage,3);
 await store.refresh({mode:'demo'});assert.equal(store.state.pair,'SOL/USDT');
 assert.equal(previewData('dry-run','BNB/USDT').data.policy.pairs.length,4);
});

test('requested 50 USDT margin accepts either side at 3x and rejects excess margin',async()=>{
 const f=await futureFixture();assert.equal(f.policy.maxStakeUsdt,'50');assert.equal(f.policy.maxNotionalUsdt,'150');
 for(const action of ['open-long','open-short'])assert.equal(assess({...f,proposal:{...f.proposal,action,stakeUsdt:'50'}}).stakeUsdt,'50');
 assert.throws(()=>assess({...f,proposal:{...f.proposal,stakeUsdt:'50.00000001'}}),/STAKE_LIMIT/);
 f.account.trades=[position()];assert.throws(()=>assess({...f,proposal:{...f.proposal,stakeUsdt:'50'}}),/NOTIONAL|EXPOSURE/);
});
