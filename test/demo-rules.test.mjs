import test from 'node:test';
import assert from 'node:assert/strict';
import { demoRuleDecision,legacyDemoRuleDecision,closed15mAtr,demoRiskStake,evaluateDemoEntryQuality,V11_RULE_VERSION as DEMO_RULE_VERSION,V10_RULE_VERSION,DEMO_PARAMETERS,v11ModelRuleDecision as modelRuleDecision } from '../src/demo-rules.mjs';
import {syntheticModelEvidence} from './fixtures.mjs';
import { featureFrame,decideFrame } from '../src/atr-experiment.mjs';
import { loadPolicy } from '../src/config.mjs';
import { evaluateEntryQuality } from '../src/entry-quality.mjs';
const B=Date.parse('2026-09-10T00:00:00Z');
function breakout(short=false,at=B){return Array.from({length:96},(_,i)=>{const p=i<94?100+i*.005:i===94?103:104,c=short?200-p:p;
 return {openTime:at-(96-i)*300000,closeTime:at-(95-i)*300000-1,open:String(c),high:String(i===95&&short?100:c+.5),low:String(i===95&&!short?100:c-.5),close:String(c),volume:'10'};});}
test('live candidate B matches offline candidate B for long/short and cost gates',()=>{
 for(const short of [false,true])for(const required of [0,60,1000]){
  const candles=breakout(short,B,'5m'),pair='BTC/USDT:USDT',mode='demo-futures',cost={status:'ok',requiredPriceSpaceBps:String(required)};
  const actual=legacyDemoRuleDecision({candles,timeframe:'5m',mode,pair,cost,now:B});
  const expected=decideFrame(featureFrame({candles,mode,pair,now:B}),'atr15m',required);
  assert.equal(actual.version,'atr15m-risk-v4');
  assert.equal(actual.action,expected.action);
  if(actual.action!=='hold'){assert.equal(actual.stopFraction,expected.stopFraction);assert.equal(actual.targetFraction,expected.targetFraction);assert.equal(actual.atrTimeframe,'15m');}
 }
});

function input(candles=breakout(),mode='demo',action=mode==='demo-futures'?'open-long':'buy'){
 const pair=mode==='demo-futures'?'BTC/USDT:USDT':'BTC/USDT',marketId=(mode==='demo-futures'?'futures:':'spot:')+pair;
 const snapshot={mode,timeframe:'5m',createdAt:new Date(B).toISOString(),candleBoundary:B,
  markets:[{pair,candles,verifiedSpot:mode!=='demo-futures',verifiedFutures:mode==='demo-futures'}],
  evidence:[{id:marketId,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}]};
 return {snapshot,proposal:{pair,action,evidenceIds:[marketId]}};
}
const quality=(snapshot,proposal)=>evaluateDemoEntryQuality(snapshot,proposal,B);
const decision=(candles=breakout(),extra={})=>demoRuleDecision({candles,timeframe:'5m',mode:'demo',pair:'BTC/USDT',
 cost:{status:'ok',requiredPriceSpaceBps:'0'},now:B,...extra});

test('v9 requires a real confirmation-bar retest, supports exact touch, and preserves the fixed trigger',()=>{
 for(const short of [false,true]){
  const rows=breakout(short),args={mode:'demo-futures',pair:'BTC/USDT:USDT'},initial=decision(rows,args);
  assert.equal(initial.entryConfirmation.version,'retest-reclaim-v1');
  const key=short?'high':'low',trigger=initial.trigger;
  rows.at(-1)[key]=String(trigger);
  const exact=decision(rows,args);
  assert.equal(exact.action,short?'open-short':'open-long');
  assert.equal(exact.entryConfirmation.retestExtreme,trigger);
  rows.at(-1)[key]=String(trigger+(short?-1:1)*.000001);
  const noTouch=decision(rows,args);
  assert.equal(noTouch.action,'hold');assert.ok(noTouch.reasons.includes('DEMO_BREAKOUT_RETEST_REQUIRED'));
  assert.equal(noTouch.directionChecks.find(x=>x.action===(short?'open-short':'open-long')).breakout.trigger,trigger);
  rows.at(-2)[key]=String(trigger+(short?1:-1));
  rows.at(-1)[key]=short?'96.5':'103.5';
  assert.equal(decision(rows,args).action,'hold','a breakout-bar retest cannot replace a confirmation-bar retest');
 }
});

test('v5 fixes a traceable parameter set and only completed 15m ATR sizes exits',()=>{
 assert.equal(V10_RULE_VERSION,'atr15m-forward-v10');assert.ok(Object.isFrozen(DEMO_PARAMETERS));
 assert.equal(DEMO_PARAMETERS.breakoutLookbackBars,12);assert.equal(DEMO_PARAMETERS.relativeVolumeMinimum,.8);
 const candles=breakout(),r=decision(candles),atr15=closed15mAtr(candles,B);
 assert.equal(r.action,'buy');assert.equal(r.version,V10_RULE_VERSION);assert.equal(r.atr15,atr15);
 assert.equal(r.targetFraction,2*atr15/104);assert.equal(r.stopFraction,Math.min(atr15/104,.02));
 assert.equal(r.maxHoldingBars,48);assert.equal(r.maxHoldingSeconds,14400);
 assert.equal(r.directionChecks[0].breakout.lookbackBars,12);
 assert.equal(r.directionChecks[0].breakout.bufferAtr,.1);
});

test('v5 requires 1h direction but records adverse 4h context for both long and short',()=>{
 for(const short of [false,true]){
  const candles=breakout(short),opposite=short?90:110;
  candles[47]={...candles[47],open:String(opposite),high:String(opposite+.5),low:String(opposite-.5),close:String(opposite)};
  const {snapshot,proposal}=input(candles,'demo-futures',short?'open-short':'open-long');
  const prior=evaluateEntryQuality({snapshot,proposal,analyst:{style:'active'},now:B});
  assert.ok(prior.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
  const q=quality(snapshot,proposal);assert.equal(q.eligible,true);
  assert.equal(q.metrics.directionPolicy,'1h_required_4h_reference');
  assert.ok(short?Number(q.metrics.return4hPct)>0:Number(q.metrics.return4hPct)<0);
  const r=decision(candles,{mode:'demo-futures',pair:proposal.pair});assert.equal(r.action,proposal.action);
  const mismatch=short?95:105;
  candles[83]={...candles[83],open:String(mismatch),high:String(mismatch+.5),low:String(mismatch-.5),close:String(mismatch)};
  const blocked=quality(snapshot,proposal);assert.ok(blocked.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
 }
});

test('v5 volume threshold accepts exactly .8 and rejects below it or undefined baseline',()=>{
 for(const [volume,ratio] of [['8','0.8'],['7.999','0.7999'],['0','0']]){
  const candles=breakout();candles.at(-1).volume=volume;
  const {snapshot,proposal}=input(candles),r=quality(snapshot,proposal);
  assert.equal(r.eligible,volume==='8');assert.equal(r.metrics.volumeVsPrior19,ratio);
  assert.equal(r.reasons.includes('ENTRY_RELATIVE_VOLUME_BELOW_DEMO_MIN'),volume!=='8');
 }
 const candles=breakout();for(const c of candles.slice(-20,-1))c.volume='0';
 const {snapshot,proposal}=input(candles),r=quality(snapshot,proposal);
 assert.equal(r.eligible,false);assert.ok(r.reasons.includes('ENTRY_RELATIVE_VOLUME_UNDEFINED'));
 assert.equal(r.metrics.volumeVsPrior19,null);
 const near=input();near.snapshot.markets[0].candles.at(-1).volume='7.999999999999999999999999999';
 const rounded=quality(near.snapshot,near.proposal);
 assert.equal(rounded.metrics.volumeVsPrior19,'0.8');
 assert.ok(rounded.reasons.includes('ENTRY_RELATIVE_VOLUME_BELOW_DEMO_MIN'));
});

test('v8 fixes the prior 12-bar trigger before confirmation and excludes both signal and confirmation highs',()=>{
 const candles=breakout();candles[80].high='106';
 const current=decision(candles),legacy=legacyDemoRuleDecision({candles,timeframe:'5m',mode:'demo',pair:'BTC/USDT',cost:{status:'ok',requiredPriceSpaceBps:'0'},now:B});
 assert.equal(current.action,'buy');assert.equal(legacy.action,'hold');
 assert.equal(current.level,100.965);
 assert.equal(current.trigger,current.level+current.atr*.1);
 candles.at(-1).high='105';assert.equal(decision(candles).level,100.965);
 assert.equal(decision(candles).atr,current.atr,'confirmation wick cannot change the breakout ATR');
 candles[82].high='106';assert.equal(decision(candles).action,'hold');
 assert.ok(decision(candles).reasons.includes('DEMO_PREVIOUS_BAR_BREAKOUT_REQUIRED'));
});

test('v8 rejects the first breakout and a wick-only previous breakout in both futures directions',()=>{
 for(const short of [false,true]){
  const rows=breakout(short),pair='BTC/USDT:USDT';
  const setClose=(row,value)=>Object.assign(row,{open:String(value),close:String(value),high:String(value+.5),low:String(value-.5)});
  setClose(rows[94],short?99.53:100.47);
  const r=decision(rows,{mode:'demo-futures',pair});
  assert.equal(r.action,'hold');assert.ok(r.reasons.includes('DEMO_PREVIOUS_BAR_BREAKOUT_REQUIRED'));
  rows[94][short?'low':'high']=short?'90':'110';
  assert.equal(decision(rows,{mode:'demo-futures',pair}).action,'hold');
 }
});

test('v8 next close may hold below the breakout extreme but cannot equal or recross its fixed trigger',()=>{
 for(const short of [false,true]){
  const args={mode:'demo-futures',pair:'BTC/USDT:USDT'},rows=breakout(short),accepted=decision(rows,args),trigger=accepted.trigger;
  const setClose=value=>Object.assign(rows.at(-1),{open:String(value),close:String(value),high:String(value+2),low:String(value-2)});
  setClose(trigger+(short?-.1:.1));
  const confirmed=decision(rows,args);assert.equal(confirmed.action,short?'open-short':'open-long');
  assert.equal(confirmed.entryConfirmation.signalAt,B-300000);assert.equal(confirmed.entryConfirmation.confirmationAt,B);
  for(const value of [trigger,trigger+(short?.01:-.01)]){
   setClose(value);const r=decision(rows,args);assert.equal(r.action,'hold');
   assert.ok(r.reasons.includes('DEMO_BREAKOUT_CONFIRMATION_FAILED'));
  }
 }
});

test('v5 keeps price-space gate and caps stop at 2 percent without fabricating profitability',()=>{
 const candles=breakout();for(const c of candles.slice(0,80)){c.high=String(Number(c.close)+20);c.low=String(Number(c.close)-20);}
 const r=decision(candles);assert.equal(r.action,'buy');assert.equal(r.stopFraction,.02);
 const cost={status:'ok',requiredPriceSpaceBps:String(r.targetFraction*10000)};
 assert.equal(decision(candles,{cost}).action,'buy');
 cost.requiredPriceSpaceBps=String(Number(cost.requiredPriceSpaceBps)+.001);
 const blocked=decision(candles,{cost});assert.equal(blocked.action,'hold');assert.ok(blocked.reasons.includes('BASELINE_PRICE_SPACE_TOO_SMALL'));
 for(const cost of [null,{status:'unavailable'},{status:'ok',requiredPriceSpaceBps:'NaN'}])
  assert.ok(decision(breakout(),{cost}).reasons.includes('BASELINE_COSTS_REQUIRED'));
});

test('v5 retains original evidence, market, data, timing, action and SMA guards',()=>{
 const cases=[
  [({snapshot})=>snapshot.evidence.pop(),'ENTRY_TECHNICAL_EVIDENCE_REQUIRED'],
  [({snapshot})=>snapshot.evidence[0].data.pair='ETH/USDT','ENTRY_MARKET_EVIDENCE_IDENTITY_INVALID'],
  [({proposal})=>proposal.evidenceIds=[],'ENTRY_MARKET_CITATION_REQUIRED'],
  [({snapshot})=>snapshot.markets[0].verifiedSpot=false,'ENTRY_MARKET_UNVERIFIED'],
  [({snapshot})=>snapshot.markets.push({...snapshot.markets[0]}),'ENTRY_MARKET_REQUIRED'],
  [({snapshot})=>snapshot.markets[0].candles[1].openTime+=1,'ENTRY_CANDLES_INVALID'],
  [({snapshot})=>snapshot.markets[0].candles[1].high='0','ENTRY_CANDLES_INVALID'],
  [({snapshot})=>snapshot.createdAt=new Date(B+1).toISOString(),'ENTRY_SNAPSHOT_TIME_INVALID'],
  [({snapshot})=>snapshot.completedAt=new Date(B+1).toISOString(),'ENTRY_SNAPSHOT_TIME_INVALID'],
  [({snapshot})=>snapshot.candleBoundary=B-300000,'ENTRY_CANDLE_NOT_CLOSED'],
  [({snapshot})=>snapshot.candleBoundary=B+300000,'ENTRY_CANDLE_NOT_LATEST_COMPLETED'],
  [({proposal})=>proposal.action='open-short','ENTRY_ACTION_MODE_MISMATCH'],
  [({snapshot})=>{const c=snapshot.markets[0].candles[94];c.open=c.close='140';c.high='141';c.low='139';},'ENTRY_PRICE_NOT_BEYOND_BOTH_SMA']
 ];
 for(const [mutate,reason] of cases){
  const args=input();mutate(args);
  const old=evaluateEntryQuality({...args,analyst:{style:'active'},now:B}),current=quality(args.snapshot,args.proposal);
  assert.ok(old.reasons.includes(reason),reason+' original');assert.ok(current.reasons.includes(reason),reason+' v5');
  assert.equal(current.eligible,false);
 }
 const malformed=input();malformed.snapshot.markets[0].candles=[];
 assert.equal(quality(malformed.snapshot,malformed.proposal).eligible,false);
 assert.throws(()=>evaluateDemoEntryQuality(input().snapshot,input().proposal,NaN),/ENTRY_TIME_INVALID/);
 assert.throws(()=>quality(input().snapshot,{action:'unknown'}),/ENTRY_ACTION_INVALID/);
});

test('v5 fails closed on an unclosed signal, insufficient warmup or non-Demo timeframe',()=>{
 assert.ok(decision(breakout(),{now:B-1}).reasons.includes('BASELINE_CANDLE_NOT_CLOSED'));
 assert.ok(decision(breakout().slice(1)).reasons.includes('BASELINE_WARMUP'));
 for(const patch of [{timeframe:'15m'},{mode:'dry-run'},{mode:'live'}])
  assert.ok(decision(breakout(),patch).reasons.includes('DEMO_RULE_MODE_OR_TIMEFRAME'));
 const args=input();args.snapshot.mode='dry-run';
 assert.ok(quality(args.snapshot,args.proposal).reasons.includes('DEMO_RULE_MODE_OR_TIMEFRAME'));
 assert.equal(evaluateDemoEntryQuality(null,{action:'hold'},B).eligible,true);
 assert.equal(evaluateDemoEntryQuality(null,{action:'sell'},B).eligible,true);
});
test('live ATR ignores incomplete 15m groups and preserves five-minute entry timeframe',()=>{
 const candles=breakout(false,B,'5m'),atr=closed15mAtr(candles,B);
 const rows=[...candles,{openTime:B,closeTime:B+299999,open:'100',high:'10000',low:'1',close:'100',volume:'10'}];
 assert.equal(closed15mAtr(rows,B+300000),atr);
 assert.equal(demoRuleDecision({candles,timeframe:'15m',mode:'demo',cost:{status:'ok',requiredPriceSpaceBps:'0'}}).action,'hold');
});
test('live sizing floors risk cap and reduces stake as stop or costs increase',async()=>{
 const p=await loadPolicy('demo'),cost={status:'ok',estimatedRoundTripCostBps:'30'};
 const a=demoRiskStake({stopFraction:.005},cost,p),b=demoRiskStake({stopFraction:.01},cost,p);
 assert.ok(Number(b)<Number(a));assert.ok(Number(b)*.013<=1);assert.equal(demoRiskStake({stopFraction:.01},cost,p,10),'10.00000000');
 assert.throws(()=>demoRiskStake({stopFraction:.01},{status:'unavailable'},p));
});

function modelInput({mode='demo',direction='long',flat=false}={}){
 const {snapshot}=input(breakout(),mode),market=snapshot.markets[0];
 snapshot.id='synthetic-model-decision';
 if(flat)market.candles=market.candles.map(c=>({...c,open:'100',high:'100.5',low:'99.5',close:'100',volume:'0'}));
 const price=market.candles.at(-1).close;market.bid=price;market.ask=String(Number(price)+.01);
 return {snapshot,pair:market.pair,cost:{status:'ok',requiredPriceSpaceBps:'30',estimatedRoundTripCostBps:'20'},
  modelEvidence:syntheticModelEvidence(snapshot,{direction}),now:B};
}

test('v11 model selects spot long and both futures directions while spot decline or flat forecast holds',()=>{
 for(const [mode,direction,expected] of [['demo','long','buy'],['demo','short','hold'],['demo','hold','hold'],
  ['demo-futures','long','open-long'],['demo-futures','short','open-short'],['demo-futures','hold','hold']]){
  const args=modelInput({mode,direction}),result=modelRuleDecision(args);
  assert.equal(result.action,expected);assert.equal(result.version,DEMO_RULE_VERSION);
  if(expected!=='hold'){
   assert.equal(result.entrySignalEngine,'kronos_pretrained');assert.equal(result.entryConfirmation.version,'kronos-close-path-v1');
   assert.equal(result.entryConfirmation.modelFingerprint,args.modelEvidence.modelFingerprint);
   assert.equal(result.entryConfirmation.predictionSha256,args.modelEvidence.predictionSha256);
   assert.equal(result.maxHoldingSeconds,14400);assert.equal(result.atrTimeframe,'15m');assert.ok(result.stopFraction<=.02);
  }
 }
});

test('v11 removes technical direction, SMA, volume and breakout opinions without fabricating a breakout',()=>{
 for(const direction of ['long','short']){
  const args=modelInput({mode:'demo-futures',direction,flat:true}),result=modelRuleDecision(args);
  const original=demoRuleDecision({candles:args.snapshot.markets[0].candles,timeframe:'5m',mode:'demo-futures',pair:args.pair,cost:args.cost,now:B});
  assert.equal(original.action,'hold');assert.equal(result.action,direction==='long'?'open-long':'open-short');
  assert.equal(result.directionChecks[0].metrics.volumeVsPrior19,null);
  assert.equal(result.directionChecks[0].metrics.technicalIndicatorsRole,'context_only');
  assert.equal(result.entryConfirmation.trigger,undefined);
 }
});

test('v11 current quote and existing cost reserve can veto a formerly sufficient forecast',()=>{
 const args=modelInput(),row=args.modelEvidence.prediction.forecasts[0],target=row.forecastCloses.at(-1);
 assert.equal(modelRuleDecision(args).action,'buy');
 assert.deepEqual(modelRuleDecision({...args,quote:{ask:String(target),bid:String(target-.01)}}).reasons,['MODEL_PRICE_SPACE_TOO_SMALL']);
 const short=modelInput({mode:'demo-futures',direction:'short'}),shortTarget=short.modelEvidence.prediction.forecasts[0].forecastCloses.at(-1);
 assert.deepEqual(modelRuleDecision({...short,quote:{bid:String(shortTarget),ask:String(shortTarget+.01)}}).reasons,['MODEL_PRICE_SPACE_TOO_SMALL']);
 assert.deepEqual(modelRuleDecision({...args,cost:{...args.cost,requiredPriceSpaceBps:'1000'}}).reasons,['MODEL_PRICE_SPACE_TOO_SMALL']);
 for(const cost of [null,{status:'unavailable'}])assert.deepEqual(modelRuleDecision({...args,cost}).reasons,['ENTRY_COSTS_UNAVAILABLE']);
 for(const cost of [{...args.cost,estimatedRoundTripCostBps:'31'},{...args.cost,requiredPriceSpaceBps:'NaN'}])
  assert.equal(modelRuleDecision({...args,cost}).action,'hold');
});

test('v11 fails closed for unavailable or suppressed model and malformed market or forecast evidence',()=>{
 for(const modelEvidence of [null,{status:'unavailable',reason:'MODEL_WORKER_STALE_OR_INVALID'},
  {...modelInput().modelEvidence,entryAllowed:false,reason:'MODEL_REVIEW_SUPPRESSED'}])
  assert.equal(modelRuleDecision({...modelInput(),modelEvidence}).action,'hold');
 for(const mutate of [
  a=>a.snapshot.markets[0].candles.at(-1).high='0',a=>a.snapshot.markets[0].candles[1].openTime++,
  a=>a.snapshot.candleBoundary-=300000,a=>a.snapshot.markets[0].verifiedSpot=false,
  a=>a.snapshot.evidence.pop(),a=>a.snapshot.createdAt=new Date(B+1).toISOString(),
  a=>a.modelEvidence.prediction.forecasts[0].originClose=1,
  a=>a.modelEvidence.prediction.forecasts[0].forecastCloses=['NaN'],
  a=>a.modelEvidence.prediction.forecasts.push({...a.modelEvidence.prediction.forecasts[0]}),
  a=>a.snapshot.markets.push({...a.snapshot.markets[0]})]){
  const args=modelInput();mutate(args);assert.equal(modelRuleDecision(args).action,'hold');
 }
});
