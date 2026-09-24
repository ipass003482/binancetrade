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

// Public, normalized cost scenarios for the entry reviewer. These use an
// executable ask->bid (long) or bid->ask (short) price basis: the spread is
// already in the quotes and MUST NOT be charged a second time. They describe
// fees and hypothetical exits, never a forecast, win rate or account balance.
const CostDecimal=Decimal.clone({precision:40});
export function executableCostEconomics({mode,action,market,stopFraction,targetFraction}){
 const invalid=()=>{throw Error('KEV_COST_ECONOMICS_INVALID');};
 const number=value=>{
  if(!['string','number'].includes(typeof value)||String(value).length>100)invalid();
  let result;try{result=new CostDecimal(value);}catch{invalid();}
  if(!result.isFinite()||Math.abs(result.e)>50)invalid();return result;
 };
 const long=action!=='open-short',cost=market?.entryCost;
 if(!['demo','demo-futures'].includes(mode)||!(mode==='demo'?['buy']:['open-long','open-short']).includes(action)||cost?.status!=='ok')invalid();
 const bid=number(market.bid),ask=number(market.ask),buy=number(cost.buyRate),sell=number(cost.sellRate),
  slip=number(cost.slippageBpsPerSide).div(10000),fund=number(cost.fundingReserveBps).div(10000),
  spread=number(cost.spreadBps),fees=number(cost.roundTripFeeBps),total=number(cost.estimatedRoundTripCostBps),
  required=number(cost.requiredPriceSpaceBps),stop=number(stopFraction),target=number(targetFraction);
 if(bid.lte(0)||ask.lt(bid)||buy.lt(0)||sell.lt(0)||buy.gt('.1')||sell.gt('.1')||
  slip.lt(0)||slip.gt('.01')||fund.lt(0)||fund.gt(1)||(mode==='demo'&&!fund.isZero())||spread.lt(0)||spread.gt(10000)||
  total.lt(0)||required.lt(total)||required.gt(10000)||stop.lte(0)||stop.gt('.02')||target.lte(0)||target.gt(1)||
  fees.minus(buy.plus(sell).mul(10000)).abs().gt('1e-8')||
  total.minus(fees.plus(spread).plus(slip.mul(20000)).plus(fund.mul(10000))).abs().gt('1e-8'))invalid();
 const quoteSpread=ask.minus(bid).div(bid).mul(10000);
 if(spread.minus(quoteSpread).abs().gt('1e-8')||number(market.spreadBps).minus(quoteSpread).abs().gt('1e-8'))invalid();
 const entryQuote=long?ask:bid,currentExitQuote=long?bid:ask,sign=long?1:-1,
  entryFill=entryQuote.mul(new CostDecimal(1).plus(slip.mul(sign))),
  exitFactor=new CostDecimal(1).minus(slip.mul(sign)),entryFee=long?buy:sell,exitFee=long?sell:buy,
  buffer=required.minus(total).div(10000),notional=new CostDecimal(100),amount=notional.div(entryFill);
 const netAt=exitQuote=>{
  const exitFill=exitQuote.mul(exitFactor);
  // Spot's undiscounted BUY fee can be taken from received base currency.
  // Budget that quantity reduction instead of charging a quote fee as well.
  if(mode==='demo')return amount.mul(new CostDecimal(1).minus(buy)).mul(exitFill)
   .mul(new CostDecimal(1).minus(sell)).minus(notional);
  return amount.mul(exitFill.minus(entryFill)).mul(sign)
   .minus(notional.mul(entryFee)).minus(amount.mul(exitFill).mul(exitFee)).minus(notional.mul(fund));
 };
 const exitForNet=netFraction=>mode==='demo'
  ?entryFill.mul(new CostDecimal(1).plus(netFraction)).div(new CostDecimal(1).minus(buy).mul(exitFactor).mul(new CostDecimal(1).minus(sell)))
  :long?entryFill.mul(new CostDecimal(1).plus(entryFee).plus(fund).plus(netFraction)).div(exitFactor.mul(new CostDecimal(1).minus(exitFee)))
   :entryFill.mul(new CostDecimal(1).minus(entryFee).minus(fund).minus(netFraction)).div(exitFactor.mul(new CostDecimal(1).plus(exitFee)));
 const breakEven=exitForNet(new CostDecimal(0)),withBuffer=exitForNet(buffer),
  targetQuote=entryFill.mul(new CostDecimal(1).plus(target.mul(sign))),
  stopQuote=entryFill.mul(new CostDecimal(1).minus(stop.mul(sign)));
 if(breakEven.lte(0)||withBuffer.lte(0)||targetQuote.lte(0)||stopQuote.lte(0))invalid();
 const price=v=>v.toSignificantDigits(20).toFixed(),money=v=>v.toFixed(8);
 return {version:'kev-executable-cost-v1',basis:'100_USDT_entry_notional; executable exit quotes, spread included once',
  feeAssumption:mode==='demo'?'undiscounted BUY fee in received base; SELL fee in quote; no BNB discount':'quote fees on each leg plus reserved funding',
  entryQuotePrice:price(entryQuote),modeledEntryFillPrice:price(entryFill),currentExitQuotePrice:price(currentExitQuote),
  entryFeeRate:entryFee.toFixed(),exitFeeRate:exitFee.toFixed(),slippageBpsPerSide:slip.mul(10000).toFixed(),
  fundingReserveBps:fund.mul(10000).toFixed(),netBufferBps:buffer.mul(10000).toFixed(),
  breakEvenExitQuotePrice:price(breakEven),exitQuoteForNetBuffer:price(withBuffer),
  requiredFavorableExitQuoteMoveBps:withBuffer.div(currentExitQuote).minus(1).mul(sign).mul(10000).toFixed(8),
  unchangedQuotesNetUsdtPer100:money(netAt(currentExitQuote)),
  targetExitQuotePrice:price(targetQuote),targetNetUsdtPer100:money(netAt(targetQuote)),
  stopExitQuotePrice:price(stopQuote),stopNetUsdtPer100:money(netAt(stopQuote)),
  stopScenario:'planned stop trigger quote plus modeled exit slippage; excludes additional stop-limit stress reserve used by native sizing',
  forecast:false};
}
