import {open,mkdir,readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readJson,writeJson,exists} from './io.mjs';
import {makeInitialSpotCandidates,freshSpotCandidateQuotes,newSpotCandidateState,advanceSpotCandidates,recoverSpotCandidateState,validateSpotCandidateState} from './spot-candidate.mjs';

const queues=new Map(),MAX_QUEUE=256;
function queueFor(local){
 const key=resolve(local);if(!queues.has(key)){
  if(queues.size>=32){const free=[...queues].find(([,q])=>!q.items.length);if(free)queues.delete(free[0]);else return null;}
  queues.set(key,{items:[],dropped:0,invalid:0});
 }
 return queues.get(key);
}
// Called by workflow after its existing immutable snapshot/rules writes. No I/O,
// no promises, no research failure can delay or reject a trade decision.
export function enqueueInitialSpotCandidates(local,input){
 try{
  const q=queueFor(local);if(!q)return {accepted:0,dropped:1};
  const rows=makeInitialSpotCandidates(input);let accepted=0;
  for(const row of rows){if(q.items.length>=MAX_QUEUE)q.dropped++;else{q.items.push(row);accepted++;}}
  return {accepted,dropped:q.dropped};
 }catch{const q=queueFor(local);if(q)q.invalid++;return {accepted:0,invalid:true};}
}

export function createSpotCandidateStore(local){
 const directory=join(local,'spot-candidate-research'),statePath=join(directory,'state.json');let state=null,known=null,recoverySize={bytes:0,journalFiles:0};
 return async function record(sample,now=Date.now()){
  if(sample?.mode!=='demo')return {status:'not_applicable',usedForEntries:false};
  const q=queueFor(local);if(!q)return {status:'unavailable',reason:'CANDIDATE_QUEUE_CAPACITY',usedForEntries:false};
  try{
   // A workflow can enqueue while an older sampler observation is awaiting I/O.
   // Keep those newer candidates queued until sampler time catches up.
   const candidates=q.items.filter(c=>c.createdAt<=now);
   if(!state){const checkpoint=await exists(statePath)?validateSpotCandidateState(await readJson(statePath),now):null;
    known=new Set();const recovered=[];
    // Deduplicate append-before-state-save crashes using existing immutable rows.
    // A previously saved first outcome always wins; never replace its quote.
    const earliest=checkpoint?Math.min(checkpoint.lastNow,...checkpoint.pending.map(p=>p.candidate.createdAt)):null;
    const since=earliest===null?null:new Date(Math.max(0,earliest-86400000)).toISOString().slice(0,10);
    const journals=await exists(directory)?(await readdir(directory)).filter(n=>/^candidates-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)&&(!since||n.slice(11,21)>=since)).sort():[];
    recoverySize={bytes:0,journalFiles:journals.length};if(journals.length>128)throw Error('CANDIDATE_JOURNAL_CAPACITY');let recoveryBytes=0;
    for(const name of journals){
     const path=join(directory,name);recoveryBytes+=(await stat(path)).size;recoverySize.bytes=recoveryBytes;if(recoveryBytes>67108864)throw Error('CANDIDATE_JOURNAL_CAPACITY');
     const text=await readFile(path,'utf8');if(text&&!text.endsWith('\n'))throw Error('CANDIDATE_JOURNAL_INCOMPLETE');
     if(text.length>33554432)throw Error('CANDIDATE_JOURNAL_CAPACITY');
     for(const line of text.split('\n'))if(line){const row=JSON.parse(line);if(typeof row.recordId!=='string')throw Error('CANDIDATE_JOURNAL_INVALID');known.add(row.recordId);recovered.push(row);}
    }
    state=recoverSpotCandidateState(checkpoint,recovered,now);
    if(!checkpoint)state.lastNow=Math.min(state.lastNow,...candidates.map(c=>c.createdAt));
   }
   const next=advanceSpotCandidates(state,{now,candidates,quotes:freshSpotCandidateQuotes(sample,now)});
   const fresh=next.records.filter(r=>!known.has(r.recordId));
   await mkdir(directory,{recursive:true});
   const file=await open(join(directory,'candidates-'+new Date(now).toISOString().slice(0,10)+'.jsonl'),'a+',0o600);
   try{
    const {size}=await file.stat();if(size){const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);if(tail[0]!==10)throw Error('CANDIDATE_JOURNAL_INCOMPLETE');}
    if(fresh.length){await file.writeFile(fresh.map(r=>JSON.stringify(r)).join('\n')+'\n','utf8');await file.sync();}
   }finally{await file.close();}
   for(const r of fresh)known.add(r.recordId);
   // This cache only covers crash duplicate suppression, not attribution history.
   // Pending/seen in durable state prevent normal replay beyond the cache bound.
   while(known.size>32768)known.delete(known.values().next().value);
   await writeJson(statePath,next.state);state=next.state;const acknowledged=new Set(candidates);q.items=q.items.filter(c=>!acknowledged.has(c));
   const status={status:'observing',observedAt:new Date(now).toISOString(),usedForEntries:false,recordsThisSample:fresh.length,pending:state.pending.length,
    queueDropped:q.dropped,queueInvalid:q.invalid,diagnostics:next.diagnostics,recoverySize,note:'Initial candidates only; bridge eligibility unknown; estimated quote markout is not trading PnL. In-memory queue coverage is not reconciled.'};
   await writeJson(join(directory,'status.json'),status);return status;
  }catch(error){
   state=null;known=null;
   const safeReasons=['CANDIDATE_JOURNAL_CAPACITY','CANDIDATE_JOURNAL_INCOMPLETE','CANDIDATE_JOURNAL_INVALID','CANDIDATE_STATE_INVALID','CANDIDATE_STATE_ORPHAN','CANDIDATE_PENDING_INVALID','CANDIDATE_CONFLICT','CANDIDATE_RECOVERY_CAPACITY'];
   const status={status:'unavailable',observedAt:new Date(now).toISOString(),usedForEntries:false,reason:safeReasons.includes(error?.message)?error.message:'CANDIDATE_RESEARCH_WRITE_OR_STATE_FAILED',queueDropped:q.dropped,recoverySize};
   try{await writeJson(join(directory,'status.json'),status);}catch{}
   return status;
  }
 };
}
