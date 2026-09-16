import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProbePermit,validateProbePermit,probeSpec,probeFillEvidence } from '../src/demo-probe.mjs';
import { execute } from '../src/bridge.mjs';
import { loadPolicy } from '../src/config.mjs';
import { lock,writeJson,readJson,journalRead } from '../src/io.mjs';
import { fixture,trendCandles,clockFixture } from './fixtures.mjs';
async function setup(){
 const f=await fixture(),mode='demo',policy=await loadPolicy(mode),now=f.now,clock=clockFixture(now,mode);
 const spec=probeSpec(mode),local=await mkdtemp(join(tmpdir(),'demo-probe-'));
 const market={pair:spec.pair,mode,source:'https://demo-api.binance.com',verifiedSpot:true,bid:'100',ask:'100.01',spreadBps:1,fetchedAt:new Date(now).toISOString(),clock,
  filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},{filterType:'MARKET_LOT_SIZE',minQty:'0',maxQty:'10000',stepSize:'0'},{filterType:'NOTIONAL',minNotional:'5'}],
  candles:trendCandles(now,'long','5m').map(c=>({...c,volume:'0'}))};
 const snapshot={id:randomUUID(),mode,timeframe:'5m',createdAt:new Date(now).toISOString(),candleBoundary:Math.floor(now/300000)*300000,clock,decisionEngine:'rules',markets:[market],evidence:[{id:'spot:'+spec.pair,status:'ok'}],
  costFacts:{mode,kind:'costs',readOnly:true,source:market.source,observedAt:new Date(now).toISOString(),rates:[{pair:spec.pair,status:'ok',buyRate:'.001',sellRate:'.001'}]}};
 const proposal={snapshotId:snapshot.id,action:spec.action,pair:spec.pair,stakeUsdt:'25',evidenceIds:['spot:'+spec.pair],reason:'Explicit synthetic execution probe'};
 let sends=0;
 const engine={strategy_version:'demo-rule-exits-v12'},client={snapshot:async()=>({...f.account,engine}),submit:async(p,tag,id,{beforeSend})=>{await beforeSend(engine);sends++;return {trade_id:1,pair:spec.pair,enter_tag:tag};}};
 return {mode,local,snapshot,proposal,policy,client,market,clock,sends:()=>sends,
  getVolumeConfig:async()=>({version:1,enabled:false,startAt:'2026-09-11T00:00:00.000Z'}),
  portfolioEntryFn:async(_opts,run)=>run(async()=>({checked:true})),protectionCheckFn:async()=>({verified:true})};
}
test('probe is explicit, exclusive, fixed-size and cannot be replayed or redirected',async()=>{
 const f=await setup();assert.throws(()=>probeSpec('dry-run'),/DEMO_ONLY/);
 await assert.rejects(createProbePermit(f.local,f.mode,f.snapshot),/AUTHORIZATION/);
 await lock(join(f.local,'cycle.lock'),async()=>{
  const permit=await createProbePermit(f.local,f.mode,f.snapshot,{allowDemoOrders:true});
  const args={local:f.local,id:permit.id,proposal:f.proposal,snapshot:f.snapshot,mode:f.mode};
  await validateProbePermit(args);
  for(const stakeUsdt of ['26','300','0'])await assert.rejects(validateProbePermit({...args,proposal:{...f.proposal,stakeUsdt}}),/REJECTED/);
  await assert.rejects(validateProbePermit({...args,now:Date.parse(permit.expiresAt)}),/REJECTED/);
  await assert.rejects(validateProbePermit({...args,proposal:{...f.proposal,pair:'BTC/USDT'}}),/REJECTED/);
  await writeJson(join(f.local,'probe-permits',permit.id+'.json'),{...permit,consumedAt:new Date().toISOString()});
  await assert.rejects(validateProbePermit(args),/REJECTED/);
 });
});
test('explicit probe crosses bridge with distinct native exit plan; normal rule entry with same data is rejected',async()=>{
 const f=await setup();
 await assert.rejects(execute({...f,getQuote:async()=>f.market,getClock:async()=>f.clock}),/MODEL_STRATEGY_VERSION_REQUIRED/);
 await lock(join(f.local,'cycle.lock'),async()=>{
  const permit=await createProbePermit(f.local,f.mode,f.snapshot,{allowDemoOrders:true});
  const result=await execute({...f,getQuote:async()=>f.market,getClock:async()=>f.clock,probePermitId:permit.id});
  assert.equal(f.sends(),1);
  const plan=await readJson(join(f.local,'entry-plans',result.tag+'.json'));
  assert.equal(plan.purpose,'execution_probe');assert.equal(plan.maxHoldingSeconds,90);assert.equal(plan.maxEntryNotionalUsdt,25);
  assert.equal(plan.ruleVersion,'demo-execution-probe-v1');assert.equal(plan.stopFraction,.005);
  assert.ok(plan.maxEntryNotionalUsdt*(plan.stopFraction+plan.riskCostFraction)<=1);
  assert.equal((await journalRead(join(f.local,'orders.jsonl'))).find(r=>r.status==='pending').purpose,'execution_probe');
  await assert.rejects(execute({...f,getQuote:async()=>f.market,probePermitId:permit.id}),/ALREADY_CONSUMED/);
 });
});
test('probe preserves STOP guard',async()=>{
 const f=await setup();
 await lock(join(f.local,'cycle.lock'),async()=>{
  const permit=await createProbePermit(f.local,f.mode,f.snapshot,{allowDemoOrders:true});
  await writeJson(join(f.local,'STOP'),{});
  await assert.rejects(execute({...f,getQuote:async()=>f.market,probePermitId:permit.id}),/ENTRY_STOPPED/);
  assert.equal(f.sends(),0);
 });
});
test('probe completion requires actual fully filled entry and exit order evidence',()=>{
 const t={pair:'ETH/USDT',is_short:false,is_open:false,enter_tag:'codex-test'};
 const entry={pair:t.pair,ft_is_entry:true,ft_order_side:'buy',ft_order_tag:t.enter_tag,order_id:'1',status:'closed',is_open:false,filled:.01,cost:25,average:2500,remaining:0,order_filled_timestamp:Date.now()};
 const exit={...entry,ft_is_entry:false,ft_order_side:'sell',order_id:'2'};
 t.orders=[entry,exit];assert.equal(probeFillEvidence(t).roundTripVerified,true);
 for(const bad of [{status:'canceled'},{remaining:.001},{order_id:''},{filled:0},{pair:'BTC/USDT'}]){
  assert.equal(probeFillEvidence({...t,orders:[entry,{...exit,...bad}]}).roundTripVerified,false);
 }
 assert.equal(probeFillEvidence({...t,is_open:true}).roundTripVerified,false);
 assert.equal(probeFillEvidence({...t,orders:[]}).entryVerified,false);
 const compact={...entry};delete compact.ft_is_entry;delete compact.average;
 assert.equal(probeFillEvidence({...t,is_open:true,orders:[compact]}).entryVerified,true);
});
