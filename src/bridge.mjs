import { isEntry,isExit, isFutures } from './mode.mjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assess } from './risk.mjs';
import { market } from './research.mjs';
import { proposalSchema } from './config.mjs';
import { lock,journalRead,journalAppend,exists } from './io.mjs';
export async function execute({proposal,snapshot,policy,client,local,now=()=>Date.now(),getQuote=market}) {
 return lock(join(local,'execution.lock'),async()=>{
  const journal=join(local,'orders.jsonl'), records=await journalRead(journal);
  const id=createHash('sha256').update(snapshot.id).digest('hex').slice(0,32);
  if(records.some(r=>r.id===id)) throw new Error('SNAPSHOT_ALREADY_CONSUMED');
  const latest=new Map(records.map(r=>[r.id,r]));
  if([...latest.values()].some(r=>['pending','unknown'].includes(r.status))) throw new Error('UNRESOLVED_SUBMISSION: reconcile before more orders');
  proposalSchema(policy).parse(proposal);
  if(proposal.action!=='hold' && !policy.pairs.includes(proposal.pair)) throw new Error('PAIR_NOT_ALLOWED');
  const executionQuote=isEntry(proposal.action)?await getQuote(proposal.pair,{mode:policy.mode}):null;
  const account=await client.snapshot();
  const decision=assess({proposal,snapshot,policy,account,records,executionQuote,stopped:await exists(join(local,'STOP')),now:now()});
  const at=new Date(now()).toISOString();
  if(decision.action==='hold') {
   await journalAppend(journal,{id,at,status:'hold',action:'hold',snapshotId:snapshot.id,reason:proposal.reason});
   return {status:'hold',id};
  }
  const tag='codex-'+id;
  await journalAppend(journal,{id,at,status:'pending',action:proposal.action,pair:proposal.pair,stakeUsdt:proposal.stakeUsdt,
    snapshotId:snapshot.id,tag,tradeId:decision.tradeId??null,...(isFutures(policy.mode)?{leverage:proposal.leverage}:{})});
  try {
   if(isEntry(proposal.action) && await exists(join(local,'STOP'))) {
    await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'rejected',reason:'ENTRY_STOPPED_BEFORE_SEND'});
    throw new Error('ENTRY_STOPPED_BEFORE_SEND');
   }
   const result=await client.submit(proposal,tag,decision.tradeId,{validUntil:Math.min(
    Date.parse(snapshot.createdAt)+policy.maxSignalAgeSeconds*1000,
    executionQuote?Date.parse(executionQuote.fetchedAt)+15000:Infinity)});
   if(isEntry(proposal.action) && (!Number.isInteger(result?.trade_id)||result.pair!==proposal.pair||result.enter_tag!==tag))
    throw new Error('UNEXPECTED_ORDER_RESPONSE');
   if(isFutures(policy.mode)&&isEntry(proposal.action)&&(result.is_short!==(proposal.action==='open-short')||result.leverage!==proposal.leverage))throw new Error('UNEXPECTED_FUTURES_RESPONSE');
   if(isExit(proposal.action) && result?.result!==('Created exit order for trade '+decision.tradeId+'.'))
    throw new Error('UNEXPECTED_EXIT_RESPONSE');
   const record={id,at:new Date(now()).toISOString(),status:'submitted',action:proposal.action,
    tradeId:result.trade_id??decision.tradeId,pair:proposal.pair,tag};
   await journalAppend(journal,record);
   return record;
  } catch(e) {
   if(e.message==='ORDER_DEADLINE_EXPIRED')await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'rejected',reason:e.message});
   else if(e.message!=='ENTRY_STOPPED_BEFORE_SEND')
    await journalAppend(journal,{id,at:new Date(now()).toISOString(),status:'unknown',action:proposal.action,tag,reason:'Submission outcome requires reconciliation'});
   throw e;
  }
 });
}
