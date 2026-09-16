// Research-only storage. No account, order or entry-decision APIs.
import {open,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readJson,writeJson,exists} from './io.mjs';
import {makeSpotFlowObservation,createSpotFlowObserverState,advanceSpotFlowObserver} from './spot-flow-observer.mjs';
import {createSpotCandidateStore} from './spot-candidate-store.mjs';

export function createSpotFlowStore(local){
 const recordCandidates=createSpotCandidateStore(local);
 const directory=join(local,'spot-flow-research'),statePath=join(directory,'state.json');
 let persisted=null;
 return async function record(sample,now=Date.now()){
  if(sample.mode!=='demo')throw Error('SPOT_OBSERVER_MODE');
  const candidateResearch=await recordCandidates(sample,now);
  if(!persisted){
   const loaded=await exists(statePath)?await readJson(statePath):{
    schemaVersion:1,observer:createSpotFlowObserverState({startedAt:now}),totalRecords:0};
   if(loaded.schemaVersion!==1||!Number.isSafeInteger(loaded.totalRecords)||loaded.totalRecords<0)throw Error('SPOT_OBSERVER_STATE');
   persisted=loaded;
  }
  const observations=Object.values(sample.markets??{}).map(proof=>makeSpotFlowObservation(proof,{
   now,policy:'order-flow-only-v1',assessment:sample.diagnostics?.[proof.pair],additionalCostBps:null,costSource:null}));
  const next=advanceSpotFlowObserver(persisted.observer,{now,observations});
  if(next.diagnostics.error)throw Error(next.diagnostics.error);
  await mkdir(directory,{recursive:true});
  // IDs in every record permit deduplication after a crash between append/state save.
  // Never treat a quote response as a fill or overwrite prior research records.
  const file=await open(join(directory,'observations-'+new Date(now).toISOString().slice(0,10)+'.jsonl'),'a+',0o600);
  try{
   const {size}=await file.stat();
   if(size){const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);if(tail[0]!==10)throw Error('OBSERVER_JOURNAL_INCOMPLETE');}
   if(next.records.length){await file.writeFile(next.records.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');await file.sync();}
  }finally{await file.close();}
  const updated={schemaVersion:1,observer:next.state,totalRecords:persisted.totalRecords+next.records.length,
   observedAt:new Date(now).toISOString(),collectorVersion:sample.collectorVersion,diagnostics:next.diagnostics};
  await writeJson(statePath,updated);persisted=updated;
  const status={status:'observing',usedForEntries:false,observedAt:updated.observedAt,candidateResearch,
   totalRecords:updated.totalRecords,recordsThisSample:next.records.length,diagnostics:next.diagnostics,
   unavailableReasons:observations.filter(o=>o.status!=='ok').reduce((counts,o)=>{counts[o.reason]=(counts[o.reason]??0)+1;return counts;},{}),
   accounting:'Prospective quote reactions, before fees when additional costs unavailable; never filled trades or realized PnL.'};
  await writeJson(join(directory,'status.json'),status);return status;
 };
}
