// Frozen prospective Demo hypothesis. Historical plans without this field
// retain their original exits; actual fills alone determine profitability.
export const KEV_NET_HARVEST_POLICY=Object.freeze({
 version:'kev-net-harvest-v1',middleAfterSeconds:300,middleNetUsdt:'1',
 lateAfterSeconds:600,lateNetBps:'10',notionalBasis:'filled_amount_times_open_rate',
 keepFixedGrossTarget:true,maxHoldingSeconds:900,exitSlippageBps:'5'
});

export function validKevExitPolicy(value){
 return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===Object.keys(KEV_NET_HARVEST_POLICY).length&&
  Object.entries(KEV_NET_HARVEST_POLICY).every(([key,expected])=>value[key]===expected);
}

export function reviewedKevExitPolicy(review,pair,action){
 const state=review?.request?.state;
 const candidates=state?.candidates?.filter(c=>c.pair===pair&&c.action===action)??[];
 if(!['kev-flow-request-v4','kev-flow-request-v5'].includes(state?.requestVersion)||candidates.length!==1||!validKevExitPolicy(state.exitPolicy)||
   candidates[0].exitPolicyVersion!==state.exitPolicy.version)
  throw Error('KEV_EXIT_POLICY_MISMATCH');
 return {...state.exitPolicy};
}
