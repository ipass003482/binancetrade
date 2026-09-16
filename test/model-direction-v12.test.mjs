import test from 'node:test';
import assert from 'node:assert/strict';
import {historicalNetEdgeDecision as modelRuleDecision, closed15mAtr, demoRiskStake, DEMO_RULE_VERSION} from '../src/demo-rules.mjs';

// Pure synthetic decision fixtures only: no inference, credentials, broker or orders.
const MS=300000, B=1789347600000, PIN='a'.repeat(64), HASH='b'.repeat(64);
function fixture({mode='demo', short=false, range=1, path}={}){
 const pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT', now=B+6000;
 const market={pair,mode,[mode==='demo'?'verifiedSpot':'verifiedFutures']:true,ask:'100.001',bid:'99.999',
  candles:Array.from({length:96},(_,i)=>({openTime:B-(96-i)*MS,closeTime:B-(96-i)*MS+MS-1,
   open:'100',high:String(100+range/2),low:String(100-range/2),close:'100',volume:'0'}))};
 for(const i of [92,94])market.candles[i].close=String(100+(short||path?.every(v=>Number(v)<100)?1:-1)*Math.min(range/4,.001));
 const snapshot={id:'synthetic-v12-direction-test',mode,timeframe:'5m',candleBoundary:B,
  createdAt:new Date(B+1000).toISOString(),completedAt:new Date(B+2000).toISOString(),markets:[market],
  evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}},
   {id:'technical:'+pair,pair,status:'ok'}]};
 const row={pair,originClose:'100',forecastCloses:path??(short?['99','98','97']:['101','102','103']),
  forecastBarOpens:[B,B+MS,B+2*MS],targetCloseAt:B+3*MS-1,
  rawCostScreenedAction:'hold',advisoryAction:'hold',suppressedByModelReview:false,usedForOrders:false};
 return {snapshot,pair,now,cost:{status:'ok',estimatedRoundTripCostBps:'30',requiredPriceSpaceBps:'60'},
  modelEvidence:{status:'ok',entryAllowed:true,modelFingerprint:PIN,predictionSha256:HASH,
   prediction:{modelFingerprint:PIN,issuedAt:new Date(B+5000).toISOString(),forecasts:[row]}}};
}
const forecast=a=>a.modelEvidence.prediction.forecasts[0];
const holds=a=>assert.equal(modelRuleDecision(a).action,'hold');

test('forecast smaller than costs holds even with ample ATR target; preserve input evidence',()=>{
 const args=fixture({path:['100.01','100.02','100.03']}),before=structuredClone(args),result=modelRuleDecision(args);
 assert.equal(result.action,'hold');assert.deepEqual(result.reasons,['MODEL_FORECAST_COST_SHORTFALL']);
 assert.equal(result.entryPolicyVersion,'forecast-net-edge-v1');
 assert.equal(result.directionChecks[0].costSpace.targetBps,'200');assert.deepEqual(args,before);
});

test('v12 supports spot long and both futures directions while spot short holds',()=>{
 for(const [mode,short,action] of [['demo',false,'buy'],['demo',true,'hold'],
  ['demo-futures',false,'open-long'],['demo-futures',true,'open-short']]){
  const result=modelRuleDecision(fixture({mode,short}));assert.equal(result.action,action);
  if(action!=='hold')assert.ok(Number(result.forecastMoveBps)>0);
 }
});

test('all three forecast closes must be strictly on one side of origin, including the middle bar',()=>{
 for(const path of [['100.01','99.99','100.03'],['99.99','100.01','99.97'],
  ['100','100.02','100.03'],['100.01','100','100.03'],['100.01','100.02','100'],
  ['100','100','100']])holds(fixture({mode:'demo-futures',path}));
});

test('direction consistency does not impose an unrequested monotonic forecast path',()=>{
 assert.equal(modelRuleDecision(fixture({path:['103','101','102']})).action,'buy');
 assert.equal(modelRuleDecision(fixture({mode:'demo-futures',path:['97','99','98']})).action,'open-short');
});

test('final forecast equal to or overtaken by executable ask or bid blocks entry',()=>{
 for(const ask of ['103','103.001'])holds({...fixture(),quote:{ask,bid:'100'}});
 for(const bid of ['97','96.999'])holds({...fixture({mode:'demo-futures',short:true}),quote:{bid,ask:'100'}});
 assert.equal(modelRuleDecision({...fixture(),quote:{ask:'102.999999',bid:'100'}}).action,'hold');
 assert.equal(modelRuleDecision({...fixture({mode:'demo-futures',short:true}),quote:{bid:'97.000001',ask:'100'}}).action,'hold');
});

test('supplied executable quote overrides snapshot quote and remains separate from origin direction',()=>{
 const args=fixture();args.snapshot.markets[0].ask='104';
 holds(args);assert.equal(modelRuleDecision({...args,quote:{ask:'100.001',bid:'99.999'}}).action,'buy');
 const short=fixture({mode:'demo-futures',short:true});short.snapshot.markets[0].bid='96';
 holds(short);assert.equal(modelRuleDecision({...short,quote:{bid:'99.999',ask:'100.001'}}).action,'open-short');
});

test('ATR must cover original required cost plus 30bps even when the base cost alone is covered',()=>{
 const args=fixture({range:.25});
 assert.equal(closed15mAtr(args.snapshot.markets[0].candles,B)*2/100*10000,50);
 assert.ok(50>Number(args.cost.estimatedRoundTripCostBps));assert.ok(50<Number(args.cost.requiredPriceSpaceBps));
 holds(args);
 const zero=fixture({range:0});holds(zero);
});

test('ATR cost coverage accepts equality while forecast amplitude must also cover costs',()=>{
 const args=fixture();args.cost={status:'ok',estimatedRoundTripCostBps:'170',requiredPriceSpaceBps:'200'};
 assert.equal(modelRuleDecision(args).action,'buy');
 holds({...args,cost:{...args.cost,requiredPriceSpaceBps:'200.0000001'}});
 holds({...args,quote:{ask:'103',bid:'100'}});
});

test('selection uses forecast minus full required costs, not ATR space',()=>{
 const result=modelRuleDecision(fixture());
 assert.ok(Number(result.selectionScoreBps)>0);
 assert.equal(result.selectionScoreBasis,'forecast_minus_required_cost_space_not_expected_return');
 assert.notEqual(Number(result.selectionScoreBps),result.targetFraction*10000-Number(result.requiredPriceSpaceBps));
 assert.ok(Math.abs(Number(result.selectionScoreBps)-(Number(result.forecastMoveBps)-Number(result.requiredPriceSpaceBps)))<1e-10);
});

test('entry confirmation preserves the entire direction path, model identity and ATR exit derivation',()=>{
 const args=fixture(),result=modelRuleDecision(args),confirmation=result.entryConfirmation;
 assert.equal(confirmation.version,'kronos-direction-atr-v1');
 assert.deepEqual(confirmation.forecastCloses,forecast(args).forecastCloses);
 assert.equal(confirmation.originClose,'100');assert.equal(Number(confirmation.atr15),result.atr15);
 assert.equal(confirmation.targetAtr,2);assert.equal(Number(confirmation.targetFraction),result.targetFraction);
 assert.equal(confirmation.modelFingerprint,PIN);assert.equal(confirmation.predictionSha256,HASH);
 assert.equal(confirmation.confirmationAt,B);assert.equal(confirmation.targetCloseAt,B+3*MS-1);
 assert.equal(confirmation.issuedAt,args.modelEvidence.prediction.issuedAt);
});

test('v12 preserves initial risk, monetary risk sizing and native exit parameters',()=>{
 const args=fixture(),result=modelRuleDecision(args);
 assert.equal(result.stopFraction,.01);assert.equal(result.maxHoldingSeconds,14400);assert.equal(result.maxHoldingBars,48);
 assert.equal(result.profitProtection.version,'net-profit-trail-v1');
 const stake=Number(demoRiskStake(result,args.cost,{mode:args.snapshot.mode,maxStakeUsdt:100}));
 assert.ok(stake*(result.stopFraction+Number(args.cost.estimatedRoundTripCostBps)/10000)<=1);
 const wider=modelRuleDecision(fixture({range:5}));assert.equal(wider.stopFraction,.02);
});

test('unavailable, stopped, or review-suppressed model evidence cannot enter under the new rule',()=>{
 for(const evidence of [null,{status:'unavailable',reason:'MODEL_STOPPED'},
  {status:'unavailable',reason:'MODEL_WAIT_TIMEOUT'},
  {...fixture().modelEvidence,entryAllowed:false,reason:'MODEL_REVIEW_SUPPRESSED'}])
  holds({...fixture(),modelEvidence:evidence});
});

test('invalid costs or quotes and malformed forecast paths remain blocked',()=>{
 for(const cost of [null,{status:'unavailable'},
  {status:'ok',estimatedRoundTripCostBps:'61',requiredPriceSpaceBps:'60'},
  {status:'ok',estimatedRoundTripCostBps:'30',requiredPriceSpaceBps:'NaN'}])holds({...fixture(),cost});
 for(const ask of ['NaN','0','-1'])holds({...fixture(),quote:{ask,bid:'99'}});
 for(const path of [[],['100.01'],['100.01','100.02'],['100.01','100.02','100.03','100.04'],
  ['100.01','NaN','100.03'],['100.01','0','100.03']])holds(fixture({path}));
});

test('entry evidence identity, latest closed candles and snapshot timing are still mandatory',()=>{
 for(const mutate of [a=>{a.snapshot.markets[0].verifiedSpot=false;},a=>{a.snapshot.evidence.pop();},
  a=>{a.snapshot.markets[0].candles[1].openTime++;},a=>{a.snapshot.candleBoundary-=MS;},
  a=>{a.snapshot.createdAt=new Date(a.now+1).toISOString();},a=>{forecast(a).originClose='101';},
  a=>{a.modelEvidence.prediction.forecasts.push(structuredClone(forecast(a)));},
  a=>{a.snapshot.markets.push(structuredClone(a.snapshot.markets[0]));}]){
  const args=fixture();mutate(args);holds(args);
 }
});


test('current v12 evaluator rejects model agreement when completed price momentum conflicts',()=>{
 for(const short of [false,true]){
  const args=fixture({mode:'demo-futures',short});
  assert.notEqual(modelRuleDecision(args).action,'hold');
  args.snapshot.markets[0].candles[94].close=short?'99.99':'100.01';
  const result=modelRuleDecision(args);
  assert.equal(result.action,'hold');assert.deepEqual(result.reasons,['MODEL_OBSERVED_MOMENTUM_CONFLICT']);
  assert.equal(result.entryPolicyVersion,'forecast-net-edge-v1');
 }
});

test('forecast cost boundary is strict and symmetric for executable long and short prices',()=>{
 for(const short of [false,true])for(const delta of [-.000001,0,.000001]){
  const args=fixture({mode:'demo-futures',short,path:short?['99.9','99.8',String(99.4-delta)]:['100.1','100.2',String(100.6+delta)]});
  const result=modelRuleDecision({...args,quote:{ask:'100',bid:'100'}});
  assert.equal(result.action,delta>0?(short?'open-short':'open-long'):'hold');
  if(delta<=0)assert.deepEqual(result.reasons,['MODEL_FORECAST_COST_SHORTFALL']);
 }
});
