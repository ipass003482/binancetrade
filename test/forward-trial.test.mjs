import test from 'node:test';
import assert from 'node:assert/strict';
import {buildForwardTrialReport,MIN_FORWARD_CLOSED_TRADES} from '../src/forward-trial.mjs';

const startedAt='2026-09-10T10:00:00Z',base=Date.parse(startedAt),asOf='2026-09-10T20:00:00Z';
const trade=(n,net=1,extra={})=>({trade_id:n,pair:'BTC/USDT',is_short:false,is_open:false,
 enter_tag:'strategy-'+n,open_timestamp:base+n*60000,close_timestamp:base+n*60000+30000,
 profit_abs:net,stake_amount:50,leverage:1,...extra});
const entry=t=>({id:'intent-'+t.trade_id,at:new Date(t.open_timestamp).toISOString(),status:'submitted',
 action:t.is_short?'open-short':'buy',pair:t.pair,tag:t.enter_tag,tradeId:t.trade_id});
function report(trades=[],{trial={},journal=trades.map(entry),...extra}={}){
 return buildForwardTrialReport({trial:{version:'forward-v1',startedAt,mode:'demo',source:'freqtrade-demo',historyComplete:true,
  strategyTags:trades.map(t=>t.enter_tag),probeTags:[],...trial},trades,journal,asOf,...extra});
}

test('real closed results remain visible when current positions are zero; fee accounting is not doubled',()=>{
 const r=report([trade(1,'1.2',{fee_open_cost:10,fee_close_cost:10}),trade(2,'-0.4'),trade(3,'0')]);
 assert.equal(r.strategy.openTrades,0);assert.equal(r.strategy.closedTrades,3);
 assert.equal(r.strategy.netRealizedUsdt,'0.8');assert.equal(r.strategy.averageNetUsdt,'0.26666666666666666667');
 assert.equal(r.strategy.profitFactor,3);assert.equal(r.strategy.winRate,1/3);
 assert.equal(r.validation.status,'collecting_sample');assert.deepEqual(r.warnings,[]);
});

test('open mark-to-market never enters realized returns',()=>{
 const r=report([trade(1,-1),trade(2,999,{is_open:true,close_timestamp:null})]);
 assert.equal(r.strategy.openTrades,1);assert.equal(r.strategy.closedTrades,1);
 assert.equal(r.strategy.netRealizedUsdt,'-1');assert.deepEqual(r.strategy.openTradeIds,[2]);
});

test('probe entries and closures are separated from strategy statistics',()=>{
 const r=report([trade(1,-1),trade(2,500,{enter_tag:'connection-probe'})],{
  trial:{strategyTags:['strategy-1'],probeTags:['connection-probe']}});
 assert.equal(r.strategy.closedTrades,1);assert.equal(r.strategy.netRealizedUsdt,'-1');
 assert.equal(r.probes.closedTrades,1);assert.equal(r.probes.netRealizedUsdt,'500');
 assert.equal(r.validation.validStrategyClosedTrades,1);assert.equal(r.validation.preliminarySampleAvailable,false);
});

test('dates alone never attribute old-version or manual trades to the trial',()=>{
 const trades=[trade(1,1),trade(2,999,{open_timestamp:base-1}),trade(3,999,{enter_tag:'old-version'}),trade(4,999)];
 const r=report(trades,{trial:{strategyTags:['strategy-1','strategy-2'],excludedTradeIds:[4]}});
 assert.equal(r.strategy.closedTrades,1);assert.equal(r.strategy.netRealizedUsdt,'1');
 assert.deepEqual(r.ignored.map(item=>item.reason),['opened_before_trial','unattributed_entry_tag','explicitly_excluded']);
 assert.ok(r.warnings.some(item=>item.code==='UNATTRIBUTED_TRIAL_TRADE'));assert.equal(r.validation.evidenceComplete,false);
 const mismatch=report([trade(1,1,{trial_version:'other'})]);
 assert.equal(mismatch.strategy.closedTrades,0);assert.equal(mismatch.ignored[0].reason,'version_mismatch');
});

test('missing or invalid realized P&L is never silently zero',()=>{
 for(const profit_abs of [undefined,null,'',true,NaN,Infinity,'NaN']){
  const r=report([trade(1,2),trade(2,profit_abs,{profit_abs})]);
  assert.equal(r.strategy.closedTrades,2);assert.equal(r.strategy.netRealizedUsdt,null);
  assert.equal(r.strategy.averageNetUsdt,null);assert.equal(r.strategy.winRate,null);assert.equal(r.strategy.profitFactor,null);
  assert.equal(r.validation.status,'incomplete_evidence');assert.ok(r.warnings.some(item=>item.code==='INVALID_NET_PNL'));
 }
});

test('unknown submission stays unresolved even when the reported trade matches',()=>{
 const t=trade(1),pending={...entry(t),status:'pending'},unknown={id:pending.id,at:asOf,status:'unknown'};
 const r=report([t],{journal:[pending,unknown]});
 assert.equal(r.journal.unresolvedSubmissions.length,1);assert.equal(r.journal.unresolvedSubmissions[0].tradeId,1);
 assert.equal(r.journal.unresolvedSubmissions[0].tag,t.enter_tag);assert.equal(r.validation.status,'incomplete_evidence');
 const reconciled=report([t],{journal:[pending,unknown,{id:pending.id,at:asOf,status:'reconciled',tradeId:1}]});
 assert.deepEqual(reconciled.journal.unresolvedSubmissions,[]);assert.equal(reconciled.validation.evidenceComplete,true);
});

test('unresolved old submissions and submitted entries missing from full history are explicit',()=>{
 const old={id:'old-intent',at:'2026-09-09T00:00:00Z',status:'pending',action:'buy',tag:'old',pair:'BTC/USDT'};
 const r=report([],{journal:[old,entry(trade(1))],trial:{strategyTags:['strategy-1']}});
 assert.equal(r.journal.unresolvedSubmissions.length,1);
 assert.ok(r.warnings.some(item=>item.code==='SUBMITTED_TRADE_MISSING_OR_AMBIGUOUS'));
 assert.equal(r.validation.evidenceComplete,false);
});

test('at least 30 complete strategy closures permit only an explicitly preliminary sample',()=>{
 assert.equal(MIN_FORWARD_CLOSED_TRADES,30);
 const trades=Array.from({length:30},(_,index)=>trade(index+1,index%2?'-1':'2'));
 const r=report(trades);
 assert.equal(r.validation.status,'preliminary_sample_available');assert.equal(r.validation.preliminarySampleAvailable,true);
 assert.equal(r.validation.stableProfitabilityValidated,false);assert.equal(r.validation.profitabilityValidationComplete,false);
 assert.equal(r.validation.promotionAuthorized,false);assert.equal(r.validation.remainingClosedTrades,0);
 assert.equal(report(trades.slice(1)).validation.status,'collecting_sample');
 assert.equal(report(trades.map(t=>({...t,profit_abs:-1}))).validation.status,'preliminary_sample_available');
 assert.equal(report(trades,{journal:[]}).validation.status,'incomplete_evidence');
});

test('incomplete history or non-Demo source cannot produce full-sample net results',()=>{
 for(const patch of [{historyComplete:false},{historyComplete:undefined},{source:'backtest'},{source:undefined}]){
  const r=report([trade(1,2)],{trial:patch});
  assert.equal(r.validation.status,'incomplete_evidence');assert.equal(r.strategy.netRealizedUsdt,null);
  assert.equal(r.strategy.observedSubset.netRealizedUsdt,'2');assert.equal(r.strategy.pnlComplete,false);
 }
});

test('duplicates, malformed chronology and mode mismatch invalidate evidence',()=>{
 const t=trade(1),duplicate=report([t,t],{trial:{strategyTags:['strategy-1']},journal:[entry(t)]});
 assert.equal(duplicate.validation.status,'incomplete_evidence');assert.equal(duplicate.strategy.netRealizedUsdt,null);
 for(const patch of [{open_timestamp:null},{close_timestamp:base-1},{open_timestamp:Date.parse(asOf)+1},
  {pair:'BTC/USDT:USDT'},{quote_currency:'USDC'},{is_open:undefined},{has_open_orders:true}]){
  assert.equal(report([trade(1,1,patch)]).validation.status,'incomplete_evidence');
 }
 const futures=report([trade(1,-1,{pair:'BTC/USDT:USDT',is_short:true})],{trial:{mode:'demo-futures'}});
 assert.equal(futures.strategy.netRealizedUsdt,'-1');assert.equal(futures.validation.evidenceComplete,true);
});

test('no trades has no win rate or profit factor and does not pass validation',()=>{
 const r=report([]);assert.equal(r.strategy.closedTrades,0);assert.equal(r.strategy.netRealizedUsdt,'0');
 assert.equal(r.strategy.winRate,null);assert.equal(r.strategy.profitFactor,null);
 assert.equal(r.validation.status,'awaiting_closed_trades');
 const wins=report([trade(1,2)]);assert.equal(wins.strategy.profitFactor,null);assert.equal(wins.strategy.profitFactorReason,'no_losing_trades');
});

test('manifest conflicts and invalid trial identity fail rather than infer ownership',()=>{
 for(const trial of [{mode:'live'},{version:''},{startedAt:'invalid'},{startedAt:'2027-01-01T00:00:00Z'},
  {strategyTags:['x'],probeTags:['x']},{strategyTags:['x','x']},{excludedTradeIds:[null]}])
  assert.throws(()=>report([],{trial}),/FORWARD_TRIAL_/);
});

test('report has no input mutations, ambient clock dependency, or raw secret payloads',()=>{
 const t=trade(1,1,{apiKey:'NO_EXPORT',orders:[{order_id:'123',secret:'NO_EXPORT'}]}),journal=[{...entry(t),secret:'NO_EXPORT'}];
 const before=JSON.stringify({t,journal}),one=report([t],{journal}),two=report([t],{journal});
 assert.deepEqual(one,two);assert.equal(JSON.stringify({t,journal}),before);
 assert.equal(JSON.stringify(one).includes('NO_EXPORT'),false);assert.deepEqual(one.strategy.trades[0].orderIds,['123']);
});
