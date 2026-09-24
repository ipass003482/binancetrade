import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {kevFlowReference,kevFlowRule,kevFlowStake,KEV_FLOW_POLICY} from '../src/kev-flow.mjs';
import {assessOrderFlow} from '../src/order-flow.mjs';
import {reviewKevEntries,kevEntryRejection} from '../src/kev-entry.mjs';
import {runEntryBatch} from '../src/batch-entry.mjs';
import {kevReply} from './kev-fixtures.mjs';
import {KEV_CONFIRMATION_VERSION,KEV_CONFIRMATION_INTERVAL_MS} from '../src/kev-confirmation.mjs';

const boundary=Date.parse('2026-09-21T06:02:00Z'),now=boundary+20000;
const config={version:'kev-codex-entry-v1',baseUrl:'http://127.0.0.1:8009',model:'kev-codex',expectedModel:'gpt-6-luna',
 timeoutMs:15000,executionReserveMs:10000,approvalTtlMs:60000,maxCandidates:20,enabled:true,
 decisionMode:'autonomous',marketData:'order-flow'};
function fixture(mode='demo',direction='long'){
 const futures=mode==='demo-futures',pairs=['BTC','ETH'].map(s=>s+'/USDT'+(futures?':USDT':''));
 const policy={mode,pairs,maxStakeUsdt:futures?'150':'300',maxExposureUsdt:futures?'150':'900',
  maxOpenTrades:futures?1:3,maxSpreadBps:20},account={trades:[]};
 const cost={status:'ok',buyRate:'.0002',sellRate:'.0002',roundTripFeeBps:'4',spreadBps:'1',
  slippageBpsPerSide:5,fundingReserveBps:'0',estimatedRoundTripCostBps:'15',requiredPriceSpaceBps:'45'};
 const snapshot={id:'00000000-0000-4000-8000-000000000701',mode,entryPolicyVersion:KEV_FLOW_POLICY,
  timeframe:'order-flow',decisionCadenceVersion:'flow-minute-v1',decisionIntervalMs:60000,decisionBoundary:boundary,
  createdAt:new Date(now).toISOString(),markets:pairs.map(pair=>({pair,mode,timeframe:'order-flow',bid:'100',ask:'100.01',
   spreadBps:1,fetchedAt:new Date(now).toISOString(),verifiedSpot:!futures,verifiedFutures:futures,entryCost:{...cost},
   filters:[{filterType:'LOT_SIZE',minQty:'.001',maxQty:'100000',stepSize:'.001'},
    {filterType:'MARKET_LOT_SIZE',minQty:'.001',maxQty:'100000',stepSize:'.001'},
    {filterType:'MIN_NOTIONAL',minNotional:'5'}],
   orderFlow:{version:'sampled-demo-flow-v1',pair,mode,
    source:futures?'https://demo-fapi.binance.com':'https://demo-api.binance.com',startTime:now-61000,endTime:now-1000,
    books:[-20000,-10000,0].map((offset,i)=>({at:now+offset,updateId:i,
     // The default fixture has aligned buy tape and bid support.  The short
     // variant mirrors both sides so a futures short is independently valid.
     bids:Array.from({length:5},(_,k)=>[String(100+(direction==='long'?i*.01:-i*.01)-k*.001),direction==='long'?'2':'1']),
     asks:Array.from({length:5},(_,k)=>[String(100.005+(direction==='long'?i*.01:-i*.01)+k*.001),direction==='long'?'1':'2'])})),
    trades:Array.from({length:4},(_,i)=>({a:i,T:now-60000+i*18000,p:'100',q:'1',m:direction==='short'}))}}))};
 return {snapshot,policy,account,cost,config,direction,now:()=>now};
}
function priorConfirmationState(f){
 const action=f.policy.mode==='demo'?'buy':f.direction==='short'?'open-short':'open-long';
 const boundary=f.snapshot.decisionBoundary-KEV_CONFIRMATION_INTERVAL_MS,signals={};
 for(const pair of f.policy.pairs)signals[pair+'|'+action]={
  version:KEV_CONFIRMATION_VERSION,mode:f.policy.mode,pair,action,snapshotId:'00000000-0000-4000-8000-000000000702',boundary,previousBoundary:boundary-KEV_CONFIRMATION_INTERVAL_MS,intervalMs:KEV_CONFIRMATION_INTERVAL_MS,count:1,confirmed:false,firstBoundary:boundary,updatedAt:new Date(f.snapshot.createdAt).toISOString()
 };
 return {version:KEV_CONFIRMATION_VERSION,mode:f.policy.mode,intervalMs:KEV_CONFIRMATION_INTERVAL_MS,updatedAt:new Date(f.snapshot.createdAt).toISOString(),signals};
}
async function approved(f,choice){
 const reference=kevFlowReference(f.snapshot,f.policy,f.account,{now,confirmationState:priorConfirmationState(f)});
 return reviewKevEntries({...f,reference,
  fetchImpl:async(_url,{body})=>new Response(JSON.stringify(kevReply(JSON.parse(body),{choice,now})))});
}

test('aligned order-flow data reaches Kev without candles, forecasts or a deterministic long-side signal',()=>{
 const f=fixture(),market=f.snapshot.markets[0];
 assert.equal(assessOrderFlow(market.orderFlow,{mode:f.policy.mode,pair:market.pair,long:true,now}).eligible,true);
 const reference=kevFlowReference(f.snapshot,f.policy,f.account,{now});
 assert.equal(reference.proposal.action,'hold');assert.equal(reference.selected,null);
 assert.equal(reference.metadata.candidateDiagnostics.eligible,0);
 assert.equal(reference.metadata.candidateDiagnostics.hardBlocked,2);
 assert.deepEqual(reference.candidates.map(c=>c.action),['hold','hold']);
 assert.ok(reference.metadata.candidateDiagnostics.blockers.some(row=>row.reason==='KEV_FLOW_CONFIRMATION_PENDING'));
 for(const candidate of reference.candidates){
  assert.equal(candidate.timeframe,'order-flow');assert.equal(candidate.stopFraction,.005);
  assert.equal(candidate.targetFraction,.015);assert.equal(candidate.costSpace.targetBps,'150');assert.equal(candidate.stakeUsdt,'0');
  assert.ok(!Object.hasOwn(candidate,'atr15'));assert.ok(!Object.hasOwn(candidate,'model'));
 }
});

test('two adjacent aligned windows confirm entry and any mismatch resets the streak',()=>{
 const f=fixture(),first=kevFlowReference(f.snapshot,f.policy,f.account,{now}),state1=first.metadata.confirmationState;
 assert.equal(first.proposal.action,'hold');
 const secondSnapshot=structuredClone(f.snapshot);secondSnapshot.id='00000000-0000-4000-8000-000000000703';secondSnapshot.decisionBoundary+=KEV_CONFIRMATION_INTERVAL_MS;
 for(const market of secondSnapshot.markets){market.fetchedAt=new Date(Date.parse(market.fetchedAt)+KEV_CONFIRMATION_INTERVAL_MS).toISOString();market.orderFlow.startTime+=KEV_CONFIRMATION_INTERVAL_MS;market.orderFlow.endTime+=KEV_CONFIRMATION_INTERVAL_MS;market.orderFlow.books.forEach(book=>{book.at+=KEV_CONFIRMATION_INTERVAL_MS;});market.orderFlow.trades.forEach(trade=>{trade.T+=KEV_CONFIRMATION_INTERVAL_MS;});}
 const second=kevFlowReference(secondSnapshot,f.policy,f.account,{now:now+KEV_CONFIRMATION_INTERVAL_MS,confirmationState:state1});
 assert.equal(second.proposal.action,'hold');
 assert.equal(second.candidates[0].confirmation?.confirmed,true);
 assert.equal(second.candidates[0].confirmation?.count,2);
 const mismatch=structuredClone(secondSnapshot);mismatch.id='00000000-0000-4000-8000-000000000704';
 mismatch.markets[0].orderFlow.trades.forEach(t=>{t.m=true;});
 const reset=kevFlowReference(mismatch,f.policy,f.account,{now:now+KEV_CONFIRMATION_INTERVAL_MS,confirmationState:second.metadata.confirmationState});
 assert.equal(reset.candidates[0].confirmation,null);
 assert.equal(reset.candidates[0].reasons.includes('FLOW_TAPE_BOOK_MISMATCH'),true);
});

test('one-sided tape or book pressure is shadow-only and cannot become a Kev candidate',()=>{
 const f=fixture(),market=f.snapshot.markets[0];
 market.orderFlow.trades.forEach(t=>{t.m=true;});
 const rule=kevFlowRule({snapshot:f.snapshot,pair:market.pair,action:'buy',cost:f.cost,now});
 assert.equal(rule.action,'hold');assert.equal(rule.shadowOnly,true);assert.equal(rule.executionMode,'shadow');
 assert.ok(rule.reasons.includes('FLOW_TAPE_BOOK_MISMATCH'));
 const reference=kevFlowReference(f.snapshot,f.policy,f.account,{now});
 assert.equal(reference.metadata.shadowCandidates.length,1);
 assert.equal(reference.metadata.shadowCandidates[0].shadowReason,'FLOW_TAPE_BOOK_MISMATCH');
});

test('candidate diagnostics separate native hard blockers from Kev selection vetoes',async()=>{
 const f=fixture(),hold=await approved(f,'hold');
 const veto=kevFlowReference(f.snapshot,f.policy,f.account,{now,review:hold,confirmationState:priorConfirmationState(f)});
 assert.equal(veto.proposal.action,'hold');
 assert.match(veto.proposal.reason,/KEV_ENTRY_VETO/);
 assert.match(veto.proposal.reason,/blockers=none/);
 f.account.trades=[{pair:'BTC/USDT',stake_amount:'10'},{pair:'ETH/USDT',stake_amount:'10'},{pair:'SOL/USDT',stake_amount:'10'}];
 const blocked=kevFlowReference(f.snapshot,f.policy,f.account,{now,confirmationState:priorConfirmationState(f)});
 assert.equal(blocked.metadata.candidateDiagnostics.eligible,0);
 assert.equal(blocked.metadata.candidateDiagnostics.hardBlocked,2);
 assert.ok(blocked.metadata.candidateDiagnostics.blockers.some(row=>row.reason==='POSITION_OR_EXPOSURE_LIMIT'&&row.class==='hard'));
 assert.match(blocked.proposal.reason,/KEV_NO_ELIGIBLE_ENTRY/);
 assert.match(blocked.proposal.reason,/POSITION_OR_EXPOSURE_LIMIT/);
});

test('futures offers both directions for every pair and selects exactly the Kev-reviewed pair and side',async()=>{
 const f=fixture('demo-futures'),pool=kevFlowReference(f.snapshot,f.policy,f.account,{now,confirmationState:priorConfirmationState(f)});
 assert.deepEqual(pool.candidates.map(c=>[c.pair,c.requestedAction,c.action]),f.policy.pairs.flatMap(pair=>[[pair,'open-long','open-long'],[pair,'open-short','hold']]));
 const review=await approved(f,'q0'),reference=kevFlowReference(f.snapshot,f.policy,f.account,{now,review,confirmationState:priorConfirmationState(f)});
 assert.equal(reference.proposal.pair,f.policy.pairs[0]);assert.equal(reference.proposal.action,'open-long');
 assert.equal(reference.proposal.leverage,1);assert.equal(reference.selected.pair,f.policy.pairs[0]);
 assert.equal(kevEntryRejection({...f,proposal:reference.proposal,review,now}),null);
 assert.equal(kevEntryRejection({...f,proposal:{...reference.proposal,action:'open-short'},review,now}),'KEV_ENTRY_VETO');
 const short=fixture('demo-futures','short'),shortPool=kevFlowReference(short.snapshot,short.policy,short.account,{now,confirmationState:priorConfirmationState(short)});
 assert.ok(shortPool.candidates.every(c=>c.requestedAction==='open-long'?c.action==='hold':c.action==='open-short'));
});

test('Kev HOLD, multiple selections and unavailable selected candidates never fall back to deterministic entries',async()=>{
 const f=fixture(),hold=await approved(f,'hold');
 assert.equal(kevFlowReference(f.snapshot,f.policy,f.account,{now,review:hold,confirmationState:priorConfirmationState(f)}).proposal.action,'hold');
 const both={status:'reviewed',decisions:f.policy.pairs.map(pair=>({pair,action:'buy',approved:true}))};
 assert.equal(kevFlowReference(f.snapshot,f.policy,f.account,{now,review:both,confirmationState:priorConfirmationState(f)}).proposal.action,'hold');
 const review=await approved(f,'q1');
 f.account.trades=[{pair:f.policy.pairs[1],stake_amount:'10'}];
 const occupied=kevFlowReference(f.snapshot,f.policy,f.account,{now,review,confirmationState:priorConfirmationState(f)});
 assert.equal(occupied.proposal.action,'hold');assert.equal(occupied.selected,null);
 assert.equal(occupied.candidates[0].action,'buy');
});

test('data expiry, invalid source, missing trades and cost constraints prevent an entry without any candle fallback',()=>{
 for(const [mutate,reason] of [
  [f=>{const p=f.snapshot.markets[0].orderFlow;p.startTime-=46000;p.endTime-=46000;p.books.forEach(b=>b.at-=46000);p.trades.forEach(t=>t.T-=46000);},'FLOW_STALE'],
  [f=>f.snapshot.markets[0].orderFlow.source='https://api.binance.com','FLOW_SOURCE'],
  [f=>f.snapshot.markets[0].orderFlow.trades=[],'FLOW_INCOMPLETE'],
  [f=>f.cost.requiredPriceSpaceBps='151','KEV_FLOW_PRICE_SPACE_TOO_SMALL'],
  [f=>Object.assign(f.cost,{estimatedRoundTripCostBps:'50',requiredPriceSpaceBps:'80'}),'KEV_FLOW_NET_REWARD_RISK_TOO_SMALL']]){
  const f=fixture();mutate(f);
  const rule=kevFlowRule({snapshot:f.snapshot,pair:f.policy.pairs[0],action:'buy',cost:f.cost,now});
  assert.equal(rule.action,'hold');assert.ok(rule.reasons.includes(reason),JSON.stringify(rule.reasons));
 }
 const f=fixture(),expired=kevFlowRule({snapshot:f.snapshot,pair:f.policy.pairs[0],action:'buy',cost:f.cost,now:boundary+60000});
 assert.equal(expired.action,'hold');assert.ok(expired.reasons.includes('KEV_FLOW_DECISION_EXPIRED'));
});

test('Kev native entry gate blocks a volatility shock before model approval can enter',()=>{
 const f=fixture(),book=f.snapshot.markets[0].orderFlow.books[2];
 for(const row of book.bids)row[0]=String(Number(row[0])+1);
 for(const row of book.asks)row[0]=String(Number(row[0])+1);
 const rule=kevFlowRule({snapshot:f.snapshot,pair:f.policy.pairs[0],action:'buy',cost:f.cost,now});
 assert.equal(rule.action,'hold');assert.ok(rule.reasons.includes('FLOW_VOLATILITY_SHOCK'),JSON.stringify(rule.reasons));
});

test('fixed 150-bps gross target admits realistic 31-bps spot costs without claiming a forecast return',()=>{
 const f=fixture(),cost={...f.cost,buyRate:'.001',sellRate:'.001',roundTripFeeBps:'20',estimatedRoundTripCostBps:'31',requiredPriceSpaceBps:'61'};
 const rule=kevFlowRule({snapshot:f.snapshot,pair:f.policy.pairs[0],action:'buy',cost,now});
 assert.equal(rule.action,'buy');assert.equal(rule.targetFraction,.015);assert.equal(rule.stopFraction,.005);
 assert.equal(rule.costSpace.targetBps,'150');assert.ok(Number(rule.netRewardRisk.ratio)>1);
 const stake=new Decimal(kevFlowStake(rule,cost,f.policy));
 assert.ok(stake.mul(new Decimal('.005').plus('.0031').plus('.005')).lte(1));
});

test('stake includes stop, modeled round-trip costs and the spot execution reserve within one USDT risk',()=>{
 for(const mode of ['demo','demo-futures']){
  const f=fixture(mode),rules=kevFlowRule({snapshot:f.snapshot,pair:f.policy.pairs[0],action:mode==='demo'?'buy':'open-long',cost:f.cost,now});
  const stake=kevFlowStake(rules,f.cost,f.policy),fraction=new Decimal('.005').plus('.0015').plus(mode==='demo'?'.005':'0');
  assert.ok(new Decimal(stake).mul(fraction).lte(1));
  assert.ok(new Decimal(stake).lte(f.policy.maxStakeUsdt));
  assert.equal(kevFlowStake(rules,f.cost,f.policy,'12'),'12.00000000');
  if(mode==='demo')assert.equal(stake,'86.95652173');
 }
});

for(const status of ['submitted','filtered'])test('Kev order-flow batch tries only the reviewed choice after '+status,async()=>{
 const f=fixture(),review=await approved(f,'q1'),reference=kevFlowReference(f.snapshot,f.policy,f.account,{now,review,confirmationState:priorConfirmationState(f)});
 const calls=[],saved=[],protection=[];
 const result=await runEntryBatch({...f,reference,kevReview:review,local:'unused-kev-test',
  save:async(_path,value)=>saved.push(structuredClone(value)),client:{snapshot:async()=>f.account},
  executeFn:async args=>{calls.push(args.proposal);assert.equal(args.kevReview,review);return {status};},
  select:()=>assert.fail('A selected Kev entry must never fall back to a ranker'),
  waitForProtection:async args=>{protection.push(args.pair);return args.account;}});
 assert.equal(calls.length,1);assert.equal(calls[0].pair,f.policy.pairs[1]);
 assert.equal(result.attempts.length,1);assert.equal(result.submittedCount,status==='submitted'?1:0);
 assert.deepEqual(protection,status==='submitted'?[f.policy.pairs[1]]:[]);
 assert.equal(saved.at(-1).status,'completed');
});
