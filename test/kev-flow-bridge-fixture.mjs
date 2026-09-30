// Real bridge contract, with all network/account/order I/O replaced by fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execute} from '../src/bridge.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson,writeJson,journalRead} from '../src/io.mjs';
import {loadKevEntryConfig,reviewKevEntries} from '../src/kev-entry.mjs';
import {kevFlowReference,KEV_FLOW_POLICY} from '../src/kev-flow.mjs';
import {attachCosts,loadCosts} from '../src/trading-costs.mjs';
import {clockFixture} from './fixtures.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {BATCH_EXECUTION_VERSION,entryArtifactStem} from '../src/entry-identity.mjs';
import {KEV_CONFIRMATION_VERSION,KEV_CONFIRMATION_INTERVAL_MS} from '../src/kev-confirmation.mjs';
import {KEV_ENTRY_SIGNAL_POLICY} from '../src/kev-entry-signal.mjs';
import Decimal from 'decimal.js';
import {JEV_ENTRY_VERSION,JEV_MODEL,JEV_BASE_URL} from '../src/reviewer-identity.mjs';

export const KEV_BRIDGE_TEST_NOW=Date.parse('2026-09-21T00:02:20Z');
function priorConfirmation(snapshot,{mode,pair,action}){
 const boundary=snapshot.decisionBoundary-KEV_CONFIRMATION_INTERVAL_MS;
 return {version:KEV_CONFIRMATION_VERSION,mode,intervalMs:KEV_CONFIRMATION_INTERVAL_MS,updatedAt:new Date(snapshot.createdAt).toISOString(),signals:{[pair+'|'+action]:{
  version:KEV_CONFIRMATION_VERSION,mode,pair,action,snapshotId:randomUUID(),boundary,previousBoundary:boundary-KEV_CONFIRMATION_INTERVAL_MS,
  intervalMs:KEV_CONFIRMATION_INTERVAL_MS,count:1,confirmed:false,firstBoundary:boundary,updatedAt:new Date(snapshot.createdAt).toISOString()
 }}};
}
export async function buildKevFlowBridgePlan({mode='demo',short=false,quoteMoveBps=0,coherent=false,provider='kev'}={}){
 const now=Date.now(),boundary=Math.floor(now/60000)*60000,iso=new Date(now).toISOString(),
  pair=mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com',
  clock=clockFixture(now,mode),policy=await loadPolicy(mode);
 const flowShort=mode==='demo-futures'&&short;
 const books=[-20000,-10000,0].map((delta,i)=>({at:now+delta,updateId:i+1,
  bids:Array.from({length:5},(_,k)=>[String(100+(flowShort?-i*.01:i*.01)-k*.01),flowShort?'1':'2']),
  asks:Array.from({length:5},(_,k)=>[String(100.01+(flowShort?-i*.01:i*.01)+k*.01),flowShort?'2':'1'])}));
 const orderFlow={version:'sampled-demo-flow-v1',mode,pair,source,books,startTime:now-61000,endTime:now-1000,
  trades:[0,1,2].map(i=>({a:i+1,T:now-55000+i*25000,p:'100',q:'1',m:flowShort}))};
 if(coherent){
  orderFlow.trades=[[-20000,'3',flowShort],[-15000,'2',!flowShort],[-10000,'3',flowShort],[-1000,'2',!flowShort]]
   .map(([offset,q,m],index)=>({a:index+1,T:now+offset,p:'100',q,m}));
  // This prospective fixture deliberately has opposing static depth; only
  // the simultaneous tape and executable price response support the entry.
  for(const b of books){for(const row of b.bids)row[1]=flowShort?'2':'1';for(const row of b.asks)row[1]=flowShort?'1':'2';}
 }
 const market={pair,mode,source,timeframe:'order-flow',verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',
  bid:'100',ask:'100.01',spreadBps:1,fundingRate:'0',fetchedAt:iso,clock,orderFlow,
  filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},
   {filterType:'MARKET_LOT_SIZE',minQty:'.001',maxQty:'10000',stepSize:'.001'},
   {filterType:'MIN_NOTIONAL',minNotional:'5',notional:'5'}]};
 if(coherent){
  Object.assign(market,{bid:books[2].bids[0][0],ask:books[2].asks[0][0]});
  market.spreadBps=new Decimal(market.ask).minus(market.bid).div(market.bid).mul(10000).toNumber();
 }
 const snapshot={id:randomUUID(),mode,timeframe:'order-flow',entryPolicyVersion:KEV_FLOW_POLICY,ruleVersion:KEV_FLOW_POLICY,
  createdAt:iso,completedAt:iso,clock,decisionEngine:'rules',decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,
  decisionBoundary:boundary,markets:[market],evidence:[{id:(mode==='demo'?'spot:':'futures:')+pair,status:'ok',data:{pair}}]};
 if(coherent)snapshot.entrySignalPolicy={...KEV_ENTRY_SIGNAL_POLICY};
 const costConfig=await loadCosts();
 attachCosts(snapshot,{schemaVersion:1,mode,kind:'costs',readOnly:true,source,observedAt:iso,
  rates:[{pair,status:'ok',buyRate:'.001',sellRate:'.001',
   method:mode==='demo'?'standard_plus_tax_plus_special_no_bnb_discount':'symbol_taker_rate'}]},costConfig);
 const engine={strategy_version:'demo-rule-exits-v13'},account={engine,trades:[],
  balance:{stake:'USDT',currencies:[{currency:'USDT',free:1000}]},daily:{stake_currency:'USDT',data:[{date:iso.slice(0,10),abs_profit:0}]}};
 const local=await mkdtemp(join(tmpdir(),'kev-flow-bridge-')),originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
 try{
  await writeJson(join(local,'kev-entry.json'),{version:'kev-codex-entry-v1',enabled:true,mode,activatedAt:iso,decisionMode:'autonomous'});
  const originalConfig=await loadKevEntryConfig({local,mode}),config=provider==='jev'?{
   ...originalConfig,version:JEV_ENTRY_VERSION,baseUrl:JEV_BASE_URL,model:JEV_MODEL,expectedModel:JEV_MODEL,
   provider:'typesafe-api',providerRevision:randomUUID(),credentialId:randomUUID()}:originalConfig;
  if(provider==='jev')snapshot.kevEntry={version:config.version,enabled:true,model:config.expectedModel,decisionMode:'autonomous',
   role:'autonomous_selection',provider:config.provider,providerRevision:config.providerRevision};
  const firstAction=mode==='demo'?'buy':short?'open-short':'open-long';
  const firstState=coherent?undefined:priorConfirmation(snapshot,{mode,pair,action:firstAction});
  const reference=kevFlowReference(snapshot,policy,account,{now,confirmationState:firstState});
  const kevReview=await reviewKevEntries({reference,snapshot,policy,account,config,now:()=>now,
   credentialFn:async()=> 'synthetic-key-offline-only',
   fetchImpl:async(_url,{body})=>{const r=kevReply(JSON.parse(body),{choice:'q0',now});
    return new Response(JSON.stringify(provider==='jev'?{model:JEV_MODEL,answers:r.answers,usage:{input_tokens:100,output_tokens:0}}:r));}});
  assert.equal(kevReview.status,'reviewed',kevReview.reason+' '+JSON.stringify(reference.metadata.candidateDiagnostics.blockers));
  await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),snapshot);
  await writeJson(join(local,'runs',snapshot.id+'.kev-review.json'),kevReview);
  const selected=kevFlowReference(snapshot,policy,account,{now,review:kevReview,confirmationState:reference.metadata.confirmationState});
  assert.equal(selected.proposal.action,mode==='demo'?'buy':short?'open-short':'open-long');
  let plan,calls=0;
  const client={snapshot:async()=>account,submit:async(p,tag,_id,{beforeSend})=>{
   const check=await beforeSend(engine);check();plan=await readJson(join(local,'entry-plans',tag+'.json'));calls++;
   return {trade_id:1,pair,enter_tag:tag,...(mode==='demo-futures'?{is_short:short,leverage:1}:{})};
  }};
  const factor=new Decimal(1).plus(new Decimal(quoteMoveBps).div(10000)),executionQuote={...market,
   bid:new Decimal(market.bid).mul(factor).toFixed(),ask:new Decimal(market.ask).mul(factor).toFixed()};
  const result=await execute({snapshot,proposal:selected.proposal,policy,client,local,now:()=>now,kevReview,getKevConfig:async()=>config,
   executionPolicyVersion:BATCH_EXECUTION_VERSION,getQuote:async()=>executionQuote,getClock:async()=>clock,
   portfolioEntryFn:async(_options,run)=>run(async()=>({checked:true})),protectionCheckFn:async()=>({verified:true,engineProcessId:12345})});
  const rejected=Math.abs(quoteMoveBps)>5;
  assert.equal(result.status,rejected?'filtered':'submitted',JSON.stringify(result));assert.equal(calls,rejected?0:1);
  return {plan,snapshot,costConfig,result,submitCalls:calls,coherent,policy,account,config,reference,selected,kevReview,
   priceCheck:await readJson(join(local,'runs',entryArtifactStem(snapshot.id,pair,BATCH_EXECUTION_VERSION)+'.execution-price-check.json')),
   executionQuote:await readJson(join(local,'runs',entryArtifactStem(snapshot.id,pair,BATCH_EXECUTION_VERSION)+'.execution-quote.json')),
   reviewRaw:await readFile(join(local,'runs',snapshot.id+'.kev-review.json'),'utf8'),
   mode,pair,short,now,boundary,amount:.1,rate:Number(short?market.bid:market.ask),records:await journalRead(join(local,'orders.jsonl'))};
 }finally{globalThis.fetch=originalFetch;await rm(local,{recursive:true,force:true});}
}
