import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeNetExitComparisons,main} from '../scripts/kev-net-exit-review.mjs';

function row(key,base,staged){return {key,mode:key.split(':')[0],scenarios:['0','5','10'].map(adverseSlippageBps=>({adverseSlippageBps,
 comparison:{status:'indicative_comparison',results:[['baseline',base],['staged',staged]].map(([policy,netUsdt])=>({policy,
  status:'indicative_displayed_depth_simulation',exit:{at:1790000000000,netUsdt,reason:'rules_time'}}))}}))};}
const summary=(r,mode='combined')=>r.summaries.find(s=>s.mode===mode&&s.adverseSlippageBps==='0');

test('unavailable funding/path arms never become zero-net results or inflate comparison coverage',()=>{
 const missing=row('demo-futures:1','10','11');missing.scenarios[2].comparison={status:'incomplete_evidence',results:[]};
 const r=summarizeNetExitComparisons([row('demo:1','-0.1','0.1'),missing]);
 assert.equal(r.matchedTrades,1);assert.deepEqual(r.unavailableKeys,['demo-futures:1']);
 assert.equal(r.completeForSubmittedTrades,false);assert.equal(summary(r).stagedMinusBaselineNetUsdt,'0.2');
 assert.equal(summary(r,'demo-futures').arms.baseline.netUsdt,null);
 assert.equal(summary(r,'demo-futures').arms.staged.positiveNetFraction,null);
});
test('fee-adjusted zero is nonpositive; the report shows winners and losers without claiming actual win rate',()=>{
 const r=summarizeNetExitComparisons([row('demo:1','0.2','0'),row('demo:2','-0.5','-0.1')]);
 const s=summary(r);assert.equal(s.arms.staged.positiveNet,0);assert.equal(s.arms.staged.nonPositiveNet,2);
 assert.equal(s.arms.staged.positiveNetFraction,0);assert.equal(s.arms.staged.netUsdt,'-0.1');
 assert.equal(s.arms.baseline.profitFactor,0.4);assert.equal(s.stagedMinusBaselineNetUsdt,'0.2');
 assert.equal(s.arms.baseline.maxDrawdownOfClosedScenarioNetUsdt,'0.5');assert.match(r.label,/not actual fills/);
});
test('missing scenarios, nonfinite nets, duplicate arms and duplicate trade keys cannot manufacture a matched cohort',()=>{
 const a=row('demo:1','1','2');a.scenarios.pop();const b=row('demo:2','Infinity','2');
 const c=row('demo:3','1','2');c.scenarios[0].comparison.results.push(c.scenarios[0].comparison.results[0]);
 const r=summarizeNetExitComparisons([a,b,c]);assert.equal(r.matchedTrades,0);assert.equal(summary(r).arms.baseline.netUsdt,null);
 assert.equal(summary(r).stagedMinusBaselineNetUsdt,null);
 assert.throws(()=>summarizeNetExitComparisons([a,a]),/DUPLICATE_REPLAY_TRADE/);
});
test('empty inputs have no measured profitability and unsupported command options are rejected before reads',async()=>{
 const r=summarizeNetExitComparisons([]);assert.equal(r.completeForSubmittedTrades,false);
 assert.equal(summary(r).arms.staged.netUsdt,null);assert.equal(summary(r).arms.staged.positiveNetFraction,null);
 await assert.rejects(()=>main(['--activate']),/USAGE/);
});
