import test from 'node:test';
import assert from 'node:assert/strict';
import {KEV_NET_HARVEST_POLICY as policy,reviewedKevExitPolicy,validKevExitPolicy} from '../src/kev-exit-policy.mjs';
const fixture=()=>({request:{state:{requestVersion:'kev-flow-request-v4',exitPolicy:{...policy},
 candidates:[{id:'q0',pair:'ETH/USDT',action:'buy',exitPolicyVersion:policy.version}]}}});

test('the exact reviewed exit policy is copied without mutating approval bytes',()=>{
 const review=fixture(),before=JSON.stringify(review),copy=reviewedKevExitPolicy(review,'ETH/USDT','buy');
 assert.deepEqual(copy,policy);assert.notEqual(copy,review.request.state.exitPolicy);
 copy.lateNetBps='0';assert.equal(JSON.stringify(review),before);
});

test('unapproved policy, stale request versions, duplicate and wrong-side candidates are rejected',()=>{
 const mutations=[r=>delete r.request.state.exitPolicy,r=>r.request.state.exitPolicy=null,
  r=>r.request.state.exitPolicy.lateNetBps='0',r=>r.request.state.exitPolicy.exitSlippageBps='0',
  r=>r.request.state.exitPolicy.extra=true,r=>r.request.state.exitPolicy.keepFixedGrossTarget=false,
  r=>r.request.state.requestVersion='kev-flow-request-v3',
  r=>delete r.request.state.candidates[0].exitPolicyVersion,
  r=>r.request.state.candidates[0].exitPolicyVersion='unknown',
  r=>r.request.state.candidates[0].action='open-short',
  r=>r.request.state.candidates.push({...r.request.state.candidates[0]})];
 for(const mutate of mutations){const review=fixture();mutate(review);
  assert.throws(()=>reviewedKevExitPolicy(review,'ETH/USDT','buy'),/KEV_EXIT_POLICY_MISMATCH/);}
 for(const invalid of [undefined,null,[],{}, {...policy,middleAfterSeconds:true},
   {...policy,middleNetUsdt:1},{...policy,maxHoldingSeconds:901}])assert.equal(validKevExitPolicy(invalid),false);
});
