import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeJson} from '../src/io.mjs';
import {entryPlanDigest,readEntryRejection} from '../src/entry-rejection.mjs';
async function fixture(){
 const local=await mkdtemp(join(tmpdir(),'native-rejection-')),now=Date.parse('2026-09-16T05:31:11.400Z');
 const plan={tag:'codex-'+'a'.repeat(32),snapshotId:crypto.randomUUID(),pair:'XRP/USDT',createdAt:'2026-09-16T05:31:10.700Z',decisionBoundary:1789536660000,nativeEntryGuard:{mode:'demo',version:'kronos-native-entry-v11'}};
 const attempt={mode:'demo',processId:12345,startedAt:now-600,planSha256:entryPlanDigest(plan)};
 const receipt={schemaVersion:1,phase:'callback_before_order',tag:plan.tag,snapshotId:plan.snapshotId,pair:plan.pair,mode:'demo',decisionBoundary:plan.decisionBoundary,
  nativeEntryGuardVersion:plan.nativeEntryGuard.version,planCreatedAt:plan.createdAt,planSha256:attempt.planSha256,reason:'DEMO_NATIVE_MODEL_FLOW_PRICE_NOT_CONTINUED',processId:12345,rejectedAt:new Date(now-50).toISOString()};
 await writeJson(join(local,'entry-plans',plan.tag+'.json'),plan);
 const path=join(local,'entry-rejections',plan.tag+'.json');
 await writeJson(path,receipt);return {local,now,plan,attempt,receipt,path};
}
test('exact current callback receipt is independently bound to plan bytes, process and attempt',async()=>{
 const f=await fixture(),r=await readEntryRejection(f);assert.equal(r.reason,f.receipt.reason);assert.match(r.receiptSha256,/^[a-f0-9]{64}$/);
});
for(const [key,value] of Object.entries({schemaVersion:2,phase:'after_wire',tag:'codex-'+'b'.repeat(32),snapshotId:'wrong',pair:'BTC/USDT',mode:'demo-futures',decisionBoundary:0,nativeEntryGuardVersion:'old',planCreatedAt:'wrong',planSha256:'0'.repeat(64),reason:'HTTP_502',processId:23456,rejectedAt:'2026-09-16T05:31:10.000Z'})){
 test('mismatched callback proof remains unknown: '+key,async()=>{const f=await fixture();await writeJson(f.path,{...f.receipt,[key]:value});assert.equal(await readEntryRejection(f),null);});
}
test('future receipt, missing native PID, changed plan and malformed receipt fail closed',async()=>{
 const f=await fixture();assert.equal(await readEntryRejection({...f,now:f.now-100}),null);
 assert.equal(await readEntryRejection({...f,attempt:{...f.attempt,processId:undefined}}),null);
 await writeJson(join(f.local,'entry-plans',f.plan.tag+'.json'),{...f.plan,pair:'OTHER'});assert.equal(await readEntryRejection(f),null);
 await writeFile(f.path,'{partial');assert.equal(await readEntryRejection(f),null);
});
