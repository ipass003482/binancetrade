import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Decimal from 'decimal.js';
import { jsonFetch } from './http.mjs';
import { loadPolicy } from './config.mjs';
import { analyze } from './codex.mjs';
import { loadCosts } from './trading-costs.mjs';
import { LOCAL } from './paths.mjs';
import { safeError } from './health.mjs';
import { writeJson } from './io.mjs';
import { buildHighFrequencyStrategyPlan,loadHighFrequencyStrategy } from './high-frequency-strategy.mjs';
import { highFrequencyProposalSchema } from './config.mjs';

const PUBLIC='https://data-api.binance.vision';
const DEFAULT_PAIRS=['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT'];
const topNumber=(value,code)=>{const n=Number(value);if(!Number.isFinite(n))throw new Error(code);return n;};
const symbolOf=pair=>pair.replace('/','');
const quoteValue=(price,quantity)=>new Decimal(price).mul(quantity).toNumber();
const sumLevels=levels=>levels.reduce((sum,[price,quantity])=>sum+quoteValue(price,quantity),0);
const returnBps=(last,previous)=>previous>0&&last>0?(last/previous-1)*10000:null;

function marketFeatures(pair,book,depth,trades,bars,observedAt,costs){
 const symbol=symbolOf(pair);
 if(book.symbol!==symbol||!Array.isArray(depth.bids)||!Array.isArray(depth.asks)||
  !Array.isArray(trades)||!Array.isArray(bars)||depth.bids.length<5||depth.asks.length<5||trades.length<3||bars.length<8)
  throw new Error('HIGH_FREQUENCY_MARKET_DATA_INCOMPLETE');
 const bid=topNumber(book.bidPrice,'HIGH_FREQUENCY_BID_INVALID'),ask=topNumber(book.askPrice,'HIGH_FREQUENCY_ASK_INVALID');
 if(bid<=0||ask<bid)throw new Error('HIGH_FREQUENCY_QUOTE_INVALID');
 const bids=depth.bids.slice(0,5).map(([price,quantity])=>[topNumber(price,'HIGH_FREQUENCY_DEPTH_INVALID'),topNumber(quantity,'HIGH_FREQUENCY_DEPTH_INVALID')]);
 const asks=depth.asks.slice(0,5).map(([price,quantity])=>[topNumber(price,'HIGH_FREQUENCY_DEPTH_INVALID'),topNumber(quantity,'HIGH_FREQUENCY_DEPTH_INVALID')]);
 const bidDepth=sumLevels(bids),askDepth=sumLevels(asks),depthTotal=bidDepth+askDepth;
 const parsedTrades=trades.map(t=>({price:topNumber(t.p,'HIGH_FREQUENCY_TRADE_INVALID'),quantity:topNumber(t.q,'HIGH_FREQUENCY_TRADE_INVALID'),time:topNumber(t.T,'HIGH_FREQUENCY_TRADE_INVALID'),buyerTaker:t.m!==true}));
 const buyQuote=parsedTrades.filter(t=>t.buyerTaker).reduce((sum,t)=>sum+quoteValue(t.price,t.quantity),0);
 const sellQuote=parsedTrades.filter(t=>!t.buyerTaker).reduce((sum,t)=>sum+quoteValue(t.price,t.quantity),0);
 const totalFlow=buyQuote+sellQuote;
 const closedBars=bars.slice(0,-1).map(row=>({openTime:topNumber(row[0],'HIGH_FREQUENCY_BAR_INVALID'),close:topNumber(row[4],'HIGH_FREQUENCY_BAR_INVALID'),volume:topNumber(row[5],'HIGH_FREQUENCY_BAR_INVALID')}));
 const closes=closedBars.map(row=>row.close),lastClose=closes.at(-1),previous=steps=>closes.length>steps?closes.at(-1-steps):null;
 const barReturns=closes.slice(1).map((close,index)=>returnBps(close,closes[index])).filter(value=>value!==null);
 const volatility1mBps=barReturns.length?barReturns.reduce((sum,value)=>sum+Math.abs(value),0)/barReturns.length:null;
 const spreadBps=(ask-bid)/bid*10000,estimatedRoundTripCostBps=spreadBps+(costs.slippageBpsPerSide*2);
 return {pair,mode:'dry-run',source:PUBLIC,observedAt,dataStatus:'ok',
  quote:{bid,ask,mid:(bid+ask)/2,spreadBps},
  orderBook:{lastUpdateId:depth.lastUpdateId??null,top5:{bids,asks},bidDepthQuote:bidDepth,askDepthQuote:askDepth,
   imbalanceTop5:depthTotal>0?(bidDepth-askDepth)/depthTotal:null},
  takerFlow:{tradeCount:parsedTrades.length,buyQuote,sellQuote,buyShare:totalFlow>0?buyQuote/totalFlow:null,
   firstTradeAt:new Date(parsedTrades[0].time).toISOString(),lastTradeAt:new Date(parsedTrades.at(-1).time).toISOString(),
   tradeReturnBps:returnBps(parsedTrades.at(-1).price,parsedTrades[0].price)},
  microMomentum:{return1mBps:returnBps(lastClose,previous(1)),return5mBps:returnBps(lastClose,previous(5)),
   return15mBps:returnBps(lastClose,previous(15)),volatility1mBps,maxBarMoveBps:barReturns.length?Math.max(...barReturns.map(value=>Math.abs(value))):null,
   lastClosed1m:lastClose,closedBarCount:closedBars.length},
  cost:{status:'scenario_only',feeStatus:'unavailable',slippageBpsPerSide:costs.slippageBpsPerSide,
   spreadBps,estimatedRoundTripCostBps,requiredPriceSpaceBps:estimatedRoundTripCostBps+costs.priceSpaceBufferBps,
   note:'Research-only cost scenario; account commission was not read.'}};
}

async function oneMarket(pair,{fetchImpl,observedAt,costs}){
 const symbol=symbolOf(pair),query='?symbol='+symbol;
 const [book,depth,trades,bars]=await Promise.all([
  jsonFetch(PUBLIC+'/api/v3/ticker/bookTicker'+query,{fetchImpl}),
  jsonFetch(PUBLIC+'/api/v3/depth'+query+'&limit=20',{fetchImpl}),
  jsonFetch(PUBLIC+'/api/v3/aggTrades'+query+'&limit=100',{fetchImpl}),
  jsonFetch(PUBLIC+'/api/v3/klines'+query+'&interval=1m&limit=30',{fetchImpl})
 ]);
 return marketFeatures(pair,book,depth,trades,bars,observedAt,costs);
}

export async function collectHighFrequencySnapshot(options={}){
 const {pairs=DEFAULT_PAIRS,fetchImpl=fetch,now=Date.now()}=options;
 const costs=options.costs??await loadCosts();
 if(!Array.isArray(pairs)||pairs.length<1||pairs.some(pair=>!/^[A-Z0-9]+\/USDT$/.test(pair)))throw new Error('HIGH_FREQUENCY_PAIRS_INVALID');
 const createdAt=new Date(now).toISOString(),snapshot={id:randomUUID(),mode:'dry-run',timeframe:'1m',createdAt,
  purpose:'ai-high-frequency-v1',horizonSeconds:[15,60],markets:[],evidence:[],errors:[],researchCoverage:[]};
 const results=await Promise.all(pairs.map(async pair=>{
  try{return {pair,market:await oneMarket(pair,{fetchImpl,observedAt:createdAt,costs})};}
  catch(error){return {pair,error:safeError(error)};}
 }));
 for(const result of results){
  if(result.market){
   snapshot.markets.push(result.market);
   snapshot.evidence.push({id:'hf:book:'+result.pair,pair:result.pair,status:'ok',source:PUBLIC+'/api/v3/depth',observedAt:createdAt,data:result.market.orderBook});
   snapshot.evidence.push({id:'hf:flow:'+result.pair,pair:result.pair,status:'ok',source:PUBLIC+'/api/v3/aggTrades',observedAt:createdAt,data:result.market.takerFlow});
   snapshot.evidence.push({id:'hf:momentum:'+result.pair,pair:result.pair,status:'ok',source:PUBLIC+'/api/v3/klines',observedAt:createdAt,data:result.market.microMomentum});
   snapshot.evidence.push({id:'cost:'+result.pair,pair:result.pair,status:'scenario_only',source:PUBLIC+'/api/v3/ticker/bookTicker',observedAt:createdAt,data:result.market.cost});
  }else{
   snapshot.errors.push({pair:result.pair,source:'high-frequency-public-market',code:result.error});
   snapshot.evidence.push({id:'hf:unavailable:'+result.pair,pair:result.pair,status:'unavailable',source:PUBLIC,data:{reason:result.error}});
  }
 }
 snapshot.markets.sort((a,b)=>a.pair.localeCompare(b.pair));
 snapshot.evidence.sort((a,b)=>a.id.localeCompare(b.id));
 snapshot.completedAt=new Date().toISOString();
 return snapshot;
}

function observerProposal(raw){
 if(raw.action==='sell')return {...raw,action:'hold',stakeUsdt:'0',reason:'OBSERVATION_ONLY_NO_OPEN_POSITION／'+raw.reason};
 if(raw.action==='buy')return {...raw,stakeUsdt:'0'};
 return raw;
}

export async function runHighFrequencyCycle(options={}){
 const {local=join(LOCAL,'ai-high-frequency'),collectFn=collectHighFrequencySnapshot,analyzeFn=analyze,fetchImpl=fetch,signal,now=Date.now,
  strategyConfig,strategyProfile,sensitivity,includeSnapshot=false}=options;
 const policy=options.policy??await loadPolicy('dry-run');
 if(policy.mode!=='dry-run')throw new Error('HIGH_FREQUENCY_RESEARCH_DRY_RUN_ONLY');
 const startedAt=new Date(now()).toISOString(),snapshot=await collectFn({fetchImpl,now:now()});
 const highFrequencyConfig=strategyConfig??await loadHighFrequencyStrategy();
 const strategyPlan=await buildHighFrequencyStrategyPlan(snapshot,{config:highFrequencyConfig,profile:strategyProfile,sensitivity});
 const plannedSnapshot={...snapshot,strategyPlan};
 await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),plannedSnapshot);
 const analysis=await analyzeFn(plannedSnapshot,policy,{trades:[]},{signal,purpose:'high-frequency-cli',proposalSchemaOverride:highFrequencyProposalSchema(policy)});
 const providedControl=analysis.proposal.strategyControl,rawControl=providedControl??{decision:'hold',profile:'auto',sensitivity:'balanced',evidenceIds:[],reason:'AI 未提供受控策略選擇'};
 const controlledPlan=providedControl&&rawControl.decision==='use'?await buildHighFrequencyStrategyPlan(plannedSnapshot,{config:highFrequencyConfig,profile:rawControl.profile,sensitivity:rawControl.sensitivity}):null;
 const proposal=providedControl?observerProposal(applyStrategyControl(analysis.proposal,rawControl,controlledPlan,plannedSnapshot)):observerProposal(analysis.proposal);
 const result={version:'ai-high-frequency-v1',mode:'dry-run',tradeEnabled:false,startedAt,completedAt:new Date().toISOString(),
  snapshotId:snapshot.id,marketCount:snapshot.markets.length,errors:snapshot.errors,proposal,rawProposal:analysis.proposal,
  strategy:{version:strategyPlan.version,profile:strategyPlan.profile,sensitivity:strategyPlan.sensitivity,selected:strategyPlan.selected,candidateCount:strategyPlan.candidates.length,
   aiControl:rawControl,applied:controlledPlan?controlledPlan.selected:null},
   model:analysis.metadata?.requestedModel??null,purpose:analysis.metadata?.purpose??'high-frequency-cli',runDir:analysis.runDir,
   ...(includeSnapshot?{snapshot:plannedSnapshot}: {})};
 await writeJson(join(local,'runs',snapshot.id+'.result.json'),result);
 await writeJson(join(local,'latest.json'),result);
 return result;
}

function applyStrategyControl(proposal,control,controlledPlan,snapshot){
 if(control.decision!=='use')return {...proposal,action:'hold',stakeUsdt:'0',reason:'AI_STRATEGY_HOLD／'+control.reason};
 const selected=controlledPlan?.selected;
 if(!selected)return {...proposal,action:'hold',stakeUsdt:'0',reason:'AI_STRATEGY_NO_VALID_CANDIDATE／'+control.reason};
 const evidenceIds=new Set((snapshot?.evidence??[]).map(e=>e.id));
 if(!Array.isArray(control.evidenceIds)||control.evidenceIds.length<1||control.evidenceIds.some(id=>!evidenceIds.has(id)))
  return {...proposal,action:'hold',stakeUsdt:'0',reason:'AI_STRATEGY_EVIDENCE_INVALID／'+control.reason};
 if(proposal.action!=='buy'||proposal.pair!==selected.pair)return {...proposal,action:'hold',stakeUsdt:'0',reason:'AI_STRATEGY_PROPOSAL_MISMATCH／'+control.reason};
 return {...proposal,pair:selected.pair,reason:'AI_STRATEGY_'+selected.profile+'／'+control.reason+'／'+proposal.reason};
}

export async function runHighFrequency({cycles=1,intervalSeconds=60,...options}={}){
 if(!Number.isInteger(cycles)||cycles<1||cycles>1000)throw new Error('HIGH_FREQUENCY_CYCLES_INVALID');
 if(!Number.isInteger(intervalSeconds)||intervalSeconds<30||intervalSeconds>3600)throw new Error('HIGH_FREQUENCY_INTERVAL_INVALID');
 const results=[];
 for(let i=0;i<cycles;i++){
  results.push(await runHighFrequencyCycle(options));
  if(i+1<cycles)await delay(intervalSeconds*1000);
 }
 return {version:'ai-high-frequency-v1',tradeEnabled:false,cycles:results};
}
