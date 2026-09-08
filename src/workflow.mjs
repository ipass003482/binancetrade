import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists,lock,writeJson } from './io.mjs';
import { collect } from './research.mjs';
import { analyze } from './codex.mjs';
import { execute } from './bridge.mjs';
import { healthUpdate,recordFailure,event,safeError } from './health.mjs';
export async function runCycle({local,policy,client,signal,collectFn=collect,analyzeFn=analyze,executeFn=execute}){
 return lock(join(local,'cycle.lock'),async()=>{
  if(await exists(join(local,'STOP')))return {status:'stopped',message:'Entries paused; engine exits remain active'};
  let snapshot,proposal;const runId=randomUUID(),startedAt=new Date().toISOString();
  try{
   await healthUpdate(local,{mode:policy.mode,stage:'collecting',lastCycleStartedAt:startedAt});
   const account=await client.snapshot();
   snapshot=await collectFn(policy);
   await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),snapshot);
   await healthUpdate(local,{stage:'analyzing',snapshotId:snapshot.id});
   const analysis=await analyzeFn(snapshot,policy,account,{signal});proposal=analysis.proposal;
   if(analysis.metadata)await writeJson(join(local,'runs',snapshot.id+'.analysis.json'),analysis.metadata);
   await writeJson(join(local,'runs',snapshot.id+'.proposal.json'),proposal);
   if(signal?.aborted)throw new Error('CYCLE_ABORTED');
   await healthUpdate(local,{stage:'executing'});
   const result=await executeFn({proposal,snapshot,policy,client,local});
   const outcome={mode:policy.mode,at:new Date().toISOString(),startedAt,snapshotId:snapshot.id,status:'completed',result};
   await writeJson(join(local,'runs',snapshot.id+'.outcome.json'),outcome);
   await healthUpdate(local,{stage:'idle',consecutiveFailures:0,lastError:null,lastSuccessAt:outcome.at});
   await event(local,{type:'cycle_completed',snapshotId:snapshot.id,action:proposal.action,result:result.status});
   return {snapshot:join(local,'runs',snapshot.id+'.snapshot.json'),proposal,runDir:analysis.runDir,result};
  }catch(error){
   const aborted=signal?.aborted===true;
   await writeJson(join(local,'runs',(snapshot?.id??runId)+'.outcome.json'),{
    mode:policy.mode,at:new Date().toISOString(),startedAt,snapshotId:snapshot?.id??null,status:aborted?'aborted':'failed',code:safeError(error)});
   if(aborted)await healthUpdate(local,{stage:'aborted'});else await recordFailure(local,error);
   throw error;
  }
 });
}
