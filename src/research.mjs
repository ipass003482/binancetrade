import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Decimal from 'decimal.js';
import { RESEARCH } from './paths.mjs';
import { jsonFetch } from './http.mjs';
import { loadResearchProfile,technicalSummary,compactEvidence } from './research-profile.mjs';
import { safeError } from './health.mjs';
import { MODES,isFutures } from './mode.mjs';
import { readExchangeClock } from './exchange-clock.mjs';
import { clockBoundary,clockDecisionBoundary,FLOW_DECISION_CADENCE_VERSION,FLOW_DECISION_INTERVAL_MS } from './entry-timing.mjs';
import { timeframeSpec,tradingTimeframe } from './timeframe.mjs';
import {readOrderFlow} from './order-flow-collector.mjs';
const PUBLIC='https://data-api.binance.vision';
// Kev entry observations intentionally have no candle or technical-indicator
// dependency. Native risk and execution still validate the Demo instrument,
// quote, clock and the separately sampled raw order-flow proof.
export async function marketOrderFlow(pair,{fetchImpl=fetch,mode='demo',clock,readOrderFlowFn=readOrderFlow}={}) {
 if(!['demo','demo-futures'].includes(mode))throw new Error('FLOW_DEMO_ONLY');
 const futures=isFutures(mode),base=futures?'https://demo-fapi.binance.com':'https://demo-api.binance.com';
 const prefix=futures?'/fapi/v1':'/api/v3';
 if(!(futures?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(pair))throw new Error('INVALID_MARKET_PAIR');
 clock=clock??await readExchangeClock(mode,{fetchImpl});
 const symbol=pair.split(':')[0].replace('/',''),query='?symbol='+symbol;
 let quoteFetchedAt;
 const [info,book,funding,orderFlow]=await Promise.all([
  jsonFetch(base+prefix+'/exchangeInfo'+(futures?'':query),{fetchImpl}),
  jsonFetch(base+prefix+'/ticker/bookTicker'+query,{fetchImpl}).then(value=>{quoteFetchedAt=new Date().toISOString();return value;}),
  futures?jsonFetch(base+prefix+'/premiumIndex'+query,{fetchImpl}):null,
  readOrderFlowFn(mode,pair)
 ]);
 const instrument=info.symbols?.find(s=>s.symbol===symbol);
 if(!instrument||instrument.status!=='TRADING'||instrument.baseAsset+'/'+instrument.quoteAsset!==pair.split(':')[0]||
  (futures?(instrument.contractType!=='PERPETUAL'||instrument.marginAsset!=='USDT'):instrument.isSpotTradingAllowed!==true))
  throw new Error(futures?'NOT_A_VERIFIED_USDT_PERPETUAL':'NOT_A_VERIFIED_SPOT_PAIR');
 if(book.symbol!==symbol)throw new Error('QUOTE_SYMBOL_MISMATCH');
 const bid=new Decimal(book.bidPrice),ask=new Decimal(book.askPrice);
 if(!bid.isFinite()||!ask.isFinite()||bid.lte(0)||ask.lt(bid))throw new Error('Invalid quote');
 if(futures&&(funding.symbol!==symbol||typeof funding.lastFundingRate!=='string'||funding.lastFundingRate.trim()===''||
  !Number.isFinite(Number(funding.lastFundingRate))||!Number.isFinite(Number(funding.markPrice))||!(Number(funding.markPrice)>0)))
  throw new Error('INVALID_FUNDING_MARK');
 return {pair,orderFlow,filters:instrument.filters,
  ...(futures?{verifiedFutures:true,contractType:'PERPETUAL',marginAsset:'USDT',markPrice:funding.markPrice,
   fundingRate:funding.lastFundingRate,nextFundingTime:funding.nextFundingTime}:{verifiedSpot:true}),
  bid:bid.toFixed(),ask:ask.toFixed(),spreadBps:ask.minus(bid).div(bid).mul(10000).toNumber(),
  source:base,mode,timeframe:'order-flow',clock,fetchedAt:quoteFetchedAt,quoteAsOf:null,
  note:'Public REST quote has no exchange event timestamp; fetchedAt is retrieval time.'};
}
export async function collectOrderFlow(policy,{fetchImpl=fetch,readOrderFlowFn=readOrderFlow}={}) {
 if(!['demo','demo-futures'].includes(policy.mode))throw new Error('FLOW_DEMO_ONLY');
 const clock=await readExchangeClock(policy.mode,{fetchImpl}),createdAt=new Date().toISOString();
 const snapshot={id:randomUUID(),entryPolicyVersion:'kev-order-flow-v1',timeframe:'order-flow',createdAt,clock,
  decisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,decisionIntervalMs:FLOW_DECISION_INTERVAL_MS,
  decisionBoundary:clockDecisionBoundary(clock,policy.mode,Date.parse(createdAt)),mode:policy.mode,
  markets:[],evidence:[],errors:[],researchCoverage:[]};
 snapshot.markets=await Promise.all(policy.pairs.map(pair=>marketOrderFlow(pair,{fetchImpl,mode:policy.mode,clock,readOrderFlowFn})));
 snapshot.evidence=snapshot.markets.map(m=>({id:(isFutures(policy.mode)?'futures:':'spot:')+m.pair,
  status:'ok',source:m.source,fetchedAt:m.fetchedAt,data:m})).sort((a,b)=>a.id.localeCompare(b.id));
 snapshot.completedAt=new Date().toISOString();
 return snapshot;
}
export async function market(pair,{fetchImpl=fetch,mode='dry-run',clock,candleBoundary}={}) {
 if(!MODES.includes(mode))throw new Error('MARKET_MODE_REJECTED');
 const spec=timeframeSpec(tradingTimeframe(mode));
 const futures=isFutures(mode),base=futures?'https://demo-fapi.binance.com':mode==='demo'?'https://demo-api.binance.com':PUBLIC;
 const prefix=futures?'/fapi/v1':'/api/v3';
 let quoteFetchedAt;
 if(!(futures?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(pair)) throw new Error('INVALID_MARKET_PAIR');
 clock=clock??await readExchangeClock(mode,{fetchImpl});
 candleBoundary=candleBoundary??clockBoundary(clock,mode);
 const symbol=pair.split(':')[0].replace('/',''), query='?symbol='+symbol;
 const [info,book,bars]=await Promise.all([
  jsonFetch(base+prefix+'/exchangeInfo'+(futures?'':query),{fetchImpl}),
  jsonFetch(base+prefix+'/ticker/bookTicker'+query,{fetchImpl}).then(value=>{quoteFetchedAt=new Date().toISOString();return value;}),
  jsonFetch(base+prefix+'/klines'+query+'&interval='+spec.timeframe+'&limit='+(spec.historyBars+1),{fetchImpl})
 ]);
 const instrument=info.symbols?.find(s=>s.symbol===symbol);
 if(!instrument || instrument.status!=='TRADING' || instrument.baseAsset+'/'+instrument.quoteAsset!==pair.split(':')[0]
    || (futures?(instrument.contractType!=='PERPETUAL'||instrument.marginAsset!=='USDT'):instrument.isSpotTradingAllowed!==true))
    throw new Error(futures?'NOT_A_VERIFIED_USDT_PERPETUAL':'NOT_A_VERIFIED_SPOT_PAIR');
 if(book.symbol!==symbol)throw new Error('QUOTE_SYMBOL_MISMATCH');
 const bid=new Decimal(book.bidPrice), ask=new Decimal(book.askPrice);
 if(!bid.isFinite() || !ask.isFinite() || bid.lte(0) || ask.lt(bid)) throw new Error('Invalid quote');
 const now=Date.now();
 const closed=bars.filter(b=>Array.isArray(b) && b[6]<candleBoundary).slice(-spec.historyBars);
 if(closed.length<spec.historyBars || now-closed.at(-1)[6]>2*spec.ms) throw new Error('Insufficient or stale candles');
 const funding=futures?await jsonFetch(base+prefix+'/premiumIndex'+query,{fetchImpl}):null;
 if(futures&&(funding.symbol!==symbol||typeof funding.lastFundingRate!=='string'||funding.lastFundingRate.trim()===''||!Number.isFinite(Number(funding.lastFundingRate))||!Number.isFinite(Number(funding.markPrice))||!(Number(funding.markPrice)>0)))throw new Error('INVALID_FUNDING_MARK');
 const orderFlow=mode==='dry-run'?null:await readOrderFlow(mode,pair);
 return {pair,orderFlow,filters:instrument.filters,...(futures?{verifiedFutures:true,contractType:'PERPETUAL',marginAsset:'USDT',markPrice:funding.markPrice,fundingRate:funding.lastFundingRate,nextFundingTime:funding.nextFundingTime}:{verifiedSpot:true}),bid:bid.toFixed(),ask:ask.toFixed(),
  spreadBps:ask.minus(bid).div(bid).mul(10000).toNumber(),
  candles:closed.map(b=>({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4],volume:b[5],closeTime:b[6]})),
  source:base,mode,timeframe:spec.timeframe,clock,candleBoundary,fetchedAt:quoteFetchedAt,quoteAsOf:null,
  note:'Public REST quote has no exchange event timestamp; fetchedAt is retrieval time.'};
}
export async function web3(skill,command,params,{fetchImpl=fetch}={}) {
 const known={
  'query-token-info':['search','meta','dynamic','kline'],
  'crypto-market-rank':['social-hype','token-rank','smart-money-inflow','meme-rank','address-pnl-rank'],
  'query-address-info':['positions'],'query-token-audit':['audit']
 };
 if(!known[skill]?.includes(command)) throw new Error('Unsupported research command');
 if(!params || typeof params!=='object' || Array.isArray(params)) throw new Error('Parameters must be an object');
 let request;
 if(skill==='query-token-audit') {
  if(!['1','56','8453','CT_501'].includes(params.binanceChainId)) throw new Error('Unsupported audit chain');
  if(!/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(params.contractAddress??'')) throw new Error('Invalid contract');
  request={url:'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit',method:'POST',
   body:{binanceChainId:params.binanceChainId,contractAddress:params.contractAddress,requestId:randomUUID()}};
 } else {
  const mod=await import(pathToFileURL(join(RESEARCH,'.agents/skills',skill,'scripts/cli.mjs')).href);
  if(!Object.hasOwn(mod.COMMANDS,command)) throw new Error('Unknown command');
  if(skill==='query-address-info' && (!Number.isInteger(params.offset)||params.offset<0)) throw new Error('offset must be a nonnegative integer');
  request=mod.COMMANDS[command](params);
 }
 const url=new URL(request.url);
 if(url.protocol!=='https:' || !['web3.binance.com','dquery.sintral.io'].includes(url.hostname)) throw new Error('Unreviewed endpoint');
 const data=await jsonFetch(url,{...request,fetchImpl,headers:{...request.headers,
  'User-Agent':'binance-web3/2.0 (Skill)','Accept-Encoding':'identity',source:'agent'}});
 const unavailable=skill==='query-token-audit' && (data.data?.hasResult!==true || data.data?.isSupported!==true);
 return {id:randomUUID(),skill,command,source:url.origin+url.pathname,fetchedAt:new Date().toISOString(),
  status:unavailable?'unavailable':'ok',
  data:unavailable?{hasResult:false,isSupported:data.data?.isSupported===true,note:'Audit unavailable; not a low-risk result'}:data};
}
export async function collect(policy,{fetchImpl=fetch,includeWeb3=true,profile,queryWeb3=web3}={}) {
 const clock=await readExchangeClock(policy.mode,{fetchImpl}),createdAt=new Date().toISOString();
 const candleBoundary=clockBoundary(clock,policy.mode,Date.parse(createdAt));
 const decision=policy.mode==='dry-run'?{}:{decisionCadenceVersion:FLOW_DECISION_CADENCE_VERSION,
  decisionIntervalMs:FLOW_DECISION_INTERVAL_MS,decisionBoundary:clockDecisionBoundary(clock,policy.mode,Date.parse(createdAt))};
 const snapshot={id:randomUUID(),timeframe:tradingTimeframe(policy.mode),createdAt,clock,candleBoundary,...decision,mode:policy.mode,markets:[],evidence:[],errors:[],researchCoverage:[]};
 snapshot.markets=await Promise.all(policy.pairs.map(pair=>market(pair,{fetchImpl,mode:policy.mode,clock,candleBoundary})));
 for(const m of snapshot.markets){
  const technical=technicalSummary(m.candles,m.timeframe);
  snapshot.evidence.push({id:(isFutures(policy.mode)?'futures:':'spot:')+m.pair,status:'ok',source:m.source,fetchedAt:m.fetchedAt,data:m});
  snapshot.evidence.push({id:'technical:'+m.pair,pair:m.pair,status:'ok',source:m.source,
   fetchedAt:m.fetchedAt,data:technical});
 }
 if(includeWeb3){
  profile=profile??await loadResearchProfile();
  const jobs=[];
  function add(id,pair,skill,command,params,relationship){
   jobs.push(async()=>{
    try{
     const result=await queryWeb3(skill,command,params,{fetchImpl});
     snapshot.evidence.push({...result,id,pair,relationship,data:compactEvidence(result.data),
      bounded:true,note:'Arrays and long fields may be truncated; this is not an exhaustive dataset.'});
    }catch(e){
     const code=safeError(e);snapshot.errors.push({source:skill,pair,code});
     snapshot.evidence.push({id,pair,status:'unavailable',relationship,data:{reason:code}});
    }
   });
  }
  add('web3:market-context',null,'crypto-market-rank','token-rank',{rankType:10,chainId:'56',page:1,size:5},'BSC context; not BTC/ETH spot identity');
  for(const pair of policy.pairs){
   const selected=profile.pairs[pair]??{chainTokens:[],wallets:[]};
   snapshot.researchCoverage.push({pair,chainMappings:selected.chainTokens.length,wallets:selected.wallets.length,
    note:selected.chainTokens.length?'Explicit operator mappings; proxies are labelled.':'No verified chain token mapping. Audit and token dynamics are not inferred from ticker names.'});
   add('web3:search:'+pair,pair,'query-token-info','search',{keyword:pair.split('/')[0]},'unverified search candidates; not evidence of spot identity');
   selected.chainTokens.forEach((token,i)=>{
    const params={chainId:token.chainId,contractAddress:token.contractAddress};
    const relationship={kind:token.relationship,source:token.source,note:token.note,...params};
    for(const command of ['meta','dynamic'])add('web3:'+pair+':'+i+':'+command,pair,'query-token-info',command,params,relationship);
    add('web3:'+pair+':'+i+':audit',pair,'query-token-audit','audit',
     {binanceChainId:token.chainId,contractAddress:token.contractAddress},relationship);
   });
   selected.wallets.forEach((wallet,i)=>add('web3:'+pair+':wallet:'+i,pair,'query-address-info','positions',
    {chainId:wallet.chainId,address:wallet.address,offset:0},
    {label:wallet.label,note:'Watchlisted public wallet; first page only, no attribution to the trader.'}));
  }
  // Bound external concurrency, preserve individual failure evidence.
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,jobs.length)},async()=>{while(next<jobs.length){const job=jobs[next++];await job();}}));
 }
 snapshot.evidence.sort((a,b)=>a.id.localeCompare(b.id));
 snapshot.completedAt=new Date().toISOString();
 return snapshot;
}
