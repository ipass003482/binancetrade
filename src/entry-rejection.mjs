// Negative proof is useful only for the exact, one-shot native RPC attempt.
// A timeout, HTTP error, absent order or stale receipt is not negative proof.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function entryPlanDigest(plan){return hash(JSON.stringify(plan,null,2)+'\n');}
export async function readEntryRejection({local,plan,attempt,now=Date.now()}){
 try{
  if(!plan||!attempt||!/^codex-[a-f0-9]{32}$/.test(plan.tag??'')
   ||!['demo','demo-futures'].includes(attempt.mode)||!Number.isSafeInteger(attempt.processId)||attempt.processId<1
   ||!Number.isFinite(attempt.startedAt)||!Number.isFinite(now)||now<attempt.startedAt
   ||attempt.planSha256!==entryPlanDigest(plan))return null;
  const raw=await readFile(join(local,'entry-rejections',plan.tag+'.json'));
  if(raw.length>8192)return null;
  const receipt=JSON.parse(raw);
  const rejectedAt=Date.parse(receipt.rejectedAt),createdAt=Date.parse(plan.createdAt);
  if(receipt.schemaVersion!==1||receipt.phase!=='callback_before_order'
   ||receipt.tag!==plan.tag||receipt.snapshotId!==plan.snapshotId||receipt.pair!==plan.pair
   ||receipt.mode!==attempt.mode||receipt.mode!==plan.nativeEntryGuard?.mode
   ||receipt.decisionBoundary!==(plan.decisionBoundary??plan.nativeEntryGuard?.candleBoundary)
   ||receipt.nativeEntryGuardVersion!==plan.nativeEntryGuard?.version
   ||!['kronos-native-entry-v10','kronos-native-entry-v11','kronos-native-entry-v12'].includes(receipt.nativeEntryGuardVersion)
   ||receipt.planCreatedAt!==plan.createdAt||receipt.planSha256!==attempt.planSha256
   ||receipt.processId!==attempt.processId
   ||!Number.isFinite(createdAt)||createdAt>attempt.startedAt
   ||!Number.isFinite(rejectedAt)||rejectedAt<attempt.startedAt||rejectedAt>now
   ||!/^(?:DEMO_NATIVE_MODEL_[A-Z_]+|ENTRY_CALLBACK_REJECTED)$/.test(receipt.reason??''))return null;
  // Also reject a plan replaced since the actual send.
  if(hash(await readFile(join(local,'entry-plans',plan.tag+'.json')))!==attempt.planSha256)return null;
  return {...receipt,receiptSha256:hash(raw)};
 }catch{return null;}
}
