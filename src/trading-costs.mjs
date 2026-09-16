import Decimal from 'decimal.js';
import { z } from 'zod';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { readJson } from './io.mjs';
import { readAccountFacts } from './account-facts.mjs';
import { safeError } from './health.mjs';
export const CostConfig=z.object({version:z.literal(1),maxAgeSeconds:z.number().int().min(30).max(900),
 slippageBpsPerSide:z.number().min(0).max(100),priceSpaceBufferBps:z.number().min(0).max(1000),fundingReserveEvents:z.number().int().min(1).max(12)}).strict();
export async function loadCosts(){return CostConfig.parse(await readJson(join(ROOT,'config/costs.json')));}
export async function collectCosts(policy,{read=readAccountFacts}={}){
 if(policy.mode==='dry-run')return {mode:policy.mode,status:'unavailable',reason:'DRY_RUN_NO_ACCOUNT_FEES'};
 try{return await read(policy.mode,'costs');}catch(e){return {mode:policy.mode,status:'unavailable',reason:safeError(e)};}
}
export function entryCost(facts,market,mode,config,now=Date.now()){
 const unavailable=reason=>({status:'unavailable',reason});
 if(facts?.mode!==mode||facts.kind!=='costs'||facts.readOnly!==true||facts.source!==(mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com'))return unavailable('COST_SOURCE_UNAVAILABLE');
 const age=now-Date.parse(facts.observedAt);
 if(!Number.isFinite(age)||age<0||age>config.maxAgeSeconds*1000)return unavailable('COST_SAMPLE_STALE');
 const matches=facts.rates?.filter(r=>r.pair===market.pair)??[];
 if(matches.length!==1||matches[0].status!=='ok')return unavailable('PAIR_COMMISSION_UNAVAILABLE');
 try{
  const row=matches[0];
  if([row.buyRate,row.sellRate].some(v=>typeof v!=='string'||!v.trim()))return unavailable('COST_RATE_INVALID');
  const buy=new Decimal(row.buyRate),sell=new Decimal(row.sellRate),spread=new Decimal(market.spreadBps);
  if(![buy,sell,spread].every(v=>v.isFinite()&&v.gte(0))||buy.gt(.1)||sell.gt(.1))return unavailable('COST_RATE_INVALID');
  const funding=mode==='demo-futures'?new Decimal(market.fundingRate).abs().mul(10000).mul(config.fundingReserveEvents):new Decimal(0);
  if(!funding.isFinite())return unavailable('FUNDING_UNAVAILABLE');
  const fees=buy.plus(sell).mul(10000),slippage=new Decimal(config.slippageBpsPerSide).mul(2);
  const total=fees.plus(spread).plus(slippage).plus(funding),required=total.plus(config.priceSpaceBufferBps);
  return {status:'ok',pair:market.pair,mode,observedAt:facts.observedAt,source:facts.source,method:row.method,
   buyRate:buy.toFixed(),sellRate:sell.toFixed(),roundTripFeeBps:fees.toFixed(),spreadBps:spread.toFixed(),
   slippageBpsPerSide:config.slippageBpsPerSide,fundingReserveBps:funding.toFixed(),fundingReserveEvents:config.fundingReserveEvents,
   estimatedRoundTripCostBps:total.toFixed(),requiredPriceSpaceBps:required.toFixed(),
   note:'Undiscounted fees; spread and slippage are estimates. Funding reserves absolute current rate, not future known cost; re-evaluate longer holdings. No claim of positive expected return.'};
 }catch{return unavailable('COST_RATE_INVALID');}
}
export function attachCosts(snapshot,facts,config){
 snapshot.costFacts=facts;
 for(const m of snapshot.markets){m.entryCost=entryCost(facts,m,snapshot.mode,config);snapshot.evidence.push({id:'cost:'+m.pair,pair:m.pair,status:m.entryCost.status,data:m.entryCost});}
 return snapshot;
}
