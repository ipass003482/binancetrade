import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VOLUME_ARMS,VOLUME_BLOCK_MS,VOLUME_DURATION_MS,volumeAssignment,assertVolumeAssignment,volumeVariant} from '../src/volume-experiment.mjs';
import {demoRuleDecision,DEMO_PARAMETERS} from '../src/demo-rules.mjs';
import {buildAnalystPrompt} from '../src/analyst.mjs';
import {rulesProposal,RULE_ENGINE_VERSION} from '../src/decision.mjs';
import {buildVolumeReport} from '../src/volume-report.mjs';
import {execute} from '../src/bridge.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson,journalRead,writeJson} from '../src/io.mjs';
import {fixture,clockFixture} from './fixtures.mjs';
import {beginForwardTrial,refreshForwardReport} from '../src/forward-store.mjs';
const B=Date.parse('2026-09-11T00:00:00Z'),config={version:1,enabled:true,startAt:new Date(B).toISOString()};
function candles(at=B,short=false,volume='10'){
 return Array.from({length:96},(_,i)=>{const p=i<94?100+i*.005:i===94?103:104,c=short?200-p:p;
  return {openTime:at-(96-i)*300000,closeTime:at-(95-i)*300000-1,open:String(c),high:String(i===95&&short?100:c+.5),low:String(i===95&&!short?100:c-.5),close:String(c),volume:i===95?volume:'10'};});
}
test('preregistered blocks balance each arm over four times of day, boundaries and restart assignment are deterministic',()=>{
 const hours=new Map(VOLUME_ARMS.map(a=>[a.arm,new Set()]));
 assert.equal(volumeAssignment(B-300000,config),null);
 for(let i=0;i<12;i++){
  const at=B+i*VOLUME_BLOCK_MS,a=volumeAssignment(at,config);
  assert.equal(a.minimum,VOLUME_ARMS[i%3].minimum);
  assert.equal(volumeAssignment(at+VOLUME_BLOCK_MS-300000,config).arm,a.arm);
  assert.deepEqual(volumeAssignment(at,structuredClone(config)),a);
  hours.get(a.arm).add(new Date(at).getUTCHours());
 }
 for(const set of hours.values())assert.equal(set.size,4);
 assert.equal(volumeAssignment(B+VOLUME_DURATION_MS,config),null);
 assert.equal(volumeAssignment(B,{...config,enabled:false}),null);
 assert.throws(()=>volumeAssignment(B+1,config),/BOUNDARY/);
});
test('host rejects injected, missing, stale-block and wrong-start assignments',()=>{
 const a=volumeAssignment(B+VOLUME_BLOCK_MS,config),snapshot={candleBoundary:B+VOLUME_BLOCK_MS,volumeExperiment:a};
 assert.deepEqual(assertVolumeAssignment(snapshot,config),a);
 for(const x of [null,{...a,minimum:.1},{...a,arm:'vol-08'},{...a,extra:'override'},volumeAssignment(B,config)])
  assert.throws(()=>assertVolumeAssignment({...snapshot,volumeExperiment:x},config));
 assert.throws(()=>assertVolumeAssignment(snapshot,{...config,startAt:new Date(B-300000).toISOString()}));
 assert.throws(()=>assertVolumeAssignment(snapshot,{...config,enabled:false}),/HOST_MISMATCH/);
});
test('all three thresholds apply equally to long and short, accept equality, and leave ATR exits unchanged',()=>{
 for(let i=0;i<3;i++)for(const short of [false,true]){
  const at=B+i*VOLUME_BLOCK_MS,a=volumeAssignment(at,config);
  const args={timeframe:'5m',mode:'demo-futures',pair:'BTC/USDT:USDT',cost:{status:'ok',requiredPriceSpaceBps:'0'},now:at,volumeExperiment:a};
  const equal=demoRuleDecision({...args,candles:candles(at,short,String(a.minimum*10))});
  assert.equal(equal.action,short?'open-short':'open-long');
  assert.equal(equal.directionChecks.find(d=>d.eligible).metrics.relativeVolumeMinimum,a.minimum);
  const control=demoRuleDecision({...args,candles:candles(at,short,'20'),volumeExperiment:null});
  for(const k of ['stopFraction','targetFraction','maxHoldingSeconds','trigger'])assert.equal(equal[k],control[k]);
  const below=demoRuleDecision({...args,candles:candles(at,short,String(a.minimum*10-.001))});
  assert.equal(below.action,'hold');assert.ok(below.reasons.includes('ENTRY_RELATIVE_VOLUME_BELOW_DEMO_MIN'));
 }
 assert.equal(DEMO_PARAMETERS.relativeVolumeMinimum,.8);
});
test('prompt retains historical volume assignment but declares it unsupported for v12 entries',async()=>{
 const policy=await loadPolicy('demo'),boundary=B+2*VOLUME_BLOCK_MS;
 const snapshot={id:'experiment',mode:'demo',timeframe:'5m',createdAt:new Date(boundary).toISOString(),candleBoundary:boundary,
  volumeExperiment:volumeAssignment(boundary,config),markets:[]};
 const rule=rulesProposal(snapshot,policy,{trades:[]}),prompt=await buildAnalystPrompt({snapshot,policy});
 assert.equal(rule.metadata.parameters.relativeVolumeMinimum,1.2);
 assert.deepEqual(prompt.metadata.strategyContract,rule.metadata.strategyContract);
 assert.match(prompt.prompt,/not supported/);assert.match(prompt.prompt,/retired volume experiment is not supported/);assert.equal(rule.metadata.llmInvoked,false);
});
function reportFixture(){
 const trades=[],journal=[];
 for(let i=0;i<3;i++){
  const a=volumeAssignment(B+i*VOLUME_BLOCK_MS,config),id=String(i+1).repeat(32),tag='codex-'+id;
  const t={trade_id:i+1,pair:'BTC/USDT',enter_tag:tag,is_short:false,is_open:i===2,open_timestamp:a.candleBoundary+10000,
   close_timestamp:i===2?null:B+VOLUME_DURATION_MS-1000,profit_abs:i===0?-.7:i===1?1.1:99,stake_amount:50,leverage:1,fee_open_cost:.1,fee_close_cost:.1,exit_reason:'stoploss_on_exchange'};
  trades.push(t);journal.push({id,tag,pair:t.pair,status:'pending',at:new Date(t.open_timestamp).toISOString(),action:'buy',purpose:'strategy',ruleVersion:volumeVariant(a),volumeExperiment:a},
   {id,tag,pair:t.pair,status:'submitted',at:new Date(t.open_timestamp).toISOString(),action:'buy',tradeId:t.trade_id});
 }
 const asOf=new Date(B+VOLUME_DURATION_MS).toISOString(),report={mode:'demo',strategy:{trades:trades.map(t=>({tag:t.enter_tag}))},validation:{evidenceComplete:true}};
 return {trades,journal,config,asOf,report};
}
test('actual losses, fee-inclusive net, cross-block closures and open positions remain attributed to entry arm',()=>{
 const f=reportFixture(),r=buildVolumeReport(f);
 assert.equal(r.phase,'window_complete');assert.equal(r.current,null);assert.equal(r.winner,null);
 assert.equal(r.arms[0].netRealizedUsdt,'-0.7');assert.equal(r.arms[0].closedTradeDrawdownUsdt,'0.7');
 assert.equal(r.arms[1].netRealizedUsdt,'1.1');assert.equal(r.arms[1].recordedClosedTradeFeesUsdt,'0.2');
 assert.equal(r.arms[2].netRealizedUsdt,'0');assert.equal(r.arms[2].openTrades,1);assert.equal(r.arms[2].status,'awaiting_closed_trades');
 assert.equal(r.promotionAuthorized,false);
});
test('missing attribution or incomplete broker history never becomes an apparent winning sample',()=>{
 for(const patch of ['history','missing','mismatch']){
  const f=reportFixture();
  if(patch==='history')f.report.validation.evidenceComplete=false;
  if(patch==='missing')delete f.journal[0].volumeExperiment;
  if(patch==='mismatch')f.journal[0].ruleVersion=volumeVariant(VOLUME_ARMS[1]);
  const r=buildVolumeReport(f);assert.equal(r.evidenceComplete,false);
  assert.ok(r.arms.every(a=>a.netRealizedUsdt===null));assert.equal(r.winner,null);
 }
});
test('v12 forward sample excludes historical volume variants while original fills remain in history',async()=>{
 const f=reportFixture(),local=await mkdtemp(join(tmpdir(),'volume-forward-'));
 // Use a past local marker so the fixed synthetic fills are valid report inputs.
 await beginForwardTrial(local,'demo',[]);
 const marker=await readJson(join(local,'forward-trial.json'));marker.startedAt=new Date(B-300000).toISOString();
 await writeJson(join(local,'forward-trial.json'),marker);
 const {journalAppend}=await import('../src/io.mjs');
 const t={...f.trades[0],close_timestamp:B+15000};
 for(const row of f.journal.slice(0,2))await journalAppend(join(local,'orders.jsonl'),row);
 const r=await refreshForwardReport(local,{policy:{mode:'demo'},history:async()=>[t]});
 assert.deepEqual(r.strategy.closedTradeIds,[]);assert.equal(r.strategy.netRealizedUsdt,'0');
 assert.equal(r.validation.preliminarySampleAvailable,false);
 assert.ok(!(await readJson(join(local,'forward-trial.json'))).strategyTags.includes(t.enter_tag));
 const historical=buildVolumeReport({...f,trades:[t],journal:f.journal.slice(0,2)});
 assert.equal(historical.arms[0].netRealizedUsdt,'-0.7');
});
test('v12 bridge rejects retired volume experiment before obtaining a quote or creating a plan',async()=>{
 const f=await fixture(),mode='demo',policy=await loadPolicy(mode),now=f.now,boundary=Math.floor(now/300000)*300000;
 const c={version:1,enabled:true,startAt:new Date(boundary-VOLUME_BLOCK_MS).toISOString()},a=volumeAssignment(boundary,c),clock=clockFixture(now,mode);
 const local=await mkdtemp(join(tmpdir(),'volume-bridge-')),pair='BTC/USDT';
 const market={pair,mode,source:'https://demo-api.binance.com',verifiedSpot:true,bid:'104',ask:'104.01',spreadBps:1,fetchedAt:new Date(now).toISOString(),clock,
  filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},{filterType:'MARKET_LOT_SIZE',minQty:'0',maxQty:'10000',stepSize:'0'},{filterType:'NOTIONAL',minNotional:'5'}],candles:candles(boundary)};
 const snapshot={id:randomUUID(),mode,timeframe:'5m',createdAt:new Date(now).toISOString(),candleBoundary:boundary,clock,decisionEngine:'rules',volumeExperiment:a,markets:[market],
  evidence:[{id:'spot:'+pair,status:'ok',data:{pair}},{id:'technical:'+pair,pair,status:'ok'}],
  costFacts:{mode,kind:'costs',readOnly:true,source:market.source,observedAt:new Date(now).toISOString(),rates:[{pair,status:'ok',buyRate:'.001',sellRate:'.001'}]}};
 const proposal={snapshotId:snapshot.id,action:'buy',pair,stakeUsdt:'25',evidenceIds:['spot:'+pair],reason:'Synthetic volume experiment'};
 let sends=0,quotes=0;const engine={strategy_version:RULE_ENGINE_VERSION};
 const options={snapshot,proposal,local,policy,getVolumeConfig:async()=>c,getQuote:async()=>{quotes++;return market;},getClock:async()=>clock,
  portfolioEntryFn:async(_opts,run)=>run(async()=>({checked:true})),protectionCheckFn:async()=>({verified:true}),
  client:{snapshot:async()=>({...f.account,engine}),submit:async(p,tag,id,{beforeSend})=>{await beforeSend(engine);sends++;return {trade_id:1,pair,enter_tag:tag};}}};
 await assert.rejects(execute({...options,snapshot:{...snapshot,volumeExperiment:null}}),/HOST_MISMATCH/);
 assert.equal(quotes,0);assert.equal(sends,0);
 await assert.rejects(execute(options),/MODEL_VOLUME_EXPERIMENT_NOT_SUPPORTED/);
 assert.equal(sends,0);assert.equal(quotes,0);
 assert.deepEqual(await journalRead(join(local,'orders.jsonl')),[]);
});
