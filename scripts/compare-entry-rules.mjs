// Offline regression comparison of a frozen v1 dataset and the proposed v2.
// No parameter search, broker client or account credentials.
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile,copyFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/paths.mjs';
import { readJson,writeJson } from '../src/io.mjs';
import { baselineDecision,backtestBaseline,BASELINE_VERSION } from '../src/baseline.mjs';
if(process.argv.length!==3)throw Error('USAGE_COMPARE_ENTRY_RULES_FROZEN_BASELINE_DIRECTORY');
const frozen=resolve(process.argv[2]),input=await readJson(join(frozen,'input.json')),original=await readJson(join(frozen,'result.json'));
const digest=value=>createHash('sha256').update(value).digest('hex');
if(digest(JSON.stringify(input))!==original.inputSha256)throw Error('COMPARISON_INPUT_HASH_MISMATCH');
const output=join(ROOT,'local','entry-comparison',new Date().toISOString().replace(/[:.]/g,'-'));
const legacy=join(output,'v1');await mkdir(legacy,{recursive:true});
for(const name of ['baseline.mjs','entry-quality.mjs','candle-schedule.mjs','mode.mjs','paths.mjs'])await copyFile(join(frozen,name),join(legacy,name));
// The original bundle omitted this transitive dependency. Signal evaluation never calls its I/O functions.
await copyFile(join(ROOT,'src/io.mjs'),join(legacy,'io.mjs'));
const old=await import(pathToFileURL(join(legacy,'baseline.mjs')).href);
if(old.BASELINE_VERSION!=='confirmed-breakout-atr-v1')throw Error('COMPARISON_REQUIRES_FROZEN_V1');
const results=[];
for(const [label,decide] of [[old.BASELINE_VERSION,old.baselineDecision],[BASELINE_VERSION,baselineDecision]]){
 for(const extraSlippage of [0,5]){
  const options={...original.baseline.config,slippageBpsPerSide:original.baseline.config.slippageBpsPerSide+extraSlippage};
  const result=backtestBaseline(input,{...options,decide});
  if(label===old.BASELINE_VERSION&&extraSlippage===0&&(result.trades.length!==original.baseline.trades.length||Math.abs(result.netUsdt-original.baseline.netUsdt)>1e-9))throw Error('COMPARISON_BASELINE_REPRODUCTION_FAILED');
  // Counts use independent historical signal checks, including bars while a position would be held.
  let signals=0;
  if(input.mode!=='demo')throw Error('COMPARISON_SPOT_ONLY_WITHOUT_FUNDING_RECONSTRUCTION');
  const cost={status:'ok',requiredPriceSpaceBps:String((options.buyRate+options.sellRate)*10000+2*options.slippageBpsPerSide+options.priceSpaceBufferBps)};
  for(let i=31;i<input.candles.length;i++)if(decide({candles:input.candles.slice(i-31,i+1),mode:input.mode,pair:input.pair,cost,now:input.candles[i].closeTime+1}).action!=='hold')signals++;
  const summary={signalVersion:label,extraSlippageBpsPerSide:extraSlippage,eligibleBars:signals,trades:result.trades.length,netUsdt:result.netUsdt,sampledMaxDrawdownPct:result.sampledMaxDrawdownPct};
  results.push(summary);await writeJson(join(output,label+'-slip'+extraSlippage+'.json'),{...result,signalVersion:label});
 }
}
await copyFile(join(frozen,'input.json'),join(output,'input.json'));
const sources=[];
for(const name of ['baseline.mjs','entry-quality.mjs','candle-schedule.mjs','mode.mjs','paths.mjs','io.mjs','timeframe.mjs']){
 await copyFile(join(ROOT,'src',name),join(output,name));sources.push({name,sha256:digest(await readFile(join(ROOT,'src',name)))});
}
const report={observedAt:new Date().toISOString(),inputSha256:original.inputSha256,mode:input.mode,pair:input.pair,from:input.candles[0].openTime,to:input.candles.at(-1).closeTime,options:original.baseline.config,results,sources,
 limitations:['Previously inspected 30-day BTC Demo spot sample; no unseen holdout and no claim of future profitability.',
 'Comparison changes entry rule only; uses the same simplified execution model and fixed current fees. Does not model full live ROI/trailing exits.',
 'No futures PnL inference and no portfolio aggregation. Demo is forward validation only.',
 'Legacy module uses original frozen signal dependencies plus current io.mjs to resolve an omitted import; the signal does not execute I/O. Original v1 trade count and net PnL reproduced before comparison.']};
await writeJson(join(output,'comparison.json'),report);console.log(JSON.stringify({output,...report},null,2));
