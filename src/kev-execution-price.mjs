import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:40});

// A decision stays bound to the price Kev actually reviewed. The pre-send book
// and the native order rate share ONE budget; intermediate quotes cannot reset
// its anchor. This is quote drift control, not a market-order fill guarantee.
export function assessKevExecutionPrice({snapshot,proposal,executionQuote,cost,policy,review,stopFraction,targetFraction}){
 const base={version:'kev-decision-quote-v1',reference:'kev-approved-snapshot',basis:'decision_quote_drift_not_fill_slippage_guarantee'};
 const fail=reason=>({...base,eligible:false,reason});
 const num=value=>{
  if(!['number','string'].includes(typeof value)||String(value).length>100)throw Error();
  const n=new Decimal(value);if(!n.isFinite()||Math.abs(n.e)>50)throw Error();return n;
 };
 try{
  if(snapshot?.entryPolicyVersion!=='kev-order-flow-v1'||snapshot.mode!==policy.mode||
   !(policy.mode==='demo'?['buy']:policy.mode==='demo-futures'?['open-long','open-short']:[]).includes(proposal.action)||
   review?.status!=='reviewed'||review.snapshotId!==snapshot.id||review.request?.state?.snapshotId!==snapshot.id)throw Error();
  const markets=snapshot.markets?.filter(m=>m.pair===proposal.pair),seen=review.request.state.markets?.filter(m=>m.pair===proposal.pair);
  if(markets?.length!==1||seen?.length!==1||executionQuote?.pair!==proposal.pair||cost?.status!=='ok'||markets[0].entryCost?.status!=='ok')throw Error();
  const original=markets[0],reviewed=seen[0],side=proposal.action==='open-short'?'bid':'ask';
  if(typeof original.fetchedAt!=='string'||!Number.isFinite(Date.parse(original.fetchedAt))||reviewed.quoteObservedAt!==original.fetchedAt)throw Error();
  for(const key of ['bid','ask'])if(num(original[key]).lte(0)||!num(original[key]).eq(num(reviewed[key])))throw Error();
  const anchor=num(original[side]),quote=num(executionQuote[side]),policyCap=num(policy.maxPriceMoveBps),slip=num(cost.slippageBpsPerSide),
   stop=num(stopFraction).mul(10000),target=num(targetFraction).mul(10000),
   originalRequired=num(original.entryCost.requiredPriceSpaceBps),freshRequired=num(cost.requiredPriceSpaceBps),
   headroom=target.minus(Decimal.max(originalRequired,freshRequired));
  if(quote.lte(0)||policyCap.lt(0)||slip.lt(0)||stop.lte(0)||target.lte(0)||originalRequired.lt(0)||freshRequired.lt(0)||
   !slip.eq(num(original.entryCost.slippageBpsPerSide))||headroom.lt(0))throw Error();
  const cap=Decimal.min(policyCap,slip,stop,headroom),delta=quote.minus(anchor).abs(),eligible=delta.mul(10000).lte(anchor.mul(cap));
  return {...base,eligible,reason:eligible?null:'KEV_DECISION_QUOTE_MOVED',referencePrice:anchor.toFixed(),quotedPrice:quote.toFixed(),
   absoluteMoveBps:delta.div(anchor).mul(10000).toFixed(),maxMoveBps:cap.toFixed(),
   budget:{policyBps:policyCap.toFixed(),slippageBpsPerSide:slip.toFixed(),stopBps:stop.toFixed(),remainingCostSpaceBps:headroom.toFixed()}};
 }catch{return fail('KEV_DECISION_QUOTE_INVALID');}
}
