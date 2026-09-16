import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { entryCost,loadCosts } from '../src/trading-costs.mjs';
import { timeframeSpec } from '../src/timeframe.mjs';
import { baselineDecision,backtestBaseline } from '../src/baseline.mjs';
import { equitySummary,recordEquity } from '../src/equity.mjs';
import { execute } from '../src/bridge.mjs';
import { runCycle } from '../src/workflow.mjs';
import {entryArtifactStem,BATCH_EXECUTION_VERSION} from '../src/entry-identity.mjs';
import {entryId} from '../src/entry-identity.mjs';
import { modelRuleDecision } from '../src/demo-rules.mjs';
import {rulesProposal} from '../src/decision.mjs';
import { clockFixture,fixture,syntheticModelEvidence,flowFixture } from './fixtures.mjs';
import { loadPolicy } from '../src/config.mjs';
import { readJson,writeJson,journalRead,exists } from '../src/io.mjs';
const M=900000,B=Date.parse('2026-09-01T00:00:00Z');
export function breakout(short=false,at=B,timeframe='15m'){
 const {ms:M,historyBars:n}=timeframeSpec(timeframe);
 return Array.from({length:n},(_,i)=>{const p=i<n-2?100+i*.005:i===n-2?103:104;const c=short?200-p:p;
  return {openTime:at-(n-i)*M,closeTime:at-(n-1-i)*M-1,open:String(c),high:String(timeframe==='5m'&&i===n-1&&short?100:c+.5),low:String(timeframe==='5m'&&i===n-1&&!short?100:c-.5),close:String(c),volume:'10'};});
}
const cost={status:'ok',requiredPriceSpaceBps:'60'};
test('rules accept the first closed breakout with a buffer, require cost room and support symmetric long/short',()=>{
 for(const short of [false,true]){
  const candles=breakout(short),mode='demo-futures',pair='BTC/USDT:USDT';
  const r=baselineDecision({candles,mode,pair,cost});assert.equal(r.action,short?'open-short':'open-long');assert.ok(r.stopFraction<=.02);
  const first=candles.slice(0,31);first.unshift({...first[0],openTime:first[0].openTime-M,closeTime:first[0].closeTime-M});
  assert.equal(baselineDecision({candles:first,mode,pair,cost}).action,short?'open-short':'open-long');
  assert.equal(baselineDecision({candles,mode,pair,cost:{status:'ok',requiredPriceSpaceBps:'10000'}}).action,'hold');
 }
 assert.equal(baselineDecision({candles:breakout(true),mode:'demo',pair:'BTC/USDT',cost}).action,'hold');
});

function modelCandles(at){
 const rows=breakout(false,at,'5m');
 for(const row of rows.slice(0,92)){row.high=String(Number(row.close)+1.5);row.low=String(Number(row.close)-1.5);}
 for(const [i,c] of [[92,103],[93,102.8],[94,102.7]])Object.assign(rows[i],{open:String(c),high:String(c+.5),low:String(c-.5),close:String(c)});
 return rows;
}
async function freshModelRecheckFixture({mode='demo',atrCost=false}={}){
 const f=await fixture(),policy=await loadPolicy(mode),now=Date.now(),boundary=Math.floor(now/300000)*300000,
  pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
  clock=clockFixture(now,mode),candles=modelCandles(boundary);
 if(atrCost){
  for(let i=0;i<candles.length;i++)Object.assign(candles[i],{open:String(99+i*.01),high:String(99+i*.01+.35),low:String(99+i*.01-.35),close:String(99+i*.01)});
  for(const [i,c] of [[92,99.98],[93,99.97],[94,99.96]])Object.assign(candles[i],{open:String(c),high:'99.99',low:'99.8',close:String(c)});
  Object.assign(candles[95],{open:'100',high:'100.35',low:'99.65',close:'100'});
 }
 const origin=atrCost?100:104,market={pair,mode,source,orderFlow:flowFixture(now,mode,pair),verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',
  bid:String(origin),ask:String(origin+.01),spreadBps:1,fetchedAt:new Date(now).toISOString(),candles,clock,fundingRate:'0',
  filters:[{filterType:'LOT_SIZE',minQty:'.00001',maxQty:'100000',stepSize:'.00001'},
   {filterType:'MARKET_LOT_SIZE',minQty:'.00001',maxQty:'100000',stepSize:'.00001'},
   {filterType:'MIN_NOTIONAL',minNotional:'5',notional:'5'}]};
 const snapshot={id:randomUUID(),mode,timeframe:'5m',ruleVersion:'kronos-direction-v12',createdAt:new Date(now).toISOString(),
  completedAt:new Date(now).toISOString(),candleBoundary:boundary,clock,decisionEngine:'rules',markets:[market],
  evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}]};
 const facts={mode,kind:'costs',readOnly:true,source,observedAt:new Date(now).toISOString(),
  rates:[{pair,status:'ok',buyRate:'.001',sellRate:'.001'}]};snapshot.costFacts=facts;
 const target=origin+1,evidence=syntheticModelEvidence(snapshot,{targetByPair:{[pair]:target}});
 const quote={...market,ask:String(origin+(atrCost?.20:1.01)),spreadBps:atrCost?20:1};
 const cost=entryCost(facts,market,mode,await loadCosts(),now);
 assert.notEqual(modelRuleDecision({snapshot,pair,cost,modelEvidence:evidence,now}).action,'hold','snapshot proposal was actually eligible');
 const proposal={...f.proposal,pair,snapshotId:snapshot.id,stakeUsdt:'100',action:mode==='demo'?'buy':'open-long',
  evidenceIds:[(mode==='demo'?'spot:':'futures:')+pair],...(mode==='demo-futures'?{leverage:1}:{})};
 const account={...f.account,engine:{strategy_version:'demo-rule-exits-v12'}},counts={sends:0,protection:0};
 const client={snapshot:async()=>account,submit:async()=>{counts.sends++;throw Error('TEST_UNEXPECTED_SEND');}};
 const guards={getQuote:async()=>quote,getModelEvidence:async()=>evidence,modelStopped:()=>false,
  portfolioEntryFn:async(_opts,run)=>run(async()=>({checked:true})),
  protectionCheckFn:async()=>{counts.protection++;return {verified:true};},
  getVolumeConfig:async()=>({version:1,enabled:false,startAt:'2026-09-11T00:00:00.000Z'})};
 return {snapshot,proposal,policy,client,guards,facts,evidence,market,quote,counts};
}

test('flow cycle never waits for a model and stale flow yields HOLD without a submission',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const local=await mkdtemp(join(tmpdir(),'flow-cycle-')),f=await freshModelRecheckFixture();
 f.snapshot.markets[0].orderFlow=null;
 const result=await runCycle({local,policy:f.policy,client:f.client,collectFn:async()=>f.snapshot,costsFn:async()=>f.facts,
  modelEvidenceFn:async()=>{throw Error('MODEL_MUST_NOT_BE_CALLED');},executeFn:args=>execute({...args,...f.guards})});
 assert.equal(result.proposal.action,'hold');assert.equal(f.counts.sends,0);
 const model=await readJson(join(local,'runs',f.snapshot.id+'.model-decision.json'));
 assert.equal(model.usedForEntryDecision,false);assert.equal(model.status,'observation_only');
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,0);
});

test('fresh cost increase invalidates net reward/risk before any submission',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const local=await mkdtemp(join(tmpdir(),'v12-atr-recheck-')),f=await freshModelRecheckFixture({atrCost:true});
 const result=await execute({...f,local,...f.guards});
 assert.equal(result.status,'filtered');assert.deepEqual(result.reasons,['FLOW_NET_REWARD_RISK_TOO_SMALL']);
 const checked=await readJson(join(local,'runs',f.snapshot.id+'.rules-recheck.json'));
 assert.equal(checked.rules.flowDiagnostics.eligible,true);
 assert.equal(checked.rules.directionChecks[0].netRewardRisk.eligible,false);
 assert.equal((await journalRead(join(local,'orders.jsonl'))).at(-1).status,'rejected');
 assert.equal(f.counts.sends,0);assert.equal(await exists(join(local,'entry-plans')),false);
});

test('stale cost facts still prevent a flow order',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const local=await mkdtemp(join(tmpdir(),'flow-cost-')),f=await freshModelRecheckFixture();
 f.facts.observedAt=new Date(Date.now()-301000).toISOString();
 await assert.rejects(execute({...f,local,...f.guards}),/ENTRY_COSTS_UNAVAILABLE/);
 assert.equal(f.counts.sends,0);assert.deepEqual(await journalRead(join(local,'orders.jsonl')),[]);
});

test('fresh executable spot quote at signal origin cancels before any submission or plan',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const f=await freshModelRecheckFixture({atrCost:true}),local=await mkdtemp(join(tmpdir(),'flow-continuation-'));
 const origin=f.market.orderFlow.books[0].asks[0][0];
 const result=await execute({...f,local,...f.guards,getQuote:async()=>({...f.market,ask:origin,bid:String(Number(origin)-.001)})});
 assert.equal(result.status,'filtered');assert.deepEqual(result.reasons,['SPOT_FLOW_PRICE_NOT_CONTINUED']);
 assert.equal(f.counts.sends,0);assert.equal(await exists(join(local,'entry-plans')),false);
 assert.ok((await journalRead(join(local,'orders.jsonl'))).every(row=>row.status!=='pending'));
});

test('backtest fills next open, conservative stop ordering, fees, funding and gaps are explicit',()=>{
 const candles=breakout();candles.push({openTime:B,closeTime:B+M-1,open:'110',high:'120',low:'90',close:'111',volume:'10'});
 const d={schemaVersion:1,mode:'demo',pair:'BTC/USDT',candles,source:'synthetic'};
 const r=backtestBaseline(d,{buyRate:.001,sellRate:.001});assert.equal(r.trades.length,1);assert.ok(r.trades[0].entry>110);assert.equal(r.trades[0].openedAt,B);
 assert.equal(r.trades[0].reason,'stop_first_if_both');assert.ok(r.trades[0].net<r.trades[0].gross);assert.ok(Math.abs(r.netUsdt-r.trades.reduce((s,t)=>s+t.net,0))<1e-9);
 const bad=structuredClone(d);bad.candles[20].openTime+=M;assert.throws(()=>backtestBaseline(bad,{buyRate:.001,sellRate:.001}),/GAP/);
 assert.throws(()=>backtestBaseline({...d,mode:'demo-futures',pair:'BTC/USDT:USDT'},{buyRate:0,sellRate:0}),/FUNDING/);
});
test('buffered entry rejects a wick-only break, tiny break, low volume and an unclosed bar in both directions',()=>{
 for(const short of [false,true]){
  const candles=breakout(short),pair='BTC/USDT:USDT',mode='demo-futures';
  const make=rows=>baselineDecision({candles:rows,pair,mode,cost});
  const valid=make(candles);assert.notEqual(valid.action,'hold');
  assert.equal(valid.level,short?96.5:103.5,'previous bar extreme is part of the 20-bar reference');
  const tiny=structuredClone(candles);tiny.at(-1).close=String(valid.level+(short?-.001:.001));
  const rejected=make(tiny);assert.equal(rejected.action,'hold');
  assert.ok(rejected.directionChecks.find(c=>c.action===(short?'open-short':'open-long')).reasons.includes('BASELINE_BUFFERED_BREAKOUT_REQUIRED'));
  const wick=structuredClone(candles);wick.at(-1).close=String(valid.level+(short?.1:-.1));
  wick.at(-1)[short?'high':'low']=wick.at(-1).close;
  assert.ok(make(wick).reasons.includes('BASELINE_BUFFERED_BREAKOUT_REQUIRED'));
  const quiet=structuredClone(candles);quiet.at(-1).volume='1';
  assert.ok(make(quiet).reasons.includes('ENTRY_RELATIVE_VOLUME_BELOW_ONE'));
  assert.equal(baselineDecision({candles,pair,mode,cost,now:B-1}).action,'hold');
 }
});
test('signal selection is unchanged by future candles; closed-bar prefix is all the decider sees',()=>{
 const candles=breakout();for(let i=0;i<3;i++)candles.push({openTime:B+i*M,closeTime:B+(i+1)*M-1,open:'104',high:'104.1',low:'103.9',close:'104',volume:'10'});
 const d={schemaVersion:1,mode:'demo',pair:'BTC/USDT',candles};
 let seen=[];const decide=args=>{seen.push(args.candles.at(-1).closeTime);assert.equal(args.now,args.candles.at(-1).closeTime+1);return baselineDecision(args);};
 const one=backtestBaseline(d,{buyRate:.001,sellRate:.001,decide});
 const other=structuredClone(d);Object.assign(other.candles.at(-1),{high:'1000',close:'999'});
 const two=backtestBaseline(other,{buyRate:.001,sellRate:.001});assert.deepEqual(one.signals[0],two.signals[0]);assert.ok(seen.length);
});
test('costs separate real account fees from assumptions and reject stale/wrong/missing facts',async()=>{
 const config=await loadCosts(),now=Date.now(),market={pair:'BTC/USDT',spreadBps:2};
 const facts={mode:'demo',kind:'costs',readOnly:true,source:'https://demo-api.binance.com',observedAt:new Date(now).toISOString(),rates:[{pair:market.pair,status:'ok',buyRate:'.001',sellRate:'.001'}]};
 const c=entryCost(facts,market,'demo',config,now);assert.equal(c.roundTripFeeBps,'20');assert.equal(c.requiredPriceSpaceBps,'62');
 for(const f of [{...facts,mode:'demo-futures'},{...facts,source:'https://api.binance.com'},{...facts,observedAt:new Date(now-301000).toISOString()},{...facts,rates:[]},{...facts,rates:[facts.rates[0],facts.rates[0]]}])assert.equal(entryCost(f,market,'demo',config,now).status,'unavailable');
});
test('equity sampling includes unrealized value and never labels unverified cash flows as profit',async()=>{
 const samples=[100,120,90].map((n,i)=>({mode:'demo',status:'ok',equityUsdt:String(n),observedAt:new Date(B+i*60000).toISOString()}));
 const s=equitySummary(samples);assert.equal(s.sampledUnadjustedDrawdownPct,'25');assert.equal(s.changeSinceFirstUsdt,'-10');assert.equal(s.flowAdjustedProfitUsdt,null);
 const local=await mkdtemp(join(tmpdir(),'equity-'));
 await recordEquity(local,'demo',{read:async()=>({observedAt:new Date().toISOString(),source:'test',valuation:{equityUsdt:'100',missingAssets:[]}})});
 await recordEquity(local,'demo',{read:async()=>{throw Error('NETWORK_DOWN');}});
 const stored=await readJson(join(local,'equity-summary.json'));assert.equal(stored.equityUsdt,'100');assert.equal(stored.failedSamples,1);assert.equal(stored.lastAttempt.status,'unavailable');
});
test('flow bridge persists true proof without model reads and rechecks expiry, STOP and loaded engine',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 for(const scenario of ['ok','clock-jump','stop','engine']){
  const f=await freshModelRecheckFixture(),local=await mkdtemp(join(tmpdir(),'flow-wire-'));let sends=0;
  f.client.submit=async(p,tag,id,{beforeSend})=>{
   const initial=await readJson(join(local,'entry-plans',tag+'.json'));assert.equal(initial.nativeEntryGuard,undefined);
   if(scenario==='stop'){const {writeFile}=await import('node:fs/promises');await writeFile(join(local,'STOP'),'test');}
   try{const check=await beforeSend({strategy_version:scenario==='engine'?'old':'demo-rule-exits-v12'});if(scenario==='clock-jump')t.mock.timers.tick(45001);check();}
   catch(e){e.submissionStarted=false;throw e;}
   sends++;return {trade_id:1,pair:p.pair,enter_tag:tag};
  };
  const args={...f,local,...f.guards,getQuote:async()=>f.market,getClock:async()=>f.snapshot.clock,
   getModelEvidence:async()=>{throw Error('MODEL_MUST_NOT_BE_READ');},modelStopped:()=>true};
  if(scenario==='ok'){
   const result=await execute(args);assert.equal(result.status,'submitted');assert.equal(sends,1);
   const plan=await readJson(join(local,'entry-plans',result.tag+'.json')),pending=(await journalRead(join(local,'orders.jsonl')))[0];
   assert.equal(plan.model,undefined);assert.equal(plan.entrySignalEngine,'sampled_order_flow');assert.equal(plan.entryPolicyVersion,'order-flow-only-v1');
   assert.equal(plan.nativeEntryGuard.version,'kronos-native-entry-v10');assert.equal(plan.nativeEntryGuard.forecastClose,undefined);
   assert.deepEqual(pending.entryEvidence,plan.entryEvidence);assert.equal(pending.entryRoute,'order-flow');assert.equal(pending.model,undefined);
   assert.equal(plan.executionQualityVersion,'flow-confirmed-exit-v2');assert.equal(pending.executionQualityVersion,plan.executionQualityVersion);
   assert.equal(plan.entryConfirmation.executionContinuation.originAsk,plan.entryConfirmation.orderFlow.books[0].asks[0][0]);
   assert.ok(plan.maxEntryNotionalUsdt*(plan.stopFraction+plan.riskCostFraction+.005)<=1+1e-8);
  }else{await assert.rejects(execute(args),/CLOCK_JUMP_DETECTED|ENTRY_STOPPED|RESTART_REQUIRED/);assert.equal(sends,0);}
 }
});

test('per-pair bridge identity persists native proof and rejects duplicate replay',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const f=await freshModelRecheckFixture(),local=await mkdtemp(join(tmpdir(),'v12-batch-wire-'));
 f.client.submit=async(p,tag,id,{beforeSend})=>{const check=await beforeSend({strategy_version:'demo-rule-exits-v12'});check();f.counts.sends++;return {trade_id:1,pair:p.pair,enter_tag:tag};};
 const args={...f,local,...f.guards,getQuote:async()=>f.market,getClock:async()=>f.snapshot.clock,executionPolicyVersion:BATCH_EXECUTION_VERSION};
 const result=await execute(args),id=entryId(f.snapshot.id,f.proposal.pair,BATCH_EXECUTION_VERSION);
 assert.equal(result.tag,'codex-'+id);
 const plan=await readJson(join(local,'entry-plans',result.tag+'.json'));
 assert.equal(plan.executionPolicyVersion,BATCH_EXECUTION_VERSION);assert.equal(plan.nativeEntryGuard.version,'kronos-native-entry-v10');
 assert.equal((await journalRead(join(local,'orders.jsonl')))[0].executionPolicyVersion,BATCH_EXECUTION_VERSION);
 assert.equal(await exists(join(local,'runs',entryArtifactStem(f.snapshot.id,f.proposal.pair,BATCH_EXECUTION_VERSION)+'.version.json')),true);
 await assert.rejects(execute(args),/SNAPSHOT_ALREADY_CONSUMED/);assert.equal(f.counts.sends,1);
});

test('minute bridge persists native cadence and reduced risk beyond the first candle minute',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:32:05Z')});
 const f=await freshModelRecheckFixture(),local=await mkdtemp(join(tmpdir(),'adaptive-minute-wire-'));
 Object.assign(f.snapshot,{decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:Date.parse('2026-09-14T09:32:00Z')});
 f.client.submit=async(p,tag,id,{beforeSend})=>{
  const check=await beforeSend({strategy_version:'demo-rule-exits-v12'});check();f.counts.sends++;
  return {trade_id:1,pair:p.pair,enter_tag:tag};
 };
 const args={...f,local,...f.guards,getQuote:async()=>f.market,getClock:async()=>f.snapshot.clock,executionPolicyVersion:BATCH_EXECUTION_VERSION};
 const result=await execute(args),plan=await readJson(join(local,'entry-plans',result.tag+'.json'));
 assert.equal(result.status,'submitted');assert.equal(f.counts.sends,1);
 assert.equal(plan.nativeEntryGuard.version,'kronos-native-entry-v12');
 assert.equal(plan.decisionBoundary,f.snapshot.decisionBoundary);
 assert.equal(plan.nativeEntryGuard.entryDeadline,f.snapshot.decisionBoundary+60000);
 assert.equal(plan.entryConfirmation.confirmationAt,f.snapshot.candleBoundary);
 assert.equal(plan.adaptiveParameters.version,'live-flow-adaptive-v2');
 assert.equal(plan.adaptiveParameters.inputs.volatility.candles.length,15);
 assert.equal(plan.adaptiveParameters.inputs.volatility.candleBoundary,f.snapshot.candleBoundary);
 assert.ok(Number(plan.adaptiveParameters.riskScale)<=Number(plan.adaptiveParameters.evidence.baseRiskScale));
 assert.ok(plan.riskBudgetUsdt>=.25&&plan.riskBudgetUsdt<1);
 assert.ok(plan.maxEntryNotionalUsdt*(plan.stopFraction+plan.riskCostFraction+.005)<=plan.riskBudgetUsdt);
 assert.ok(Number(plan.nativeEntryGuard.requiredPriceSpaceBps)>=plan.riskCostFraction*10000+Number(plan.adaptiveParameters.costBufferBps)-1e-10);
 await assert.rejects(execute(args),/SNAPSHOT_ALREADY_CONSUMED/);
});

async function minuteReceiptFixture(local,scenario){
 const f=await freshModelRecheckFixture();
 Object.assign(f.snapshot,{decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:Math.floor(Date.now()/60000)*60000});
 f.client.submit=async(p,tag,id,{beforeSend})=>{
  const check=await beforeSend({strategy_version:'demo-rule-exits-v12'});check();f.counts.sends++;
  const raw=await readFile(join(local,'entry-plans',tag+'.json')),plan=JSON.parse(raw);
  if(scenario!=='missing'&&scenario!=='next'){
   const receipt={schemaVersion:1,phase:'callback_before_order',tag,snapshotId:plan.snapshotId,pair:plan.pair,mode:'demo',
    decisionBoundary:plan.decisionBoundary,nativeEntryGuardVersion:plan.nativeEntryGuard.version,planCreatedAt:plan.createdAt,
    planSha256:createHash('sha256').update(raw).digest('hex'),reason:'DEMO_NATIVE_MODEL_FLOW_PRICE_NOT_CONTINUED',
    processId:32145,rejectedAt:new Date().toISOString()};
   if(scenario==='pid')receipt.processId++;
   if(scenario==='hash')receipt.planSha256='0'.repeat(64);
   if(scenario==='time')receipt.rejectedAt=new Date(Date.now()-1).toISOString();
   await writeJson(join(local,'entry-rejections',tag+'.json'),receipt);
  }
  if(['success','next','malformed-success'].includes(scenario))return {trade_id:1,pair:p.pair,enter_tag:scenario==='malformed-success'?'wrong-tag':tag};
  throw Object.assign(Error('HTTP 502'),{submissionStarted:true});
 };
 const args={...f,local,...f.guards,getQuote:async()=>f.market,getClock:async()=>f.snapshot.clock,
  protectionCheckFn:async()=>({verified:true,engineProcessId:32145}),executionPolicyVersion:BATCH_EXECUTION_VERSION};
 return {f,args};
}

test('exact native rejection filters once and a fresh next-minute identity can execute',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:32:05Z')});
 const local=await mkdtemp(join(tmpdir(),'minute-native-rejected-')),{f,args}=await minuteReceiptFixture(local,'valid');
 const rejected=await execute(args);
 assert.equal(rejected.status,'filtered');assert.equal(rejected.reason,'NATIVE_CALLBACK_REJECTED');
 assert.deepEqual(rejected.reasons,['DEMO_NATIVE_MODEL_FLOW_PRICE_NOT_CONTINUED']);
 assert.equal(f.counts.sends,1);
 assert.deepEqual((await journalRead(join(local,'orders.jsonl'))).map(row=>row.status),['pending','rejected']);
 await assert.rejects(execute(args),/SNAPSHOT_ALREADY_CONSUMED/);
 t.mock.timers.tick(60000);
 const next=await minuteReceiptFixture(local,'next'),submitted=await execute(next.args);
 assert.equal(submitted.status,'submitted');assert.notEqual(submitted.id,rejected.id);assert.equal(next.f.counts.sends,1);
 const rows=await journalRead(join(local,'orders.jsonl'));
 assert.deepEqual(rows.map(row=>row.status),['pending','rejected','pending','submitted']);
 assert.equal(rows.some(row=>row.status==='unknown'),false);
});

for(const scenario of ['missing','pid','hash','time'])test('HTTP 502 with '+scenario+' callback proof remains unknown and blocks a new attempt',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:32:05Z')});
 const local=await mkdtemp(join(tmpdir(),'minute-native-unknown-')),{f,args}=await minuteReceiptFixture(local,scenario);
 await assert.rejects(execute(args),/HTTP 502/);assert.equal(f.counts.sends,1);
 assert.deepEqual((await journalRead(join(local,'orders.jsonl'))).map(row=>row.status),['pending','unknown']);
 t.mock.timers.tick(60000);
 const next=await minuteReceiptFixture(local,'next');
 await assert.rejects(execute(next.args),/UNRESOLVED_SUBMISSION/);assert.equal(next.f.counts.sends,0);
});

test('a success response with a receipt stays submitted, while malformed success stays unknown',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:32:05Z')});
 for(const scenario of ['success','malformed-success']){
  const local=await mkdtemp(join(tmpdir(),'minute-native-success-')),{f,args}=await minuteReceiptFixture(local,scenario);
  if(scenario==='success')assert.equal((await execute(args)).status,'submitted');
  else await assert.rejects(execute(args),/UNEXPECTED_ORDER_RESPONSE/);
  assert.equal(f.counts.sends,1);
  const rows=await journalRead(join(local,'orders.jsonl'));
  assert.deepEqual(rows.map(row=>row.status),['pending',scenario==='success'?'submitted':'unknown']);
 }
});

test('flow entry does not consume or edit contrary model forecasts',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const f=await freshModelRecheckFixture(),local=await mkdtemp(join(tmpdir(),'pullback-small-forecast-'));
 const row=f.evidence.prediction.forecasts[0];row.forecastCloses=['103','102','101'];
 const before=structuredClone(row);let plan;
 f.client.submit=async(p,tag,id,{beforeSend})=>{const check=await beforeSend({strategy_version:'demo-rule-exits-v12'});check();plan=await readJson(join(local,'entry-plans',tag+'.json'));f.counts.sends++;return {trade_id:1,pair:p.pair,enter_tag:tag};};
 const result=await execute({...f,local,...f.guards,getQuote:async()=>f.market,getClock:async()=>f.snapshot.clock});
 assert.equal(result.status,'submitted');assert.equal(f.counts.sends,1);assert.deepEqual(row,before);
 assert.equal(plan.entryPolicyVersion,'order-flow-only-v1');assert.equal(plan.entryConfirmation.priceConfirmation,undefined);
 assert.equal(plan.entryConfirmation.forecastCloses,undefined);assert.ok(plan.targetFraction-plan.riskCostFraction>=plan.stopFraction+plan.riskCostFraction+.005);
});

test('spot strength changes ordering without rejecting a declining but otherwise valid candidate',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-14T09:30:05Z')});
 const f=await freshModelRecheckFixture();
 f.market.entryCost=entryCost(f.facts,f.market,'demo',await loadCosts(),Date.now());
 const other=structuredClone(f.market);other.pair='ETH/USDT';other.orderFlow.pair=other.pair;
 for(const [market,quantities]of [[f.market,['5','3','2']],[other,['2','3','5']]])
  for(const [i,b]of market.orderFlow.books.entries())for(const row of b.bids)row[1]=quantities[i];
 f.snapshot.markets=[f.market,other];
 f.snapshot.evidence.push({id:'spot:ETH/USDT',status:'ok',data:{pair:other.pair}},{id:'technical:ETH/USDT',pair:other.pair,status:'ok'});
 const result=rulesProposal(f.snapshot,f.policy,{trades:[]});
 assert.equal(result.selected.pair,'ETH/USDT');assert.ok(result.candidates.every(c=>c.action==='buy'));
 assert.ok(Number(result.candidates[0].flowStrength.delta)<0);
 assert.equal(rulesProposal(f.snapshot,f.policy,{trades:[]},null,{excludedPairs:['ETH/USDT']}).selected.pair,'BTC/USDT');
 assert.equal(result.selected.flowExit.version,'rolling-opposite-flow-v2');
 const future=await freshModelRecheckFixture({mode:'demo-futures'});
 future.market.entryCost=entryCost(future.facts,future.market,'demo-futures',await loadCosts(),Date.now());
 const r=rulesProposal(future.snapshot,future.policy,{trades:[]});assert.equal(r.selected.action,'open-long');
 assert.equal(r.selected.flowStrength,undefined);assert.equal(r.selected.flowExit,undefined);
});
