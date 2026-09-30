import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readProviderSelection,getDecisionProviderStatus,saveJevKey,verifyJevKey,switchDecisionProvider,loadJevCredential,jevSecret} from '../src/decision-provider.mjs';
const fakeKey='offline-only-synthetic-key';
const code=expected=>error=>error.code===expected&&error.message===expected&&!String(error).includes(fakeKey);
async function setup(t){const root=await mkdtemp(join(tmpdir(),'jev-provider-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function secret(){const store=new Map();return async request=>{
 if(request.operation==='protect'){const ciphertext=Buffer.from(randomUUID()+randomUUID()).toString('base64');store.set(ciphertext,{id:request.credentialId,key:request.apiKey});return {ciphertext};}
 const value=store.get(request.ciphertext);if(value?.id!==request.credentialId)throw new Error('opaque decrypt failure');return {apiKey:value.key};
};}
const fetchImpl=async()=>new Response(JSON.stringify({models:[{name:'jev-latest',description:'Jev',release_date:'2026-09-24'}]}));
test('missing defaults Kev, strict malformed state never falls back',async t=>{
 const root=await setup(t);assert.equal(await readProviderSelection({root}),null);
 const initial=await getDecisionProviderStatus({root});assert.equal(initial.provider,'kev');assert.equal(initial.model,'gpt-6-luna');assert.equal(initial.keyConfigured,false);assert.equal(initial.revision,null);
 const dir=join(root,'local','decision-provider');await mkdir(dir,{recursive:true});
 for(const invalid of ['null','{}','{',JSON.stringify({version:1,provider:'unknown'}),'x'.repeat(65537)]){
  await writeFile(join(dir,'selection.json'),invalid);await assert.rejects(readProviderSelection({root}),code('PROVIDER_STATE_INVALID'));
 }
});
test('save and verify preserve Kev; switch atomically pins exact verified credential and revision',async t=>{
 const root=await setup(t),secretImpl=secret();
 const saved=await saveJevKey({root,apiKey:fakeKey,secretImpl});assert.equal(saved.provider,'kev');assert.equal(saved.keyConfigured,true);assert.equal(saved.keyVerified,false);assert.equal(saved.credentialId,null);
 assert.equal(await readProviderSelection({root}),null);
 await assert.rejects(switchDecisionProvider({root,provider:'jev',expectedRevision:null,expectedCredentialId:saved.jev.credentialId,secretImpl}),code('JEV_KEY_NOT_VERIFIED'));
 const checked=await verifyJevKey({root,credentialId:saved.jev.credentialId,secretImpl,fetchImpl});assert.equal(checked.keyVerified,true);assert.equal(checked.provider,'kev');
 const selected=await switchDecisionProvider({root,provider:'jev',expectedRevision:null,expectedCredentialId:saved.jev.credentialId,secretImpl});assert.equal(selected.provider,'jev');assert.equal(selected.credentialId,saved.jev.credentialId);
 assert.equal(await loadJevCredential({root,credentialId:selected.credentialId,secretImpl}),fakeKey);
 await assert.rejects(switchDecisionProvider({root,provider:'kev',expectedRevision:null,secretImpl}),code('PROVIDER_REVISION_CONFLICT'));
 const reverted=await switchDecisionProvider({root,provider:'kev',expectedRevision:selected.revision,secretImpl});assert.equal(reverted.provider,'kev');assert.equal(reverted.credentialId,null);assert.notEqual(reverted.revision,selected.revision);
 const dir=join(root,'local','decision-provider');const files=[join(dir,'selection.json'),join(dir,'latest.json'),...((await readdir(join(dir,'credentials'))).map(p=>join(dir,'credentials',p)))];
 for(const file of files)assert.equal((await readFile(file,'utf8')).includes(fakeKey),false);
 assert.equal(JSON.stringify(selected).includes('ciphertext'),false);assert.equal(JSON.stringify(selected).includes(fakeKey),false);
});
test('new saved key cannot mutate active credential and old verification cannot verify latest by accident',async t=>{
 const root=await setup(t),secretImpl=secret();const a=await saveJevKey({root,apiKey:fakeKey,secretImpl});
 await verifyJevKey({root,credentialId:a.jev.credentialId,secretImpl,fetchImpl});const active=await switchDecisionProvider({root,provider:'jev',expectedRevision:null,expectedCredentialId:a.jev.credentialId,secretImpl});
 const b=await saveJevKey({root,apiKey:fakeKey+'-second',secretImpl});assert.equal(b.revision,active.revision);assert.equal(b.credentialId,a.jev.credentialId);assert.notEqual(b.jev.credentialId,a.jev.credentialId);assert.equal(b.keyVerified,false);
 const rechecked=await verifyJevKey({root,credentialId:a.jev.credentialId,secretImpl,fetchImpl});assert.equal(rechecked.keyVerified,false);
 assert.equal(await loadJevCredential({root,credentialId:a.jev.credentialId,secretImpl}),fakeKey);
 await assert.rejects(loadJevCredential({root,credentialId:b.jev.credentialId,secretImpl}),code('JEV_KEY_NOT_VERIFIED'));
 await assert.rejects(loadJevCredential({root,credentialId:randomUUID(),secretImpl}),code('JEV_KEY_MISSING'));
 await assert.rejects(switchDecisionProvider({root,provider:'jev',expectedRevision:active.revision,expectedCredentialId:b.jev.credentialId,secretImpl}),code('JEV_KEY_NOT_VERIFIED'));
 await verifyJevKey({root,credentialId:b.jev.credentialId,secretImpl,fetchImpl});const next=await switchDecisionProvider({root,provider:'jev',expectedRevision:active.revision,expectedCredentialId:b.jev.credentialId,secretImpl});
 assert.equal(next.credentialId,b.jev.credentialId);assert.equal(await loadJevCredential({root,credentialId:next.credentialId,secretImpl}),fakeKey+'-second');
});
test('shared lock blocks concurrent save/switch, releases on exception, and errors are sanitized',async t=>{
 const root=await setup(t);let release,entered;const ready=new Promise(r=>{entered=r;});const wait=new Promise(r=>{release=r;});const base=secret();
 const secretImpl=async request=>{entered();await wait;return base(request);};
 const first=saveJevKey({root,apiKey:fakeKey,secretImpl});await ready;
 await assert.rejects(saveJevKey({root,apiKey:fakeKey+'2',secretImpl}),code('PROVIDER_BUSY'));
 await assert.rejects(switchDecisionProvider({root,provider:'kev',expectedRevision:null}),code('PROVIDER_BUSY'));release();await first;
 await assert.rejects(saveJevKey({root,apiKey:fakeKey,secretImpl:async()=>{throw new Error(fakeKey);}}),code('JEV_SECRET_FAILED'));
 assert.equal((await switchDecisionProvider({root,provider:'kev',expectedRevision:null})).provider,'kev');
 await assert.rejects(switchDecisionProvider({root,provider:'jev'}),code('PROVIDER_REVISION_CONFLICT'));
});
test('failed authentication, invalid metadata and failed decrypt cannot change selected provider',async t=>{
 const root=await setup(t),secretImpl=secret();const saved=await saveJevKey({root,apiKey:fakeKey,secretImpl});
 await assert.rejects(verifyJevKey({root,credentialId:saved.jev.credentialId,secretImpl,fetchImpl:async()=>new Response(fakeKey,{status:401})}),code('JEV_HTTP_AUTH'));
 assert.equal((await getDecisionProviderStatus({root})).keyVerified,false);assert.equal(await readProviderSelection({root}),null);
 await verifyJevKey({root,credentialId:saved.jev.credentialId,secretImpl,fetchImpl});
 await assert.rejects(switchDecisionProvider({root,provider:'jev',expectedRevision:null,expectedCredentialId:saved.jev.credentialId,secretImpl:async()=>{throw new Error(fakeKey);}}),code('JEV_SECRET_FAILED'));assert.equal(await readProviderSelection({root}),null);
 const file=join(root,'local','decision-provider','credentials',saved.jev.credentialId+'.json');const value=JSON.parse(await readFile(file,'utf8'));value.credentialId=randomUUID();await writeFile(file,JSON.stringify(value));
 await assert.rejects(getDecisionProviderStatus({root}),code('PROVIDER_STATE_INVALID'));
});
test('DPAPI helper binds current user and exact credential identity with synthetic key only',{skip:process.platform!=='win32'},async t=>{
 const root=await setup(t),credentialId=randomUUID();const encrypted=await jevSecret({operation:'protect',credentialId,apiKey:fakeKey});
 assert.equal(JSON.stringify(encrypted).includes(fakeKey),false);assert.deepEqual(await jevSecret({operation:'unprotect',credentialId,ciphertext:encrypted.ciphertext}),{apiKey:fakeKey});
 await assert.rejects(jevSecret({operation:'unprotect',credentialId:randomUUID(),ciphertext:encrypted.ciphertext}),code('JEV_SECRET_FAILED'));
 const saved=await saveJevKey({root,apiKey:fakeKey});await verifyJevKey({root,credentialId:saved.jev.credentialId,fetchImpl});
 const selected=await switchDecisionProvider({root,provider:'jev',expectedRevision:null,expectedCredentialId:saved.jev.credentialId});assert.equal(await loadJevCredential({root,credentialId:selected.credentialId}),fakeKey);
});
test('stale tab cannot activate a replacement key even when provider selection revision is unchanged',async t=>{
 const root=await setup(t),secretImpl=secret();
 const savedA=await saveJevKey({root,apiKey:fakeKey,secretImpl});const tabA=await verifyJevKey({root,credentialId:savedA.jev.credentialId,secretImpl,fetchImpl});
 const savedB=await saveJevKey({root,apiKey:fakeKey+'-replacement',secretImpl});const tabB=await verifyJevKey({root,credentialId:savedB.jev.credentialId,secretImpl,fetchImpl});
 assert.equal(tabA.revision,tabB.revision);assert.notEqual(tabA.jev.credentialId,tabB.jev.credentialId);
 let decryptAttempted=false;
 const unexpectedSecret=async()=>{decryptAttempted=true;throw new Error('must reject before decrypt');};
 await assert.rejects(switchDecisionProvider({root,provider:'jev',expectedRevision:tabA.revision,expectedCredentialId:tabA.jev.credentialId,secretImpl:unexpectedSecret}),code('PROVIDER_REVISION_CONFLICT'));
 await assert.rejects(switchDecisionProvider({root,provider:'jev',expectedRevision:tabB.revision,secretImpl:unexpectedSecret}),code('PROVIDER_REVISION_CONFLICT'));
 assert.equal(decryptAttempted,false);assert.equal(await readProviderSelection({root}),null);
 const current=await switchDecisionProvider({root,provider:'jev',expectedRevision:tabB.revision,expectedCredentialId:tabB.jev.credentialId,secretImpl});
 assert.equal(current.credentialId,tabB.jev.credentialId);assert.equal(await loadJevCredential({root,credentialId:current.credentialId,secretImpl}),fakeKey+'-replacement');
});
