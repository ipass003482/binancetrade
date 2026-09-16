import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson,writeJson } from '../src/io.mjs';
import { ROOT } from '../src/paths.mjs';
import { compareExits,validateBars } from '../src/exit-replay.mjs';
// Input is a previously captured read-only Demo history; no credentials accepted.
const [input,...args]=process.argv.slice(2);
if(!input||args.some(a=>!/^--exclude-trade=\d+$/.test(a)))throw Error('Usage: compare-exits.mjs history.json [--exclude-trade=1]');
const excluded=new Set(args.map(a=>Number(a.split('=')[1]))),history=await readJson(resolve(input));
if(history.mode!=='demo'||!Array.isArray(history.trades)||!Number.isFinite(Date.parse(history.observedAt)))throw Error('DEMO_HISTORY_REQUIRED');
const now=Date.now(),datasets={},eligible=[],skipped=[];
const run=join(ROOT,'local','exit-replay',new Date(now).toISOString().replace(/[:.]/g,'-'));
for(const t of history.trades){
 const skip=reason=>skipped.push({tradeId:t.trade_id,reason});
 if(excluded.has(t.trade_id)){skip('explicitly_excluded');continue;}
 if(!['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT'].includes(t.pair)||t.is_short!==false||t.trading_mode!=='spot'||
  t.nr_of_successful_entries!==1||(t.nr_of_successful_exits??0)>1){skip('unsupported_position_shape');continue;}
 if(!Number.isFinite(t.open_timestamp)||t.open_timestamp+360*60000>Math.min(now,Date.parse(history.observedAt))){skip('six_hour_window_not_observed');continue;}
 const start=Math.ceil(t.open_timestamp/60000)*60000,end=Math.floor((t.open_timestamp+360*60000)/60000)*60000;
 const url=new URL('https://demo-api.binance.com/api/v3/klines');
 for(const [k,v] of Object.entries({symbol:t.pair.replace('/',''),interval:'1m',startTime:start,endTime:end-1,limit:1000}))url.searchParams.set(k,v);
 try{
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('PUBLIC_KLINES_HTTP_'+response.status);
  const raw=await response.json();
  if(!Array.isArray(raw))throw Error('PUBLIC_KLINES_SHAPE');
  const bars=raw.map(r=>({time:r[0],open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}));
  validateBars(bars,start,end);datasets[t.trade_id]=bars;eligible.push(t);
  await writeJson(join(run,'bars-'+t.trade_id+'.json'),{url:String(url),fetchedAt:new Date().toISOString(),
   sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),raw});
 }catch(e){skip(String(e.message).slice(0,100));}
}
const report={generatedAt:new Date().toISOString(),historyObservedAt:history.observedAt,mode:'demo',ordersSubmitted:0,
 method:'Actual-entry-conditioned 6h exit sensitivity; NOT a portfolio backtest or exact Freqtrade reproduction',
 assumptions:[
  'Uses historical entries, sizes and reported fee rates. Normalized quantity=stake/open_rate; no partial entries or scale-outs.',
  'Both entry and exit fees included; no claim to reproduce base-asset fees, dust or original commissions exactly.',
  'Starts with first complete minute after entry; the initial partial minute is unobserved and excluded.',
  'Uses two hypothetical intraminute OHLC paths. Their range is NOT a guaranteed bound over every possible price path.',
  'Entry times fixed; changed exits do not regenerate AI decisions or reallocate freed capital. Sum of trade PnL is not portfolio return.',
  'ROI targets 3% then 1.5% at 120m; 2% gross initial stop. Trailing activates above 0.8% estimated net and trails 0.4%.',
  'Final horizon is marked at last completed candle, up to one minute before six hours; horizon_mark is not a strategy exit.',
  'Exit slippage scenarios 0/5/10 bps. No spread, latency, order-book liquidity, outages or intraminute trigger-time guarantee.',
  'Small, retrospective development sample; no out-of-sample evidence and no automatic parameter deployment.'
 ],eligibleTradeIds:eligible.map(t=>t.trade_id),skipped,...compareExits(eligible,datasets)};
await writeJson(join(run,'input-history.json'),history);
await writeJson(join(run,'comparison.json'),report);
console.log(JSON.stringify({file:join(run,'comparison.json'),eligible:report.eligibleTradeIds,skipped,summary:report.summary}));
if(!eligible.length)process.exitCode=2;
