// Offline cross-language contract fixture. All account, quote, clock and adapter
// operations are injected. The real bridge writes plans only under a temp root.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execute} from '../src/bridge.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson,journalRead,writeJson} from '../src/io.mjs';
import {loadKevEntryConfig,reviewKevEntries} from '../src/kev-entry.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {BATCH_EXECUTION_VERSION} from '../src/entry-identity.mjs';
import {clockFixture,syntheticModelEvidence} from './fixtures.mjs';

export const AI_BRIDGE_TEST_NOW=Date.parse('2026-09-14T00:00:20Z');
export async function buildAiBridgePlan({mode='demo',short=false,kev}={}){
 const now=Date.now(),boundary=Math.floor(now/300000)*300000,iso=new Date(now).toISOString();
 const pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT';
 const source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const clock=clockFixture(now,mode),policy=await loadPolicy(mode);
 const candles=Array.from({length:96},(_,i)=>({openTime:boundary-(96-i)*300000,
  closeTime:boundary-(95-i)*300000-1,open:'100',high:'101',low:'99',close:'100',volume:'10'}));
 const market={pair,mode,source,verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',
  bid:'100',ask:'100.01',spreadBps:1,fundingRate:'0',fetchedAt:iso,clock,candles,orderFlow:null,
  filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},
   {filterType:'MARKET_LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},
   {filterType:'MIN_NOTIONAL',minNotional:'5',notional:'5'}]};
 const snapshot={id:randomUUID(),mode,timeframe:'5m',ruleVersion:'kronos-direction-v12',
  createdAt:iso,completedAt:iso,candleBoundary:boundary,clock,decisionEngine:'rules',
  decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:boundary,
  aiAssist:{version:'kronos-flow-v1',enabled:true,entryMode:'ai-only'},markets:[market],
  evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}},
   {id:'technical:'+pair,pair,status:'ok'}],
  costFacts:{mode,kind:'costs',readOnly:true,source,observedAt:iso,
   rates:[{pair,status:'ok',buyRate:'.001',sellRate:'.001'}]}};
 const proposal={snapshotId:snapshot.id,pair,action:mode==='demo'?'buy':short?'open-short':'open-long',
  stakeUsdt:'25',evidenceIds:[(mode==='demo'?'spot:':'futures:')+pair],reason:'Offline AI bridge contract test',
  ...(mode==='demo-futures'?{leverage:1}:{})};
 const engine={strategy_version:'demo-rule-exits-v12'};
 const account={engine,trades:[],balance:{stake:'USDT',currencies:[{currency:'USDT',free:1000}]},
  daily:{stake_currency:'USDT',data:[{date:iso.slice(0,10),abs_profit:0}]}};
 const local=await mkdtemp(join(tmpdir(),'binancetrade-ai-bridge-'));
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN');};
 let plan,adapterCalls=0,quoteCalls=0,kevReview;
 try{
  if(kev){
   await writeJson(join(local,'kev-entry.json'),{version:'kev-codex-entry-v1',enabled:true,mode,activatedAt:iso});
   if(kev!=='missing'){
    const kevConfig=await loadKevEntryConfig({local,mode});
    const requestedChoice=kevConfig.decisionMode==='autonomous'&&kev==='approve'?'q0':kev;
    kevReview=await reviewKevEntries({snapshot,policy,account,
    reference:{proposal,selected:{pair},candidates:[{...proposal,selectionScoreBps:'20',requiredPriceSpaceBps:'50',
     entryConfirmation:{originClose:'100',forecastCloses:short?['98','97','96']:['102','103','104']}}]},
    config:kevConfig,now:()=>now,
    fetchImpl:async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{choice:requestedChoice,now})))});
   }
  }
  const client={snapshot:async()=>account,submit:async(p,tag,id,{beforeSend})=>{
   const check=await beforeSend(engine);check();
   plan=await readJson(join(local,'entry-plans',tag+'.json'));
   adapterCalls++;
   return {trade_id:1,pair:p.pair,enter_tag:tag,
    ...(mode==='demo-futures'?{is_short:short,leverage:1}:{})};
  }};
  const result=await execute({snapshot,proposal,policy,client,local,now:()=>now,
   modelEvidence:syntheticModelEvidence(snapshot,{direction:short?'short':'long'}),
   executionPolicyVersion:BATCH_EXECUTION_VERSION,getQuote:async()=>{quoteCalls++;return market;},getClock:async()=>clock,kevReview,
   getDecisionConfig:async()=>({version:1,demoEngine:'rules',ruleVersion:'kronos-direction-v12'}),
   getVolumeConfig:async()=>({version:1,enabled:false,startAt:'2026-09-11T00:00:00.000Z'}),
   portfolioEntryFn:async(_options,run)=>run(async()=>({checked:true})),
   protectionCheckFn:async()=>({verified:true,engineProcessId:12345})});
  if(kev==='hold'||kev==='missing')return {result,adapterCalls,quoteCalls,records:await journalRead(join(local,'orders.jsonl'))};
  assert.equal(result.status,'submitted');
  assert.equal(adapterCalls,1);
  return {plan,mode,pair,short,now,boundary,rate:Number(short?market.bid:market.ask),amount:.1,
   snapshotCadence:{decisionCadenceVersion:snapshot.decisionCadenceVersion,
    decisionIntervalMs:snapshot.decisionIntervalMs,decisionBoundary:snapshot.decisionBoundary},
   records:await journalRead(join(local,'orders.jsonl'))};
 }finally{
  globalThis.fetch=originalFetch;
  await rm(local,{recursive:true,force:true});
 }
}
