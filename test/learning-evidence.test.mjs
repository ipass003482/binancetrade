import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {learningRow,estimatedNetPayoff,chronologicalSplit,summarizeLearning} from '../src/learning-evidence.mjs';
import {canonical} from '../src/strategy-version.mjs';
import {publishLearning} from '../scripts/readiness-review.mjs';

const boundary=1800000000000,iso=ms=>new Date(ms).toISOString();
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(mode='demo',isShort=false){
 const source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
  pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',snapshotId='12345678-1234-1234-1234-123456789abc',
  id=hash(snapshotId).slice(0,32),tag='codex-'+id;
 const clock=at=>({mode,source:source+(mode==='demo'?'/api/v3/time':'/fapi/v1/time'),
  requestStartedAt:boundary+at,receivedAt:boundary+at+100,serverTime:boundary+at+50-700});
 const candles=Array.from({length:96},(_,i)=>({openTime:boundary-(96-i)*300000,
  closeTime:boundary-(95-i)*300000-1,open:'100',high:'101',low:'99',close:'100',volume:'100'}));
 const verified=mode==='demo'?{verifiedSpot:true}:{verifiedFutures:true};
 const snapshot={id:snapshotId,mode,timeframe:'5m',decisionEngine:'rules',ruleVersion:'atr15m-forward-v10',
  createdAt:iso(boundary+1100),completedAt:iso(boundary+5000),candleBoundary:boundary,clock:clock(1000),
  markets:[{pair,source,...verified,candles}]};
 const plan={purpose:'strategy',ruleVersion:snapshot.ruleVersion,timeframe:'5m',snapshotId,tag,pair,isShort,
  createdAt:iso(boundary+10000),maxHoldingSeconds:14400,stopFraction:.01,targetFraction:.02,riskCostFraction:.002,
  entryConfirmation:{version:'retest-reclaim-v1',confirmationAt:boundary,signalAt:boundary-300000,close:100,trigger:100}};
 const quote={source,mode,pair,...verified,clock:clock(8000),fetchedAt:iso(boundary+9000),bid:'99.9',ask:'100.1'};
 const cost={status:'ok',mode,pair,source,observedAt:iso(boundary+5000),estimatedRoundTripCostBps:20};
 const contract={schemaVersion:1,mode,sources:[]},version={...contract,fingerprint:hash(JSON.stringify(canonical(contract))),capturedAt:iso(boundary+9100)};
 const trade={trade_id:1,pair,enter_tag:tag,is_short:isShort,is_open:false,open_fill_timestamp:boundary+9500,
  open_timestamp:boundary+10200,close_timestamp:boundary+1800000,open_rate:isShort?99.8:100.2,amount:1,profit_abs:'.75',exit_reason:'rules_target'};
 const action=mode==='demo'?'buy':isShort?'open-short':'open-long';
 const records=[{id,tag,status:'pending',snapshotId,pair,ruleVersion:plan.ruleVersion,purpose:'strategy',action,at:iso(boundary+10010)},
  {id,tag,status:'submitted',pair,tradeId:1,action,at:iso(boundary+10300)}];
 return {mode,trade,plan,snapshot,quote,cost,version,records,asOf:iso(boundary+2000000)};
}

test('entry evidence uses archived exchange clock uncertainty instead of comparing local timestamps with exchange fills',()=>{
 const f=fixture(),r=learningRow(f);
 assert.ok(Date.parse(f.plan.createdAt)>f.trade.open_fill_timestamp);
 assert.equal(r.informationAt,boundary+9360);
 assert.equal(r.timing.informationExchangeRange.lower,boundary+9260);
 assert.ok(r.informationAt<r.entryFillAt);
 assert.equal(r.features.estimatedRoundTripCostBps,'20');
 assert.equal(r.outcome.netRealizedUsdt,'0.75');
});

test('clock midpoint before fill is insufficient when its uncertainty upper bound crosses the fill',()=>{
 const f=fixture();f.trade.open_fill_timestamp=boundary+9320;
 assert.throws(()=>learningRow(f),/LEARNING_ENTRY_TIME_OR_FUTURE_DATA/);
});

test('genuinely post-fill evidence is rejected after clock normalization',()=>{
 for(const mutate of [f=>f.plan.createdAt=iso(boundary+11000),f=>f.records[0].at=iso(boundary+11000),
  f=>f.snapshot.completedAt=iso(boundary+11000),f=>f.cost.observedAt=iso(boundary+11000)]){
  const f=fixture();mutate(f);assert.throws(()=>learningRow(f),/LEARNING_ENTRY_TIME_OR_FUTURE_DATA/);
 }
});

test('missing, wrong-source, stale, or excessive-skew clocks cannot be repaired using current time or supplied offset fields',()=>{
 for(const mutate of [f=>delete f.quote.clock,f=>f.quote.clock.source='https://example.test/time',
  f=>f.snapshot.clock.mode='demo-futures',f=>f.quote.clock.serverTime-=3000,
  f=>f.quote.clock.receivedAt-=70000]){
  const f=fixture();mutate(f);assert.throws(()=>learningRow(f),/LEARNING_ENTRY_CLOCK_INVALID/);
 }
 const f=fixture();f.quote.clock.offsetMs=999999;f.quote.clock.uncertaintyMs=0;
 assert.equal(learningRow(f).informationAt,boundary+9360);
});

test('unclosed, shifted, or malformed feature candles are never accepted',()=>{
 for(const mutate of [f=>f.snapshot.markets[0].candles.at(-1).closeTime++,
  f=>f.snapshot.markets[0].candles[10].openTime++,f=>f.snapshot.candleBoundary+=300000,
  f=>f.snapshot.markets[0].candles[20].high='1']){
  const f=fixture();mutate(f);assert.throws(()=>learningRow(f));
 }
});

test('actual outcomes and fill execution fields cannot leak into predictor features',()=>{
 const f=fixture(),base=learningRow(f);
 f.trade.profit_abs=-4;f.trade.open_rate=110;f.trade.close_timestamp+=200000;f.trade.exit_reason='rules_stop';
 f.trade.profit_max=200;const changed=learningRow(f);
 assert.deepEqual(changed.features,base.features);
 assert.notDeepEqual(changed.outcome,base.outcome);
 assert.notDeepEqual(changed.execution,base.execution);
 f.trade.is_open=true;f.trade.profit_abs=999;assert.equal(learningRow(f).outcome,null);
});

test('payoff arithmetic includes estimated costs but does not claim a predicted win rate or profit',()=>{
 const p=estimatedNetPayoff(fixture().plan);
 assert.equal(p.netRewardRisk,'1.5');assert.equal(p.twoOutcomeBreakEvenWinRate,'0.4');
 assert.equal(estimatedNetPayoff({...fixture().plan,riskCostFraction:.03}).twoOutcomeBreakEvenWinRate,null);
 for(const stopFraction of [0,-1,Infinity,'NaN'])assert.throws(()=>estimatedNetPayoff({...fixture().plan,stopFraction}));
});

test('futures long and short execution slippage uses the correct sign; spot cannot be short',()=>{
 for(const short of [false,true]){
  const r=learningRow(fixture('demo-futures',short));
  assert.equal(r.direction,short?'short':'long');assert.ok(Number(r.execution.adverseEntrySlippageBps)>0);
 }
 assert.throws(()=>learningRow(fixture('demo',true)),/LEARNING_TRADE_IDENTITY/);
});

test('reconciled submissions retain their exact pending intent and actual fill outcome',()=>{
 const f=fixture(),submitted=f.records.pop();f.records.push({...submitted,status:'unknown'});
 f.records.push({id:submitted.id,status:'reconciled',tradeId:1,action:'buy',at:submitted.at,
  proof:{orderId:'test-order',filled:'1',grossQuoteCost:'100.2',amountStep:'0.1'}});
 assert.equal(learningRow(f).outcome.netRealizedUsdt,'0.75');
 f.records.at(-1).tradeId=2;assert.throws(()=>learningRow(f),/LEARNING_JOURNAL_IDENTITY/);
});

test('mismatched attribution, duplicate settlements, and invalid manifests cannot create learning labels',()=>{
 for(const mutate of [f=>f.records.push({...f.records[1]}),f=>f.records[1].action='open-short',
  f=>f.trade.enter_tag='codex-'+'f'.repeat(32),f=>f.version.mode='demo-futures',
  f=>f.version.fingerprint='f'.repeat(64),f=>f.quote.source='https://api.binance.com']){
  const f=fixture();mutate(f);assert.throws(()=>learningRow(f));
 }
});

test('overlong closed trades remain in actual accounting but are excluded from the normal-execution split',()=>{
 const f=fixture();f.trade.close_timestamp=boundary+20*3600000;f.asOf=iso(boundary+21*3600000);
 const row=learningRow(f),r=summarizeLearning([row],[],f.asOf,{minClosedTrades:2,minCalendarDays:1});
 assert.equal(r.cohorts[0].netRealizedUsdt,'0.75');assert.equal(r.cohorts[0].exceedsPlannedHolding,1);
 assert.equal(r.cohorts[0].split.eligibleRows,0);assert.equal(r.promotionAuthorized,false);
});

test('chronological split purges unavailable labels and never randomly mixes whole entry windows',()=>{
 const rows=Array.from({length:10},(_,i)=>({...learningRow(fixture()),key:'demo:'+i,
  featureStartAt:boundary+i*86400000-8*3600000,featureAsOf:boundary+i*86400000-1,
  entryFillAt:boundary+i*86400000+9500,outcome:{closedAt:boundary+i*86400000+3600000,profitable:!!(i%2),exceedsPlannedHolding:false}}));
 rows[7].outcome.closedAt=rows[8].featureStartAt;
 const r=chronologicalSplit(rows,{minRows:10,minDays:1});
 assert.deepEqual(r.testKeys,['demo:8','demo:9']);assert.deepEqual(r.purgedKeys,['demo:7']);
 assert.ok(r.trainKeys.every(k=>!r.testKeys.includes(k)));assert.equal(r.modelTrained,false);
 rows.push({...rows[0]});assert.throws(()=>chronologicalSplit(rows),/SPLIT_COHORT_MIXED_OR_DUPLICATE/);
});

const publicationOptions={root:'root',target:'target',directory:'archive',histories:{},asOf:iso(boundary),thresholds:{}};
test('optional learning collection failure is contained and replaces stale optional reports without account reads',async()=>{
 const writes=[];
 const r=await publishLearning(publicationOptions,{collect:async()=>{throw Error('JOURNAL_INCOMPLETE');},
  json:async(path,value)=>writes.push({path,value}),write:async(path,value)=>writes.push({path,value}),
  read:async()=>{throw Error('unexpected read');}});
 assert.equal(r.status,'unavailable');assert.equal(r.promotionAuthorized,false);
 assert.equal(writes.length,2);assert.ok(writes.every(w=>!w.path.includes('latest')));
 assert.equal(writes.find(w=>w.path.endsWith('.json')).value.status,'unavailable');
});

test('optional archive and fallback write failures cannot reject the account review',async()=>{
 const learning=summarizeLearning([],[],iso(boundary),{minClosedTrades:2,minCalendarDays:1});
 const r=await publishLearning(publicationOptions,{collect:async()=>learning,read:async()=>Buffer.from('source'),
  json:async()=>{throw Error('DISK_WRITE_FAILED');},write:async()=>{throw Error('DISK_WRITE_FAILED');}});
 assert.equal(r.status,'unavailable');
});

test('available learning publication archives the feature extractor dependencies and never grants promotion',async()=>{
 const writes=[],learning=summarizeLearning([learningRow(fixture())],[],iso(boundary),{minClosedTrades:2,minCalendarDays:1});
 const r=await publishLearning(publicationOptions,{collect:async()=>learning,read:async path=>Buffer.from('source '+path),
  json:async(path,value)=>writes.push({path,value}),write:async(path,value)=>writes.push({path,value})});
 assert.equal(r.status,'available');assert.equal(r.rows,1);assert.equal(r.promotionAuthorized,false);
 const sources=writes.find(w=>w.path.endsWith('learning-extractor-sources.json')).value;
 assert.ok(sources.some(s=>s.path==='src/research-profile.mjs'));
 assert.ok(sources.some(s=>s.path==='src/exchange-clock.mjs'));
 assert.ok(sources.every(s=>s.sha256===hash(s.source)));
});
