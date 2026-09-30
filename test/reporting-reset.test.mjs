import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFreshResetReview,assertResetHistoryPreserved} from '../src/reporting-reset.mjs';
import {buildSprintReview} from '../scripts/trade-sprint-review.mjs';
const modes=['demo','demo-futures'];
const review=()=>({evidenceComplete:true,totalEntries:0,modes:Object.fromEntries(modes.map(m=>[m,
 {evidenceComplete:true,entries:0,openTrades:0,closedTrades:0,netRealizedUsdt:'0',netUnrealizedUsdt:'0'}]))});
const trade={trade_id:1,pair:'BTC/USDT',is_open:false,is_short:false,open_timestamp:100,close_timestamp:200,enter_tag:'codex-original',profit_abs:'-0.5'};
const histories=()=>Object.fromEntries(modes.map(m=>[m,{historyComplete:true,trades:[{...trade}]}]));
const previous=()=>Object.fromEntries(modes.map(m=>[m,[{...trade}]]));
test('fresh reset accepts verified empty cohort and rejects unknown or partial accounting',()=>{
 assertFreshResetReview(review());
 for(const mutate of [r=>r.evidenceComplete=false,r=>r.totalEntries=null,r=>r.totalEntries=1,
  r=>r.modes.demo.evidenceComplete=false,r=>r.modes.demo.netRealizedUsdt=null,
  r=>r.modes.demo.netUnrealizedUsdt='NaN',r=>r.modes.demo.openTrades=1,
  r=>r.modes.demo.netRealizedUsdt='-0.01']){
  const r=review();mutate(r);assert.throws(()=>assertFreshResetReview(r));
 }
});
test('reset preserves closed losses, identity and complete history while allowing an old open position to close',()=>{
 assertResetHistoryPreserved(previous(),histories());
 for(const mutate of [h=>h.demo.historyComplete=false,h=>h.demo.trades=[],h=>h.demo.trades.push({...trade}),
  h=>h.demo.trades[0].profit_abs='0',h=>h.demo.trades[0].profit_abs=null,
  h=>h.demo.trades[0].pair='ETH/USDT',h=>h.demo.trades[0].is_open=true]){
  const h=histories();mutate(h);assert.throws(()=>assertResetHistoryPreserved(previous(),h));
 }
 const old=previous();old.demo[0]={...trade,is_open:true,close_timestamp:null,profit_abs:null};
 assertResetHistoryPreserved(old,histories());
});

test('either mode with missing counts or unknown PnL prevents a certified initial zero',()=>{
 for(const mode of modes){
  for(const field of ['entries','openTrades','closedTrades','netRealizedUsdt','netUnrealizedUsdt']){
   for(const value of [undefined,null,'NaN','Infinity']){
    const r=review();r.modes[mode][field]=value;
    assert.throws(()=>assertFreshResetReview(r),mode+':'+field+':'+value);
   }
  }
  const r=review();delete r.modes[mode];assert.throws(()=>assertFreshResetReview(r));
 }
});

test('history preservation checks both modes and cannot silently change IDs, tags, direction or closing time',()=>{
 for(const mode of modes){
  for(const patch of [{trade_id:2},{enter_tag:'codex-replaced'},{is_short:true},{open_timestamp:101},{close_timestamp:201}]){
   const h=histories();Object.assign(h[mode].trades[0],patch);
   assert.throws(()=>assertResetHistoryPreserved(previous(),h),mode+':'+JSON.stringify(patch));
  }
 }
 const h=histories(),p=previous(),before=JSON.stringify({h,p});
 assertResetHistoryPreserved(p,h);
 assert.equal(JSON.stringify({h,p}),before);
});

test('equal nonfinite historical PnL cannot pass the preservation check',()=>{
 for(const mode of modes){
  for(const value of ['Infinity','-Infinity','NaN']){
   const h=histories(),p=previous();
   h[mode].trades[0].profit_abs=value;p[mode][0].profit_abs=value;
   assert.throws(()=>assertResetHistoryPreserved(p,h),/RESET_PNL_INVALID/);
  }
 }
});

test('fresh sprint reset excludes prior losses while keeping dynamic targets, and missing baseline evidence stays unknown',()=>{
 const startedAt='2026-09-28T00:00:00Z',start=Date.parse(startedAt),observedAt='2026-09-28T00:00:01Z';
 const histories=Object.fromEntries(modes.map(mode=>[mode,{source:'freqtrade-demo',historyComplete:true,observedAt,
  trades:[{...trade,pair:mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',stake_amount:50,leverage:1,
   open_timestamp:start-60000,close_timestamp:start-30000}]}]));
 const journals=Object.fromEntries(modes.map(mode=>[mode,[]]));
 const baseline=Object.fromEntries(modes.map(mode=>[mode,{excludedTradeIds:[1],baselineTradeCount:1}]));
 for(const target of [{scope:'each',count:37,totalCount:74},{scope:'combined',count:137,totalCount:137}]){
  const goal={schemaVersion:2,id:'fresh-cohort',source:'freqtrade-demo',startedAt,deadline:'2026-10-28T00:00:00Z',
   timezone:'Asia/Taipei',entryPolicyVersion:'kev-order-flow-v1',ruleVersion:'kev-order-flow-v1',modelFingerprint:null,
   target,modes:baseline};
  const input={goal,histories,journals,observedAt},before=JSON.stringify(input);
  const initial=assertFreshResetReview(buildSprintReview(input));
  assert.equal(initial.totalEntries,0);assert.deepEqual(initial.target,target);
  for(const mode of modes){
   assert.equal(initial.modes[mode].netRealizedUsdt,'0');
   assert.equal(initial.modes[mode].allHistory.netRealizedUsdt,'-0.5');
  }
  assert.equal(JSON.stringify(input),before);
  for(const mutate of [x=>delete x.histories['demo-futures'],x=>x.histories.demo.trades=[],
   x=>x.histories.demo.trades[0].profit_abs=null,x=>x.histories['demo-futures'].observedAt='2026-09-27T23:59:59Z']){
   const bad=structuredClone(input);mutate(bad);const failed=buildSprintReview(bad);
   assert.equal(failed.evidenceComplete,false);assert.equal(failed.totalEntries,null);
   assert.throws(()=>assertFreshResetReview(failed));
  }
 }
});
