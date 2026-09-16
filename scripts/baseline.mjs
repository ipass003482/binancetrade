// Usage: node scripts/baseline.mjs download|run --mode demo|demo-futures --pair BTC/USDT --days 30
// run requires --input dataset.json; outputs reproducible research only, never orders.
import { join,resolve } from 'node:path';
import { readFile,copyFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { timeframeSpec,tradingTimeframe } from '../src/timeframe.mjs';
import { ROOT } from '../src/paths.mjs';
import { loadPolicy } from '../src/config.mjs';
import { readJson,writeJson } from '../src/io.mjs';
import { jsonFetch } from '../src/http.mjs';
import { readExchangeClock,clockRange } from '../src/exchange-clock.mjs';
import { collectCosts,loadCosts } from '../src/trading-costs.mjs';
import { backtestBaseline,validateDataset } from '../src/baseline.mjs';
const [command,...args]=process.argv.slice(2),opts={};
if(!['download','run'].includes(command)||args.length%2)throw Error('BASELINE_ARGUMENTS');
for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--mode','--pair','--days','--input'].includes(key)||key in opts)throw Error('BASELINE_ARGUMENTS');opts[key]=args[i+1];}
const mode=opts['--mode']??'demo';if(!['demo','demo-futures'].includes(mode))throw Error('BASELINE_MODE');
const spec=timeframeSpec(tradingTimeframe(mode));
const policy=await loadPolicy(mode),pair=opts['--pair']??policy.pairs[0];if(!policy.pairs.includes(pair))throw Error('BASELINE_PAIR');
const directory=join(ROOT,'local',mode,'baselines',new Date().toISOString().replace(/[:.]/g,'-'));
let dataset;
if(command==='download'){
 const days=Number(opts['--days']??30);if(!Number.isInteger(days)||days<1||days>365)throw Error('BASELINE_DAYS');
 const clock=await readExchangeClock(mode),range=clockRange(clock,mode),end=Math.floor(range.lower/spec.ms)*spec.ms-1,start=end+1-days*86400000;
 const base=mode==='demo'?'https://demo-api.binance.com/api/v3':'https://demo-fapi.binance.com/fapi/v1',symbol=pair.split(':')[0].replace('/','');
 const info=await jsonFetch(base+'/exchangeInfo'+(mode==='demo'?'?symbol='+symbol:''));
 const instrument=info.symbols?.find(s=>s.symbol===symbol);
 if(!instrument||instrument.status!=='TRADING'||instrument.baseAsset+'/'+instrument.quoteAsset!==pair.split(':')[0]||(mode==='demo-futures'?instrument.contractType!=='PERPETUAL':instrument.isSpotTradingAllowed!==true))throw Error('BASELINE_MARKET_IDENTITY');
 const candles=[];let next=start;
 while(next<=end){
  const rows=await jsonFetch(base+'/klines?symbol='+symbol+'&interval='+spec.timeframe+'&limit=1000&startTime='+next+'&endTime='+end);
  if(!Array.isArray(rows)||!rows.length)throw Error('BASELINE_HISTORY_INCOMPLETE');
  for(const b of rows){if(b[0]<next||b[6]>end)throw Error('BASELINE_HISTORY_RANGE');candles.push({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4],volume:b[5],closeTime:b[6]});}
  const last=rows.at(-1)[0]+spec.ms;if(last<=next)throw Error('BASELINE_HISTORY_STUCK');next=last;
 }
 dataset={schemaVersion:1,timeframe:spec.timeframe,mode,pair,source:base,downloadedAt:new Date().toISOString(),requestedFrom:start,requestedTo:end,candles};
 if(candles[0].openTime!==start||candles.at(-1).closeTime!==end)throw Error('BASELINE_HISTORY_INCOMPLETE');
 if(mode==='demo-futures'){
  const events=[];let cursor=start;
  while(cursor<=end){
   const rows=await jsonFetch(base+'/fundingRate?symbol='+symbol+'&startTime='+cursor+'&endTime='+end+'&limit=1000');
   if(!Array.isArray(rows))throw Error('BASELINE_FUNDING_INVALID');
   for(const e of rows){if(e.symbol!==symbol||e.fundingTime<cursor||e.fundingTime>end)throw Error('BASELINE_FUNDING_INVALID');events.push({time:e.fundingTime,rate:e.fundingRate,markPrice:e.markPrice});}
   if(rows.length<1000)break;
   const next=rows.at(-1).fundingTime+1;if(next<=cursor)throw Error('BASELINE_FUNDING_STUCK');cursor=next;
  }
  // Empty history is not proof of zero funding in Demo.
  if(!events.length)throw Error('BASELINE_FUNDING_UNAVAILABLE');
  dataset.funding={from:start,to:end,complete:true,events,source:base+'/fundingRate'};
 }
 validateDataset(dataset);
}else{
 if(!opts['--input'])throw Error('BASELINE_INPUT_REQUIRED');dataset=await readJson(resolve(opts['--input']));
 if(dataset.mode!==mode||dataset.pair!==pair)throw Error('BASELINE_DATA_IDENTITY');validateDataset(dataset);
}
const facts=await collectCosts(policy),rates=facts.rates?.filter(r=>r.pair===pair&&r.status==='ok');
if(rates?.length!==1)throw Error('BASELINE_FEES_REQUIRED');
const fees=rates[0],config=await loadCosts(),options={initialCapital:2000,stakeUsdt:Number(policy.maxStakeUsdt),buyRate:Number(fees.buyRate),sellRate:Number(fees.sellRate),slippageBpsPerSide:config.slippageBpsPerSide,priceSpaceBufferBps:config.priceSpaceBufferBps};
const baseline=backtestBaseline(dataset,options),stress=backtestBaseline(dataset,{...options,slippageBpsPerSide:options.slippageBpsPerSide+5});
const bytes=JSON.stringify(dataset),sha256=createHash('sha256').update(bytes).digest('hex');
await writeJson(join(directory,'input.json'),dataset);await writeJson(join(directory,'fees.json'),facts);
await writeJson(join(directory,'result.json'),{baseline,stress,inputSha256:sha256,feesAssumption:'Current Demo signed fees applied to historical simulation, not historical fee reconstruction.'});
for(const file of ['baseline.mjs','entry-quality.mjs','candle-schedule.mjs','mode.mjs','paths.mjs','io.mjs','timeframe.mjs'])await copyFile(join(ROOT,'src',file),join(directory,file));
await writeFile(join(directory,'report.md'),[
 '# 固定規則歷史基準','',`模式 ${mode}；商品 ${pair}；資料 ${dataset.source??'input supplied'}`,
 '',`起訖：${new Date(baseline.from).toISOString()} 至 ${new Date(baseline.to).toISOString()}`,
 '',`模擬本金 ${options.initialCapital} USDT；固定每單 ${options.stakeUsdt} USDT；1 倍。`,
 '',`已平倉 ${baseline.trades.length}；模擬淨損益 ${baseline.netUsdt.toFixed(6)} USDT；收盤採樣最大回撤 ${baseline.sampledMaxDrawdownPct.toFixed(4)}%。`,
 `多單：${baseline.long.trades} 筆，${baseline.long.netUsdt.toFixed(6)} USDT；空單：${baseline.short.trades} 筆，${baseline.short.netUsdt.toFixed(6)} USDT。`,
 `每側額外 5 bps 滑點情境：${stress.netUsdt.toFixed(6)} USDT（重跑選單條件，成交筆數可能不同）。`,
 '', '使用目前 Demo 費率作歷史假設，未重建過去帳戶費率。這是獨立固定規則模擬，保留既有引擎 ROI／追蹤退出的實際 Demo 可能不同。',
 '不是 AI 策略回測、不是實盤、不是已驗證樣本外。資金規模和收益只屬研究假設。',
 '',...baseline.limitations.map(s=>'- '+s),'',`輸入 SHA-256：${sha256}`,''].join('\n'));
console.log(JSON.stringify({directory,trades:baseline.trades.length,netUsdt:baseline.netUsdt,simulation:true,realOrders:0},null,2));
