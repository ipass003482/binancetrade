// Additional execution stress reserve; never relabel it as a fee or alpha.
import Decimal from 'decimal.js';

export const DEMO_RISK_POLICY_VERSION='native-stop-risk-v1';
export function demoRiskPolicy(mode){
 if(!['demo','demo-futures'].includes(mode))throw Error('DEMO_RISK_MODE_REQUIRED');
 return {version:DEMO_RISK_POLICY_VERSION,mode,
  stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'};
}
export function stopExecutionReserve(plan,{mode,required=false}={}){
 const value=plan?.riskPolicy;
 if(value===undefined&&!required)return new Decimal(0); // persisted old plans
 const expected=demoRiskPolicy(mode);
 if(!value||Array.isArray(value)||Object.keys(value).length!==Object.keys(expected).length||
  Object.entries(expected).some(([key,n])=>value[key]!==n))throw Error('DEMO_RISK_POLICY_INVALID');
 return new Decimal(expected.reserveFraction);
}
