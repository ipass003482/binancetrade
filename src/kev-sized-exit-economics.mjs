import Decimal from 'decimal.js';
import {executableCostEconomics} from './trading-costs.mjs';
import {DEMO_PROFIT_PROTECTION} from './demo-rules.mjs';
import {validKevExitPolicy} from './kev-exit-policy.mjs';

export const KEV_SIZED_EXIT_EVIDENCE_VERSION='kev-sized-exit-evidence-v1';
const D=Decimal.clone({precision:40});

// Public, prospective cash-flow scenarios. The proposed ceiling is not an
// order or a filled amount. Native exits later use the reconciled trade amount,
// open rate, fees and booked funding, never these review-only estimates.
export function candidateExitEconomics({mode,action,market,stopFraction,targetFraction,
 maxHoldingSeconds,exitPolicy,proposedEntryNotionalUsdt}){
 const invalid=()=>{throw Error('KEV_SIZED_EXIT_ECONOMICS_INVALID');};
 if(!validKevExitPolicy(exitPolicy)||maxHoldingSeconds!==exitPolicy.maxHoldingSeconds||
  !['string','number'].includes(typeof proposedEntryNotionalUsdt)||String(proposedEntryNotionalUsdt).length>100)invalid();
 let notional;
 try{notional=new D(proposedEntryNotionalUsdt);}catch{invalid();}
 if(!notional.isFinite()||notional.lte(0)||Math.abs(notional.e)>50)invalid();
 // Reuse the existing validation, including side-specific fee facts and the
// executable spread. Keep the original 100-USDT/base-fee evidence unchanged.
 const costs=executableCostEconomics({mode,action,market,stopFraction,targetFraction,maxHoldingSeconds});
 const long=action!=='open-short',sign=long?1:-1,slip=new D(costs.slippageBpsPerSide).div(10000),
  entryQuote=new D(long?market.ask:market.bid),exitQuote=new D(long?market.bid:market.ask),
  entryFill=entryQuote.mul(new D(1).plus(slip.mul(sign))),
  entryFee=new D(costs.entryFeeRate),exitFee=new D(costs.exitFeeRate),fund=new D(costs.fundingReserveBps).div(10000),
  exitFactor=new D(1).minus(new D(exitPolicy.exitSlippageBps).div(10000).mul(sign));
 // This is the native filled-notional fee convention: one entry fee and one
 // exit fee. Do not also reduce this hypothetical filled amount by a BUY fee.
 // Reserved funding is an adverse assumption, not known signed booked funding.
 const netAt=(quote,reserve=true)=>{
  const exitRatio=quote.div(entryFill).mul(reserve?exitFactor:1);
  return notional.mul(exitRatio.minus(1).mul(sign).minus(entryFee).minus(exitRatio.mul(exitFee)).minus(fund));
 };
 const targetQuote=entryFill.mul(new D(1).plus(new D(targetFraction).mul(sign))),
  stopQuote=entryFill.mul(new D(1).minus(new D(stopFraction).mul(sign))),
  middle=new D(exitPolicy.middleNetUsdt),late=notional.mul(exitPolicy.lateNetBps).div(10000),
  trail=new D(DEMO_PROFIT_PROTECTION.triggerNetUsdt),giveback=new D(DEMO_PROFIT_PROTECTION.givebackNetUsdt),
  targetNet=netAt(targetQuote),money=value=>value.toFixed(8),bps=value=>value.div(notional).mul(10000).toFixed(8);
 return {version:KEV_SIZED_EXIT_EVIDENCE_VERSION,proposedEntryNotionalCeilingUsdt:notional.toFixed(),maxHoldingSeconds,
  netUsdtBeforeExitReserve:{unchangedQuote:money(netAt(exitQuote,false)),stopTrigger:money(netAt(stopQuote,false)),grossTarget:money(netAt(targetQuote,false))},
  netUsdtAfterExitReserve:{unchangedQuote:money(netAt(exitQuote)),stopTrigger:money(netAt(stopQuote)),grossTarget:money(targetNet)},
  netThresholdUsdt:{trailActivation:money(trail),trailGiveback:money(giveback),middleHarvest:money(middle),lateHarvest:money(late)},
  netThresholdBps:{trailActivation:bps(trail),trailGiveback:bps(giveback),middleHarvest:bps(middle),lateHarvest:bps(late)},
  // Strictly below the target: when both trigger at the same quote, the native
  // gross target has priority. This is geometry under the stated assumptions,
  // not a statement that either threshold will be reached on a future path.
  harvestBelowGrossTarget:{middle:targetNet.gt(middle),late:targetNet.gt(late)}};
}
