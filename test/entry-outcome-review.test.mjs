import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildEntryOutcomeReview,outcomeMarkdown} from '../scripts/entry-outcome-review.mjs';
function fixture(){
 const mode='demo',pair='BTC/USDT',sid='00000000-0000-4000-8000-000000000001',id=createHash('sha256').update(sid).digest('hex').slice(0,32),tag='codex-'+id;
 const base=Date.parse('2026-09-14T00:00:00Z'),observedAt='2026-09-14T02:00:00Z',fp='a'.repeat(64),sha='b'.repeat(64);
 const model={modelFingerprint:fp,predictionSha256:sha,snapshotId:sid,issuedAt:new Date(base+500).toISOString(),usedForEntryDecision:true};
 const trade={trade_id:1,pair,enter_tag:tag,is_open:false,is_short:false,open_timestamp:base+2000,close_timestamp:base+60000,
  profit_abs:'-0.1',open_rate:50,close_rate:50.1,stake_amount:50,leverage:1,trading_mode:'spot',fee_open_cost:'.05',fee_close_cost:'.05',exit_reason:'stoploss_on_exchange',
  orders:[{order_id:'one',pair,ft_order_tag:tag,ft_order_side:'buy',ft_is_entry:true,status:'closed',is_open:false,filled:1,cost:50,amount:1,remaining:0,order_filled_timestamp:base+1500}]};
 const input={goal:{schemaVersion:1,id:'test',source:'freqtrade-demo',startedAt:new Date(base).toISOString(),ruleVersion:'kronos-direction-v12',modelFingerprint:fp,targetPerMode:30,deadline:null,
  modes:{demo:{excludedTradeIds:[],baselineTradeCount:0},'demo-futures':{excludedTradeIds:[],baselineTradeCount:0}}},observedAt,
  histories:{demo:{source:'freqtrade-demo',historyComplete:true,observedAt,trades:[trade]},'demo-futures':{source:'freqtrade-demo',historyComplete:true,observedAt,trades:[]}},
  journals:{demo:[{id,tag,at:new Date(base+1000).toISOString(),status:'pending',action:'buy',pair,tradeId:null,purpose:'strategy',ruleVersion:'kronos-direction-v12',snapshotId:sid,model},
   {id,tag,at:new Date(base+2500).toISOString(),status:'submitted',action:'buy',pair,tradeId:1}],'demo-futures':[]}};
 const plan={tag,pair,snapshotId:sid,isShort:false,model,nativeEntryGuard:{mode,pair,snapshotId:sid,predictionSha256:sha,forecastClose:'50.05',bridgeQuotePrice:'50',requiredPriceSpaceBps:'50'},entryConfirmation:{predictionSha256:sha,forecastClose:'50.05'}};
 return {input,plans:{demo:{[tag]:plan}},profitReviews:{demo:{status:'observed',asOf:observedAt,strategy:{trades:[{tradeId:1,pair,tag,openPnlSamples:2,sampledPeakNetUsdt:'.3'}]}}}};
}
test('actual loss remains net once, original cost gap and positive sampled peak stay descriptive',()=>{
 const r=buildEntryOutcomeReview(fixture()),m=r.modes.demo;
 assert.equal(r.status,'observed');assert.equal(m.summary.netRealizedUsdt,'-0.1');assert.equal(m.summary.losingTrades,1);
 assert.equal(m.diagnostics.engineRecordedFeesUsdt,'0.1');assert.equal(m.rows[0].forecastAtEntryBps,'10');
 assert.equal(m.diagnostics.forecastDidNotCoverCostAndBuffer,1);assert.equal(m.diagnostics.lossesAfterPositiveSample,1);
 assert.equal(m.diagnostics.favorableExitPriceButNetLoss,1);assert.match(outcomeMarkdown(r),/實际損益未經反事實過濾/);
});
test('missing or mismatched plan cannot create known cost coverage or remove an actual loss',()=>{
 for(const kind of ['missing','snapshot','pin']){const f=fixture(),p=Object.values(f.plans.demo)[0];
  if(kind==='missing')f.plans={};if(kind==='snapshot')p.snapshotId='bad';if(kind==='pin')p.model={...p.model,predictionSha256:'c'.repeat(64)};
  const m=buildEntryOutcomeReview(f).modes.demo;assert.equal(m.diagnostics.costEvidenceKnown,0);assert.equal(m.summary.netRealizedUsdt,'-0.1');}
});
test('missing fees and samples stay unavailable, later peak cannot leak into an earlier audit',()=>{
 const f=fixture();delete f.input.histories.demo.trades[0].fee_close_cost;
 f.profitReviews.demo.asOf='2026-09-14T03:00:00Z';const m=buildEntryOutcomeReview(f).modes.demo;
 assert.equal(m.diagnostics.engineRecordedFeesUsdt,null);assert.equal(m.rows[0].sampledPeakNetUsdt,null);assert.equal(m.diagnostics.lossesWithoutSamples,1);
});
test('missing actual history is incomplete rather than an apparent zero loss or zero win rate',()=>{
 const f=fixture();f.input.histories.demo.historyComplete=false;const r=buildEntryOutcomeReview(f);
 assert.equal(r.status,'incomplete_evidence');assert.equal(r.modes.demo.summary,null);
});
test('open position never becomes realized profit or a win',()=>{
 const f=fixture();Object.assign(f.input.histories.demo.trades[0],{is_open:true,profit_abs:'.8',close_timestamp:null});
 const m=buildEntryOutcomeReview(f).modes.demo;assert.equal(m.summary.closedTrades,0);assert.equal(m.summary.winningTrades,0);assert.equal(m.rows[0].netRealizedUsdt,null);
});
test('equal forecast cost coverage fails strict gate and missing sample never means no positive peak',()=>{
 const f=fixture();const p=Object.values(f.plans.demo)[0];p.nativeEntryGuard.requiredPriceSpaceBps='10';f.profitReviews={};
 const m=buildEntryOutcomeReview(f).modes.demo;assert.equal(m.rows[0].forecastCoveredCostAndBuffer,false);assert.equal(m.diagnostics.lossesWithSamplesButNoPositiveSample,0);assert.equal(m.diagnostics.lossesWithoutSamples,1);
});
test('short forecast and favorable short exit use reversed price direction without reversing net accounting',()=>{
 const f=fixture(),p=Object.values(f.plans.demo)[0],t=f.input.histories.demo.trades[0],pair='BTC/USDT:USDT';
 f.input.histories['demo-futures']={...f.input.histories.demo};f.input.histories.demo={...f.input.histories.demo,trades:[]};
 f.input.journals['demo-futures']=f.input.journals.demo;f.input.journals.demo=[];
 Object.assign(t,{pair,is_short:true,trading_mode:'futures',close_rate:49.9});
 for(const o of t.orders){o.pair=pair;o.ft_order_side='sell';}
 for(const j of f.input.journals['demo-futures']){j.pair=pair;j.action='open-short';j.leverage=1;}
 Object.assign(p,{pair,isShort:true});Object.assign(p.nativeEntryGuard,{pair,mode:'demo-futures',forecastClose:'49.95'});p.entryConfirmation.forecastClose='49.95';
 f.plans={'demo-futures':f.plans.demo};f.profitReviews={};
 const m=buildEntryOutcomeReview(f).modes['demo-futures'];assert.equal(m.summary.netRealizedUsdt,'-0.1');
 assert.equal(m.rows[0].forecastAtEntryBps,'10');assert.equal(m.diagnostics.favorableExitPriceButNetLoss,1);
});
