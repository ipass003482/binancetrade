import {join} from 'node:path';
import {writeJson} from './io.mjs';
import {rulesProposal} from './decision.mjs';
import {BATCH_EXECUTION_VERSION,entryArtifactStem} from './entry-identity.mjs';
import {assertNativeProtection} from './protection.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {kevBlockedPairs} from './kev-entry.mjs';
import {isKevFlow} from './kev-flow.mjs';
// Native exchange protection is installed by the engine's next loop, after the
// entry RPC returns. Wait for verified protection before another entry; never
// reinterpret an unresolved stop or continue after the bounded wait expires.
export async function waitForNativeEntryProtection({account,client,policy,local,pair,signal,
 check=assertNativeProtection,pause=ms=>delay(ms,null,{signal}),now=Date.now}){
 const deadline=now()+10000;
 for(;;){
  if(signal?.aborted)throw Error('CYCLE_ABORTED');
  if(now()>=deadline)throw Error('NATIVE_ENTRY_PROTECTION_TIMEOUT');
  try{
   await check({mode:policy.mode,local,account,pair});
   if(signal?.aborted)throw Error('CYCLE_ABORTED');
   if(now()>=deadline)throw Error('NATIVE_ENTRY_PROTECTION_TIMEOUT');
   return account;
  }catch(error){
   // Immediately after the entry RPC returns, the native engine may still be
   // reconciling the newly-created position and protective stop. Both states
   // are transient during this bounded post-fill wait; keep polling until the
   // stop is proven active or the timeout expires. Invalid, stale, orphaned,
   // or otherwise unsupported protection states still fail closed.
   if(!['NATIVE_PROTECTION_POSITION_UNPROTECTED','NATIVE_PROTECTION_RECONCILIATION_REQUIRED'].includes(error.message))throw error;
  }
  if(now()>=deadline)throw Error('NATIVE_ENTRY_PROTECTION_TIMEOUT');
  await pause(Math.min(500,deadline-now()));
  if(signal?.aborted)throw Error('CYCLE_ABORTED');
  if(now()>=deadline)throw Error('NATIVE_ENTRY_PROTECTION_TIMEOUT');
  account=await client.snapshot();
 }
}
// Serial processing of distinct eligible pairs in one immutable model cycle.
// Every execute call retains all existing quote/account/risk/native checks.
export async function runEntryBatch({reference,snapshot,policy,client,local,modelEvidence,strategyVersion,executeFn,signal,kevReview,
 save=writeJson,select=rulesProposal,waitForProtection=waitForNativeEntryProtection}){
 const attempts=[],attempted=new Set(),path=join(local,'runs',snapshot.id+'.batch.json');
 const persist=extra=>save(path,{version:BATCH_EXECUTION_VERSION,snapshotId:snapshot.id,mode:policy.mode,
  at:new Date().toISOString(),attempts,...extra});
 let current=reference;
 try{
  for(let n=0;n<policy.pairs.length;n++){
   if(signal?.aborted)throw Error('CYCLE_ABORTED');
   const proposal=current.proposal;
   if(proposal.action==='hold')break;
   if(attempted.has(proposal.pair))throw Error('BATCH_DUPLICATE_PAIR');
   attempted.add(proposal.pair);
   const stem=entryArtifactStem(snapshot.id,proposal.pair,BATCH_EXECUTION_VERSION);
   // The original cycle proposal represents the first candidate. Secondary
   // candidates get their own proposal file, never overwrite another pair.
   if(n>0)await save(join(local,'runs',stem+'.proposal.json'),proposal);
   const attempt={pair:proposal.pair,proposal,artifactStem:stem,startedAt:new Date().toISOString(),status:'executing'};
   attempts.push(attempt);await persist({status:'executing'});
   const result=await executeFn({proposal,snapshot,policy,client,local,modelEvidence,strategyVersion,executionPolicyVersion:BATCH_EXECUTION_VERSION,kevReview});
   attempt.status=result.status;attempt.result=result;await persist({status:'executing'});
   if(!['submitted','filtered','hold'].includes(result.status))throw Error('BATCH_UNEXPECTED_OUTCOME');
   if(!['submitted','filtered'].includes(result.status))break;
   // Recompute available funds, held pairs, sizing and capacity after each
   // confirmed response. Unknown/throwing submissions terminate this batch.
   let account=await client.snapshot();
   if(result.status==='submitted'&&['demo','demo-futures'].includes(policy.mode)){
    await persist({status:'waiting_protection'});
    account=await waitForProtection({account,client,policy,local,pair:proposal.pair,signal});
    attempt.protectionConfirmedAt=new Date().toISOString();
    await persist({status:'executing'});
   }
   // The autonomous flow request authorizes exactly one pair and side. A
   // filtered/filled choice never falls back to a second deterministic entry.
   if(isKevFlow(snapshot))break;
   current=select(snapshot,policy,account,modelEvidence,{excludedPairs:[...new Set([...attempted,...kevBlockedPairs(kevReview,policy)])]});
  }
  const submitted=attempts.filter(a=>a.status==='submitted').length;
  const result={status:submitted?'submitted':attempts.length?'filtered':'hold',executionPolicyVersion:BATCH_EXECUTION_VERSION,
   ...(attempts.length===1?attempts[0].result:{}),
   reasons:[...new Set(attempts.flatMap(a=>a.result?.reasons??[]))],
   submittedCount:submitted,attempts:attempts.map(a=>({pair:a.pair,...a.result}))};
  await persist({status:'completed',result});return result;
 }catch(error){await persist({status:'interrupted',reason:String(error.code??error.message).slice(0,160)});throw error;}
}
