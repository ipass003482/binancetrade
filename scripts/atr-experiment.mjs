// Reproducible, GET-only historical experiment. No broker or order client.
import { join,resolve } from 'node:path';
import { mkdir,readFile,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/paths.mjs';
import { readJson,writeJson } from '../src/io.mjs';
import { jsonFetch } from '../src/http.mjs';
import { loadPolicy } from '../src/config.mjs';
import { VARIANTS,BAR,validateInput,featureFrame,assertControlParity,simulatePortfolio } from '../src/atr-experiment.mjs';
const [command,argument]=process.argv.slice(2);
if(!['prepare','run'].includes(command)||command==='run'&&!argument)throw Error('USAGE_ATR_EXPERIMENT_PREPARE_OR_RUN_DIRECTORY');
const hash=x=>createHash('sha256').update(x).digest('hex');
const files=['src/atr-experiment.mjs','src/baseline.mjs','src/entry-quality.mjs','src/timeframe.mjs','src/mode.mjs','src/paths.mjs','src/io.mjs','scripts/atr-experiment.mjs'];
const directory=argument?resolve(argument):join(ROOT,'local','atr-experiment',new Date().toISOString().replace(/[:.]/g,'-'));
if(command==='prepare'){
 await mkdir(directory,{recursive:true});
 const costs=await readJson(join(ROOT,'config/costs.json'));
 const plan={createdAt:new Date().toISOString(),schemaVersion:1,variants:VARIANTS,
  from:Date.parse('2026-06-01T00:00:00Z'),split:Date.parse('2026-07-15T00:00:00Z'),to:Date.parse('2026-08-11T00:00:00Z'),
  warmupBars:96,pairs:['BTC','ETH','SOL','BNB'],modes:['demo','demo-futures'],riskBudgetUsdt:1,initialCapital:2000,
  costs,stressExtraSlippageBpsPerSide:5,
  deploymentCriteria:{minimumHoldoutTrades:30,minimumHoldoutProfitFactor:1.1,maximumHoldoutDrawdownPct:5,developmentNetPositive:true,holdoutNetPositive:true,stressHoldoutNetPositive:true,holdoutNetBeatsControl:true},
  methodology:['All variants fixed before outcomes. First segment development; second held back until development outputs saved. No parameter tuning.',
   'Historical holdout precedes the previously inspected August/September BTC sample. It is not prospective trading or a guarantee of independent market regimes.',
   'Four core symbols share 2000 USDT per mode, not 2000 per symbol. Spot universe is a four-symbol subset of the ten live pairs.',
   'Every variant uses 1-USDT planned stop-and-cost risk, current per-order/exposure/position/day caps, 1x leverage. Gaps can exceed planned risk.',
   'Control uses live v3 signals but common risk-based sizing; it is not a reproduction of the old fixed-stake performance.',
   '15m ATR changes stop and target only; the 5m 20-bar breakout, 0.1*5m ATR buffer, volume rule and 4-hour time exit remain fixed.',
   'Only complete UTC-aligned 15m groups, with 15 previous candles for ATR14. No partial candles.',
   'Current sampled Demo fees and spread plus fixed slippage applied historically. Not reconstructed historical costs.',
   'Funding uses exact millisecond event times; intrabar exits conservatively charge funding debits and omit credits. Never round event times.',
   'Next-open fills, stop before target if both touched; no exchange order-book replay, engine ROI/trailing exits, outages or latency simulation.',
   'Daily entry/loss controls use UTC realized cash flows; model constraints approximate live controls and are not full engine parity.',
   'Selection may choose no candidate. Holdout drawdown is close-sampled, so intrabar risk can be worse.'],
  sources:[],configs:{}};
 for(const file of files){plan.sources.push({file,sha256:hash(await readFile(join(ROOT,file)))});await mkdir(join(directory,'source',file.startsWith('src/')?'src':'scripts'),{recursive:true});await copyFile(join(ROOT,file),join(directory,'source',file));}
 for(const mode of plan.modes){
  const policy=await loadPolicy(mode),local=join(ROOT,'local',mode),health=await readJson(join(local,'health.json'));
  const snapshot=await readJson(join(local,'runs',health.snapshotId+'.snapshot.json'));
  const config={initialCapital:plan.initialCapital,riskBudgetUsdt:plan.riskBudgetUsdt,maxStake:Number(policy.maxStakeUsdt),maxExposure:Number(policy.maxExposureUsdt),maxOpenTrades:policy.maxOpenTrades,maxEntriesPerDay:policy.maxEntriesPerDay,maxDailyLoss:Number(policy.maxDailyLossUsdt),slippageBpsPerSide:costs.slippageBpsPerSide,priceSpaceBufferBps:costs.priceSpaceBufferBps,fees:{}};
  const base=mode==='demo'?'https://demo-api.binance.com/api/v3':'https://demo-fapi.binance.com/fapi/v1';
  const info=await jsonFetch(base+'/exchangeInfo'+(mode==='demo'?'?symbols='+encodeURIComponent(JSON.stringify(plan.pairs.map(p=>p+'USDT'))):''));
  for(const name of plan.pairs){
   const pair=name+'/USDT'+(mode==='demo-futures'?':USDT':''),market=snapshot.markets.find(m=>m.pair===pair),cost=market?.entryCost;
   const instrument=info.symbols?.find(s=>s.symbol===name+'USDT');
   if(cost?.status!=='ok'||!instrument||instrument.status!=='TRADING'||instrument.baseAsset!==name||instrument.quoteAsset!=='USDT'||(mode==='demo-futures'?instrument.contractType!=='PERPETUAL':instrument.isSpotTradingAllowed!==true))throw Error('EXPERIMENT_IDENTITY_OR_FEES');
   const filters=instrument.filters,lot=filters.find(f=>f.filterType==='LOT_SIZE'),marketLot=filters.find(f=>f.filterType==='MARKET_LOT_SIZE'),minimum=filters.find(f=>f.filterType==='NOTIONAL'||f.filterType==='MIN_NOTIONAL');
   config.fees[pair]={buyRate:Number(cost.buyRate),sellRate:Number(cost.sellRate),spreadBps:Number(cost.spreadBps),observedAt:cost.observedAt,source:cost.source,
    stepSize:Math.max(Number(lot.stepSize),Number(marketLot?.stepSize??0)),minQty:Math.max(Number(lot.minQty),Number(marketLot?.minQty??0)),minNotional:Number(minimum?.minNotional??minimum?.notional??0)};
  }
  plan.configs[mode]=config;
 }
 await writeJson(join(directory,'plan.json'),plan);
 console.log(JSON.stringify({phase:'registered',directory,from:new Date(plan.from).toISOString(),split:new Date(plan.split).toISOString(),to:new Date(plan.to).toISOString()}));
 const tasks=plan.modes.flatMap(mode=>plan.pairs.map(name=>({mode,name})));
 const manifest=[];
 // Two independent GET download workers; each symbol's pages remain sequential.
 async function worker(){while(tasks.length){const {mode,name}=tasks.shift();
  const pair=name+'/USDT'+(mode==='demo-futures'?':USDT':''),base=mode==='demo'?'https://demo-api.binance.com/api/v3':'https://demo-fapi.binance.com/fapi/v1',start=plan.from-plan.warmupBars*BAR;
  const candles=[];let next=start;
  while(next<plan.to){
   const rows=await jsonFetch(base+'/klines?symbol='+name+'USDT&interval=5m&limit=1000&startTime='+next+'&endTime='+(plan.to-1),{timeoutMs:20000});
   if(!Array.isArray(rows)||!rows.length||rows[0][0]!==next)throw Error('EXPERIMENT_HISTORY_INCOMPLETE_'+mode+'_'+name);
   for(const b of rows){if(b[6]>=plan.to)throw Error('EXPERIMENT_HISTORY_RANGE');candles.push({openTime:b[0],open:b[1],high:b[2],low:b[3],close:b[4],volume:b[5],closeTime:b[6]});}
   const end=rows.at(-1)[0]+BAR;if(end<=next)throw Error('EXPERIMENT_HISTORY_STUCK');next=end;
  }
  const data={schemaVersion:1,timeframe:'5m',mode,pair,source:base,downloadedAt:new Date().toISOString(),candles};
  if(mode==='demo-futures'){
   const events=[];const fundingFrom=start-86400000;let cursor=fundingFrom;
   while(cursor<plan.to){
    const rows=await jsonFetch(base+'/fundingRate?symbol='+name+'USDT&startTime='+cursor+'&endTime='+(plan.to-1)+'&limit=1000');
    if(!Array.isArray(rows))throw Error('EXPERIMENT_FUNDING_RESPONSE');
    for(const e of rows){if(e.symbol!==name+'USDT'||e.fundingTime<cursor||e.fundingTime>=plan.to)throw Error('EXPERIMENT_FUNDING_RANGE');events.push({time:e.fundingTime,rate:e.fundingRate,markPrice:e.markPrice});}
    if(rows.length<1000)break;const after=rows.at(-1).fundingTime+1;if(after<=cursor)throw Error('EXPERIMENT_FUNDING_STUCK');cursor=after;
   }
   data.funding={from:fundingFrom,to:plan.to-1,complete:true,events,source:base+'/fundingRate'};
  }
  validateInput(data,start,plan.to);const file=mode+'-'+name+'.json';await writeJson(join(directory,file),data);
  manifest.push({file,mode,pair,candles:candles.length,fundingEvents:data.funding?.events.length??0,sha256:hash(await readFile(join(directory,file)))});
  console.log(JSON.stringify({phase:'downloaded',mode,pair,candles:candles.length}));
 }}
 await Promise.all([worker(),worker()]);manifest.sort((a,b)=>a.file.localeCompare(b.file));await writeJson(join(directory,'manifest.json'),manifest);
 console.log(JSON.stringify({phase:'ready',directory,datasets:manifest.length}));
}else{
 const plan=await readJson(join(directory,'plan.json')),manifest=await readJson(join(directory,'manifest.json'));
 for(const s of plan.sources)if(hash(await readFile(join(ROOT,s.file)))!==s.sha256)throw Error('EXPERIMENT_SOURCE_CHANGED_'+s.file);
 const data=[];for(const m of manifest){const bytes=await readFile(join(directory,m.file));if(hash(bytes)!==m.sha256)throw Error('EXPERIMENT_INPUT_HASH');data.push(validateInput(JSON.parse(bytes),plan.from-plan.warmupBars*BAR,plan.to));}
 // Decide data-quality exclusions before computing ANY strategy outcome.
 // Demo funding history has occasional outages. Never assume absent events cost zero.
 const fundingGaps=[];
 for(const d of data.filter(d=>d.mode==='demo-futures')){
  const e=d.funding.events;
  for(let i=1;i<e.length;i++)if(e[i].time-e[i-1].time>9*3600000)fundingGaps.push({pair:d.pair,from:e[i-1].time,to:e[i].time});
  if(e.at(-1).time<plan.to-9*3600000)throw Error('EXPERIMENT_FUNDING_END_COVERAGE');
 }
 if(fundingGaps.some(g=>g.to>=plan.split))throw Error('EXPERIMENT_HOLDOUT_FUNDING_GAP');
 const developmentFrom=Math.max(plan.from,...fundingGaps.map(g=>Math.ceil(g.to/86400000)*86400000));
 if(plan.split-developmentFrom<14*86400000)throw Error('EXPERIMENT_DEVELOPMENT_TOO_SHORT_AFTER_DATA_GAP');
 const quality={checkedAt:new Date().toISOString(),fundingGaps,originalDevelopmentFrom:plan.from,developmentFrom,holdoutFrom:plan.split,holdoutTo:plan.to,
  rule:'Before outcomes: after any >9h funding-history gap, begin all modes at the next UTC day. Holdout gaps abort; holdout dates never change.'};
 await writeJson(join(directory,'data-quality.json'),quality);console.log(JSON.stringify({phase:'data-quality',...quality}));
 const allFrames=new Map();let parityChecks=0;
 for(const d of data){
  const key=d.mode+':'+d.pair,frames=[];
  for(let i=Math.max(95,(developmentFrom-d.candles[0].openTime)/BAR-1);i<d.candles.length;i++){
   const rows=d.candles.slice(i-95,i+1),f=featureFrame({candles:rows,mode:d.mode,pair:d.pair,now:rows.at(-1).closeTime+1});frames[i]=f;
   // Independently compare every historical control action and exit geometry.
   assertControlParity(f,rows,50);parityChecks++;
  }
  allFrames.set(key,frames);console.log(JSON.stringify({phase:'features',mode:d.mode,pair:d.pair,frames:frames.length}));
 }
 const summaries=[];
 for(const [segment,from,to] of [['development',developmentFrom,plan.split],['holdout',plan.split,plan.to]]){
  for(const mode of plan.modes){const datasets=data.filter(d=>d.mode===mode),frames=new Map(datasets.map(d=>[d.pair,allFrames.get(mode+':'+d.pair)]));
   for(const variant of plan.variants)for(const extraSlippageBps of [0,plan.stressExtraSlippageBpsPerSide]){
    const r=simulatePortfolio({datasets,frames,variant,config:plan.configs[mode],from,to,extraSlippageBps});
    await writeJson(join(directory,segment+'-'+mode+'-'+variant+'-slip'+extraSlippageBps+'.json'),r);
    const {tradeDetails,curve,...summary}=r;summaries.push({segment,...summary});console.log(JSON.stringify({phase:segment,mode,variant,extraSlippageBps,trades:r.trades,netUsdt:r.netUsdt,drawdown:r.sampledMaxDrawdownPct}));
   }
  }
  await writeJson(join(directory,segment+'-summaries.json'),summaries.filter(r=>r.segment===segment));
 }
 const candidates=[];
 for(const mode of plan.modes)for(const variant of plan.variants.slice(1)){
  const get=(segment,v,slip=0)=>summaries.find(r=>r.mode===mode&&r.variant===v&&r.segment===segment&&r.extraSlippageBps===slip);
  const dev=get('development',variant),hold=get('holdout',variant),stress=get('holdout',variant,5),control=get('holdout','control-5m'),c=plan.deploymentCriteria;
  const failed=[];
  if(dev.netUsdt<=0)failed.push('DEVELOPMENT_NET_NOT_POSITIVE');
  if(hold.trades<c.minimumHoldoutTrades)failed.push('HOLDOUT_SAMPLE_SMALL');
  if(hold.netUsdt<=0)failed.push('HOLDOUT_NET_NOT_POSITIVE');
  if(hold.profitFactor===null||hold.profitFactor<c.minimumHoldoutProfitFactor)failed.push('HOLDOUT_PROFIT_FACTOR_LOW');
  if(hold.sampledMaxDrawdownPct>c.maximumHoldoutDrawdownPct)failed.push('HOLDOUT_DRAWDOWN_HIGH');
  if(stress.netUsdt<=0)failed.push('STRESS_HOLDOUT_NET_NOT_POSITIVE');
  if(hold.netUsdt<=control.netUsdt)failed.push('HOLDOUT_DID_NOT_BEAT_CONTROL');
  candidates.push({mode,variant,passed:!failed.length,failed});
 }
 await writeJson(join(directory,'summary.json'),{asOf:new Date().toISOString(),directory,plan,quality,parityChecks,summaries,candidates,realOrders:0});
 console.log(JSON.stringify({phase:'complete',directory,parityChecks,candidates,realOrders:0}));
}
