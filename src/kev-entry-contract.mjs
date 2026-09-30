import Decimal from 'decimal.js';
import {validKevEntrySignalPolicy} from './kev-entry-signal.mjs';

// A prospective signal contract is bound to the original snapshot and Kev
// request. Missing/unknown fields cannot silently downgrade an approved plan.
export function reviewedKevEntrySignalPolicy(review,snapshot,pair,action){
 const state=review?.request?.state,candidates=state?.candidates?.filter(c=>c.pair===pair&&c.action===action)??[];
 const present=Object.hasOwn(snapshot??{},'entrySignalPolicy');
 if(candidates.length!==1)throw Error('KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
 const candidate=candidates[0];
 if(!present){
  if(Object.hasOwn(state??{},'entrySignalPolicy')||Object.hasOwn(candidate,'entrySignalPolicyVersion')||
    state?.requestVersion==='kev-flow-request-v5')throw Error('KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
  return null;
 }
 if(!validKevEntrySignalPolicy(snapshot.entrySignalPolicy)||!validKevEntrySignalPolicy(state?.entrySignalPolicy)||
   state.requestVersion!=='kev-flow-request-v5'||candidate.entrySignalPolicyVersion!==snapshot.entrySignalPolicy.version)
  throw Error('KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
 return {...state.entrySignalPolicy};
}

// Recheck the original price response at the actual executable entry quote.
// The approved proof and its original clock are never refreshed here.
export function kevSignalQuoteRejection(proof,quote,{long}){
 try{
  const first=new Decimal(proof.books[0][long?'asks':'bids'][0][0]),price=new Decimal(quote[long?'ask':'bid']);
  if(!first.isFinite()||first.lte(0)||!price.isFinite()||price.lte(0))throw Error();
  return (long?price.gt(first):price.lt(first))?null:'KEV_SIGNAL_EXECUTION_PRICE_NOT_CONFIRMED';
 }catch{return 'KEV_SIGNAL_EXECUTION_QUOTE_INVALID';}
}
