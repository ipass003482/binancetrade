import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {deriveAdaptiveParameters,closedVolatilityInput,ADAPTIVE_FLOW_VERSION} from '../src/adaptive-parameters.mjs';
import {demoRiskStake,DEMO_RULE_VERSION} from '../src/demo-rules.mjs';

function input({spread=.02,depth=100,atr15=1,cost=30,mode='demo',long=true}={}){
 const books=[0,1,2].map(i=>({at:180000+i*10000,
  bids:Array.from({length:5},(_,k)=>[String(100-spread/2-k*.01),String(depth)]),
  asks:Array.from({length:5},(_,k)=>[String(100+spread/2+k*.01),String(depth)])}));
 return {mode,long,proof:{mode,books},atr15,quotePrice:'100',estimatedRoundTripCostBps:cost,volatility:volatility()};
}
function volatility(ranges=Array(14).fill(1)){
 const boundary=Date.parse('2026-09-16T05:30:00Z');
 const candles=[0,...ranges].map((range,i)=>({openTime:boundary-(15-i)*300000,closeTime:boundary-(14-i)*300000-1,high:String(100+range/2),low:String(100-range/2),close:'100'}));
 return closedVolatilityInput(candles,boundary);
}

test('adaptive parameters respond to observable spread and depth without changing historical inputs',()=>{
 const source=input(),before=structuredClone(source),base=deriveAdaptiveParameters(source);
 assert.deepEqual(source,before);assert.equal(base.version,ADAPTIVE_FLOW_VERSION);
 assert.equal(base.calibration,'prospective_rule_not_fitted');
 const wide=deriveAdaptiveParameters(input({spread:.2})),thin=deriveAdaptiveParameters(input({depth:1}));
 for(const stressed of [wide,thin]){
  assert.ok(new Decimal(stressed.riskScale).lt(base.riskScale));
  assert.ok(new Decimal(stressed.minTakerShare).gt(base.minTakerShare));
 }
 assert.ok(new Decimal(wide.costBufferBps).gt(base.costBufferBps));
 assert.equal(thin.costBufferBps,base.costBufferBps);
 assert.deepEqual(deriveAdaptiveParameters(source),base);
 assert.equal(base.evidence.flowSampledAt,200000);
});

test('all adaptive profiles stay within the engineering bounds under extreme observed inputs',()=>{
 for(const mode of ['demo','demo-futures'])for(const long of [true,false])for(const spread of [.000001,10])for(const depth of [.000001,1000000])for(const atr15 of [.000001,10]){
  const p=deriveAdaptiveParameters(input({mode,long,spread,depth,atr15,cost:100}));
  assert.ok(Number(p.riskScale)>=.25&&Number(p.riskScale)<=1);
  assert.ok(Number(p.minTakerShare)>=.55&&Number(p.minTakerShare)<=.60);
  assert.ok(Number(p.costBufferBps)>=30&&Number(p.costBufferBps)<=40);
  assert.equal(p.riskBudgetUsdt,p.riskScale);
  assert.equal(p.inputs.mode,mode);assert.equal(p.inputs.long,long);
 }
 const max=deriveAdaptiveParameters(input({spread:10,depth:.000001,atr15:.000001,cost:100}));
 assert.equal(max.riskScale,'0.250000000000');assert.equal(max.minTakerShare,'0.600000000000');
 assert.equal(max.costBufferBps,'40.000000000000');
});

test('adaptive risk scales the existing all-cost stress budget and rejects invalid or amplified risk',()=>{
 for(const mode of ['demo','demo-futures']){
  const profile=deriveAdaptiveParameters(input({mode})),cost={status:'ok',estimatedRoundTripCostBps:'30'},policy={mode,maxStakeUsdt:1000};
  const rules={version:DEMO_RULE_VERSION,stopFraction:.01,adaptiveParameters:profile};
  const stake=new Decimal(demoRiskStake(rules,cost,policy)),risk=stake.mul(mode==='demo'?'.018':'.013');
  assert.ok(risk.lte(profile.riskBudgetUsdt));
  assert.ok(stake.lt(demoRiskStake({...rules,adaptiveParameters:undefined},cost,policy)));
  for(const bad of [{...profile,riskScale:'1.01',riskBudgetUsdt:'1.01'},{...profile,riskScale:'.24',riskBudgetUsdt:'.24'},{...profile,riskBudgetUsdt:'1'},{...profile,version:'pretend'}])
   assert.throws(()=>demoRiskStake({...rules,adaptiveParameters:bad},cost,policy),/DEMO_ADAPTIVE_RISK_INVALID/);
 }
});

test('malformed observation inputs cannot manufacture a valid adaptive profile',()=>{
 for(const patch of [{atr15:0},{atr15:'NaN'},{quotePrice:-1},{estimatedRoundTripCostBps:-1},{estimatedRoundTripCostBps:null},{mode:'live'},{long:1}])
  assert.throws(()=>deriveAdaptiveParameters({...input(),...patch}));
 for(const mutate of [x=>x.proof.books.pop(),x=>x.proof.books[0].asks[0][1]='0',x=>x.proof.books[2].asks[0][0]='99']){
  const x=input();mutate(x);assert.throws(()=>deriveAdaptiveParameters(x));
 }
});

test('recent 35-minute expansion scales real stake, preserving targets and support thresholds',()=>{
 const calm=deriveAdaptiveParameters(input()),args={...input(),volatility:volatility([...Array(7).fill(1),...Array(7).fill(2)])};
 const p=deriveAdaptiveParameters(args),v=p.evidence.volatility;
 assert.equal(v.fastAtr,'2.000000000000');assert.equal(v.slowAtr,'1.500000000000');assert.equal(v.riskMultiplier,'0.750000000000');
 assert.ok(new Decimal(p.riskScale).lt(calm.riskScale));assert.equal(p.minTakerShare,calm.minTakerShare);assert.equal(p.costBufferBps,calm.costBufferBps);
 const cost={status:'ok',estimatedRoundTripCostBps:'30'},policy={mode:'demo',maxStakeUsdt:1000};
 const rule={version:DEMO_RULE_VERSION,stopFraction:.01,targetFraction:.03};
 assert.ok(new Decimal(demoRiskStake({...rule,adaptiveParameters:p},cost,policy)).lt(demoRiskStake({...rule,adaptiveParameters:calm},cost,policy)));
 assert.equal(rule.targetFraction,.03);assert.equal(rule.stopFraction,.01);
 args.volatility.candles[14].high='999';assert.notEqual(p.inputs.volatility.candles[14].high,'999');
});

test('flat or slowing recent prices do not increase risk or divide by zero; stress retains floor',()=>{
 const base=deriveAdaptiveParameters(input());
 for(const ranges of [Array(14).fill(0),[...Array(7).fill(2),...Array(7).fill(0)],[...Array(7).fill(2),...Array(7).fill(1)]]){
  const p=deriveAdaptiveParameters({...input(),volatility:volatility(ranges)});
  assert.equal(p.evidence.volatility.riskMultiplier,'1.000000000000');assert.equal(p.riskScale,base.riskScale);
 }
 const p=deriveAdaptiveParameters({...input({spread:10,depth:.000001,atr15:.000001,cost:100}),volatility:volatility([...Array(7).fill(0),...Array(7).fill(2)])});
 assert.equal(p.evidence.volatility.riskMultiplier,'0.500000000000');assert.equal(p.riskScale,'0.250000000000');
});

test('invalid new volatility proof fails without falling back to v1',()=>{
 for(const mutate of [x=>x.volatility=null,x=>x.volatility.candles.pop(),x=>x.volatility.candleBoundary++,x=>x.volatility.candles[7].openTime++,x=>x.volatility.candles[14].closeTime++,x=>x.volatility.candles[2].high='NaN',x=>x.volatility.candles[2].close='999',x=>x.volatility.candles[2].high=100,x=>x.volatility.candles[0].low='0',x=>x.volatility.extra=true]){
  const x=input();mutate(x);assert.throws(()=>deriveAdaptiveParameters(x));
 }
 const x=input();x.volatility=closedVolatilityInput(x.volatility.candles.map((r,i)=>({...r,openTime:(i-14)*300000,closeTime:(i-13)*300000-1})),300000);
 assert.throws(()=>deriveAdaptiveParameters(x));
});

test('explicit legacy replay keeps v1 values and never acquires new volatility evidence',()=>{
 const args=input();delete args.volatility;const legacy=deriveAdaptiveParameters(args),current=deriveAdaptiveParameters(input());
 assert.equal(legacy.version,'live-flow-adaptive-v1');assert.equal(legacy.riskScale,current.riskScale);
 assert.equal(legacy.inputs.volatility,undefined);assert.equal(legacy.evidence.baseRiskScale,undefined);
});
