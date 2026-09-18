import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './paths.mjs';
import { readJson } from './io.mjs';

export const HIGH_FREQUENCY_STRATEGY_VERSION='adaptive-microstructure-v1';
const finite=z.number().finite();
const profileSchema=z.object({
 maxSpreadBps:finite.min(0).max(100),minBuyShare:finite.min(.5).max(1),minImbalance:finite.min(0).max(1),
 minMomentum1mBps:finite.min(-100).max(100),minMomentum5mBps:finite.min(-100).max(100),
 maxPullback5mBps:finite.min(-100).max(0).optional(),minSignals:z.number().int().min(2).max(4)
}).strict();
export const HighFrequencyStrategySchema=z.object({
 version:z.literal(1),defaultProfile:z.enum(['auto','momentum','mean-reversion','breakout']),
 defaultSensitivity:z.enum(['conservative','balanced','aggressive']),profiles:z.object({
  momentum:profileSchema,'mean-reversion':profileSchema,breakout:profileSchema
 }).strict(),adaptation:z.object({
 wideSpreadBps:finite.positive().max(100),fastVolatilityBps:finite.positive().max(100),
 extremeVolatilityBps:finite.positive().max(200),trendMomentum5mBps:finite.min(0).max(100),
 breakoutMomentum5mBps:finite.min(0).max(100),reversalPullback5mBps:finite.min(-100).max(0)
 }).strict(),shadow:z.object({
  intervalSeconds:z.number().int().min(15).max(3600),aiReviewEveryCycles:z.number().int().min(1).max(100),
  horizonSeconds:z.array(z.number().int().min(15).max(3600)).min(1).max(3),maxPending:z.number().int().min(1).max(256)
 }).strict()
}).strict();

export async function loadHighFrequencyStrategy(){
 return HighFrequencyStrategySchema.parse(await readJson(join(ROOT,'config','high-frequency.json')));
}

const num=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

function sensitivityAdjustment(sensitivity){
 if(sensitivity==='conservative')return {buyShare:.02,imbalance:.04,momentum:.2};
 if(sensitivity==='aggressive')return {buyShare:-.01,imbalance:-.02,momentum:-.1};
 return {buyShare:0,imbalance:0,momentum:0};
}

function effectiveProfile(profile,sensitivity){
 const adjustment=sensitivityAdjustment(sensitivity);
 return {...profile,
  minBuyShare:clamp(profile.minBuyShare+adjustment.buyShare,.51,.8),
  minImbalance:clamp(profile.minImbalance+adjustment.imbalance,0,.8),
  minMomentum1mBps:Math.max(0,profile.minMomentum1mBps+adjustment.momentum),
  minMomentum5mBps:Math.max(0,profile.minMomentum5mBps+adjustment.momentum)
 };
}

function extract(market){
 const quote=market?.quote??{},book=market?.orderBook??{},flow=market?.takerFlow??{},momentum=market?.microMomentum??{},cost=market?.cost??{};
 return {pair:market?.pair??null,spreadBps:num(quote.spreadBps),imbalance:num(book.imbalanceTop5),buyShare:num(flow.buyShare),
  return1mBps:num(momentum.return1mBps),return5mBps:num(momentum.return5mBps),return15mBps:num(momentum.return15mBps),
  volatility1mBps:num(momentum.volatility1mBps),requiredPriceSpaceBps:num(cost.requiredPriceSpaceBps),costStatus:cost.status??null,
  dataStatus:market?.dataStatus??null,observedAt:market?.observedAt??null};
}

function complete(features){
 return Boolean(features.pair&&features.dataStatus==='ok'&&features.observedAt&&
  [features.spreadBps,features.imbalance,features.buyShare,features.return1mBps,features.return5mBps,
   features.return15mBps,features.requiredPriceSpaceBps].every(numValue=>numValue!==null));
}

function classifyRegime(features,adaptation){
 if(!complete(features))return 'insufficient-data';
 if(features.spreadBps>adaptation.wideSpreadBps)return 'wide-spread';
 if(features.volatility1mBps!==null&&features.volatility1mBps>=adaptation.extremeVolatilityBps)return 'high-volatility';
 if(features.return5mBps>=adaptation.breakoutMomentum5mBps&&features.return1mBps>0&&features.return15mBps>=0)
  return 'breakout-up';
 if(features.return5mBps<=-adaptation.breakoutMomentum5mBps&&features.return1mBps<0&&features.return15mBps<=0)
  return 'breakout-down';
 if(features.return5mBps>=adaptation.trendMomentum5mBps&&features.return15mBps>=0)return 'trend-up';
 if(features.return5mBps<=-adaptation.trendMomentum5mBps&&features.return15mBps<=0)return 'trend-down';
 if(features.return5mBps<=adaptation.reversalPullback5mBps&&features.return1mBps>0&&features.buyShare>.5&&features.imbalance>0)
  return 'mean-reversion-up';
 if(features.return5mBps>=-adaptation.reversalPullback5mBps&&features.return1mBps<0&&features.buyShare<.5&&features.imbalance<0)
  return 'mean-reversion-down';
 if(features.volatility1mBps!==null&&features.volatility1mBps>=adaptation.fastVolatilityBps)return 'fast-range';
 return 'range';
}

function profileForRegime(regime){
 if(regime.startsWith('breakout-'))return 'breakout';
 if(regime.startsWith('mean-reversion-'))return 'mean-reversion';
 if(regime.startsWith('trend-'))return 'momentum';
 return 'momentum';
}

function evaluateMarket(market,config,requestedProfile,sensitivity){
 const features=extract(market),regime=classifyRegime(features,config.adaptation);
 const profileName=requestedProfile==='auto'?profileForRegime(regime):requestedProfile;
 const parameters=effectiveProfile(config.profiles[profileName],sensitivity);
 const signals=[],blockers=[],risks=[];
 if(!complete(features))blockers.push('MARKET_DATA_INCOMPLETE');
 if(features.spreadBps!==null&&features.spreadBps>parameters.maxSpreadBps)blockers.push('SPREAD_TOO_WIDE');
 if(features.costStatus!=='scenario_only')blockers.push('COST_SCENARIO_MISSING');
 if(regime==='wide-spread'||regime==='high-volatility'||regime==='insufficient-data')blockers.push('REGIME_NOT_TRADEABLE');
 if(features.spreadBps!==null&&features.spreadBps>config.adaptation.wideSpreadBps)blockers.push('ADAPTIVE_SPREAD_GUARD');
 if(features.volatility1mBps!==null&&features.volatility1mBps>=config.adaptation.extremeVolatilityBps)blockers.push('ADAPTIVE_VOLATILITY_GUARD');
 if(features.buyShare!==null&&features.buyShare>=parameters.minBuyShare)signals.push('taker-buy-flow');
 if(features.imbalance!==null&&features.imbalance>=parameters.minImbalance)signals.push('bid-depth-pressure');
 if(profileName==='mean-reversion'){
  if(features.return5mBps!==null&&features.return5mBps<=parameters.maxPullback5mBps)signals.push('5m-pullback');
  if(features.return1mBps!==null&&features.return1mBps>=parameters.minMomentum1mBps)signals.push('1m-rebound');
  if(features.return5mBps!==null&&features.return5mBps>parameters.maxPullback5mBps)blockers.push('PULLBACK_NOT_CONFIRMED');
 }else{
  if(features.return1mBps!==null&&features.return1mBps>=parameters.minMomentum1mBps)signals.push('1m-momentum');
  if(features.return5mBps!==null&&features.return5mBps>=parameters.minMomentum5mBps)signals.push('5m-momentum');
 }
 if(regime.endsWith('-down')||regime==='trend-down'||regime==='breakout-down')blockers.push('DIRECTION_DOWN');
 if(signals.length<parameters.minSignals)blockers.push('SIGNALS_BELOW_MINIMUM');
 if(features.costStatus==='scenario_only')risks.push('COST_SCENARIO_ONLY');
 if(features.volatility1mBps!==null&&features.volatility1mBps>=config.adaptation.fastVolatilityBps)risks.push('FAST_MARKET_REQUIRES_RECHECK');
 const rankScore=signals.length*10+(features.buyShare===null?0:Math.max(0,features.buyShare-.5)*100)+
  (features.imbalance===null?0:Math.max(0,features.imbalance)*20)-(features.spreadBps===null?0:features.spreadBps*.25);
 return {pair:features.pair,action:blockers.length?'hold':'buy',profile:profileName,regime,sensitivity,rankScore:Number(rankScore.toFixed(4)),
  signalCount:signals.length,signals,blockers,risks,effectiveParameters:parameters,features};
}

export async function buildHighFrequencyStrategyPlan(snapshot,{config,profile,sensitivity}={}){
 const loaded=config??await loadHighFrequencyStrategy(),requestedProfile=profile??loaded.defaultProfile,selectedSensitivity=sensitivity??loaded.defaultSensitivity;
 if(!['auto','momentum','mean-reversion','breakout'].includes(requestedProfile))throw new Error('HIGH_FREQUENCY_PROFILE_INVALID');
 if(!['conservative','balanced','aggressive'].includes(selectedSensitivity))throw new Error('HIGH_FREQUENCY_SENSITIVITY_INVALID');
 const markets=Array.isArray(snapshot?.markets)?snapshot.markets:[];
 const candidates=markets.map(market=>evaluateMarket(market,loaded,requestedProfile,selectedSensitivity));
 const selected=[...candidates].filter(candidate=>candidate.action==='buy').sort((a,b)=>b.rankScore-a.rankScore)[0]??null;
 const summarize=candidate=>({pair:candidate.pair,action:candidate.action,profile:candidate.profile,regime:candidate.regime,
  rankScore:candidate.rankScore,signalCount:candidate.signalCount,signals:candidate.signals,blockers:candidate.blockers,risks:candidate.risks,
  effectiveParameters:candidate.effectiveParameters});
 const profileOptions=['momentum','mean-reversion','breakout'].map(profileName=>{
  const profileCandidates=markets.map(market=>evaluateMarket(market,loaded,profileName,selectedSensitivity));
  const profileSelected=[...profileCandidates].filter(candidate=>candidate.action==='buy').sort((a,b)=>b.rankScore-a.rankScore)[0]??null;
  return {profile:profileName,action:profileSelected?'buy':'hold',selected:profileSelected?summarize(profileSelected):null,candidates:profileCandidates.map(summarize)};
 });
 return {version:HIGH_FREQUENCY_STRATEGY_VERSION,mode:'dry-run',tradeEnabled:false,profile:requestedProfile,sensitivity:selectedSensitivity,
  horizonSeconds:snapshot?.horizonSeconds??[15,60],adaptation:{mode:'auto',rule:'每輪依價差、波動、短線動能、主動成交與前五檔深度重新選擇策略；不跨輪固定門檻',
   selectedProfile:selected?.profile??null,selectedRegime:selected?.regime??null},
  selected:selected?summarize(selected):null,profileOptions,candidates:candidates.sort((a,b)=>b.rankScore-a.rankScore)};
}
