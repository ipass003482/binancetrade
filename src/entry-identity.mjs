import {createHash} from 'node:crypto';
export const BATCH_EXECUTION_VERSION='per-pair-cycle-v1';
export function entryId(snapshotId,pair,executionPolicyVersion){
 if(executionPolicyVersion!==undefined&&executionPolicyVersion!==BATCH_EXECUTION_VERSION)throw Error('ENTRY_IDENTITY_VERSION');
 if(executionPolicyVersion&&(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshotId??'')||
  !/^[A-Z0-9]+\/USDT(?::USDT)?$/.test(pair??'')))throw Error('ENTRY_IDENTITY_INVALID');
 return createHash('sha256').update(executionPolicyVersion?JSON.stringify([executionPolicyVersion,snapshotId,pair]):snapshotId).digest('hex').slice(0,32);
}
export function recordedEntryId(record){try{return entryId(record.snapshotId,record.pair,record.executionPolicyVersion);}catch{return null;}}
export function entryArtifactStem(snapshotId,pair,executionPolicyVersion){
 return executionPolicyVersion?snapshotId+'.'+entryId(snapshotId,pair,executionPolicyVersion):snapshotId;
}
