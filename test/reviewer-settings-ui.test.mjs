import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewerSettingsStore} from '../ui/reviewer-store.mjs';
import {mountReviewerSettings} from '../ui/settings.mjs';
const id='61b7669b-fc1b-4c8c-a2ab-81d2f471e589',revision='501d3a24-56f2-4d4e-9050-f9b6131f5e12';
const status=(extra={})=>({provider:'kev',model:'gpt-6-luna',revision:null,changedAt:null,credentialId:null,keyConfigured:false,keyVerified:false,verifiedAt:null,jev:{model:'jev-1.13.0',credentialId:null,verificationStatus:'missing'},csrfToken:'a'.repeat(64),...extra});
const verified=status({keyConfigured:true,keyVerified:true,verifiedAt:'2026-09-29T04:00:00.000Z',jev:{model:'jev-1.13.0',credentialId:id,verificationStatus:'verified'}});
const response=(body,ok=true)=>({ok,json:async()=>body});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Element extends EventTarget{constructor(){super();this.value='';this.textContent='';this.disabled=false;this.type='password';this.dataset={};this.attributes={};}setAttribute(k,v){this.attributes[k]=v;}}
function dom(){const elements=new Map();return {elements,getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);}};}
test('default browser fetch receives globalThis on status and mutation requests',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',function(path,options){
  assert.equal(this,globalThis,'browser Window.fetch must keep the Window receiver');
  calls.push({path,options});return Promise.resolve(response(options.method?verified:status()));
 });
 const store=new ReviewerSettingsStore();
 assert.equal(await store.refresh(),true);assert.equal(store.state.status.provider,'kev');
 assert.equal(await store.saveKey('synthetic-private-key'),true);assert.equal(store.state.status.keyVerified,true);
 assert.deepEqual(calls.map(c=>c.path),['/api/reviewer/status','/api/reviewer/jev-key']);
 assert.equal(calls[1].options.method,'POST');assert.equal(store.state.errorCode,null);
});
test('unknown status never renders a default successful Kev or permits switching',async()=>{
 const store=new ReviewerSettingsStore({fetchImpl:async()=>{throw Error('private upstream text');}}),document=dom();mountReviewerSettings({document,store});await tick();
 assert.equal(document.getElementById('active-provider').textContent,'狀態未知');assert.equal(document.getElementById('switch-jev').disabled,true);assert.equal(document.getElementById('save-key').disabled,true);assert.equal(store.state.status,null);assert.ok(!JSON.stringify(store.state).includes('private'));
});
test('key input clears immediately and save never auto-switches or persists secret in state',async()=>{
 const calls=[];let release;const held=new Promise(resolve=>release=resolve);
 const store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{calls.push([path,opts]);if(opts.method){await held;return response(verified);}return response(status());}}),document=dom();
 mountReviewerSettings({document,store});await tick();const input=document.getElementById('jev-api-key');input.value='unit-private-key';input.type='text';
 document.getElementById('jev-key-form').dispatchEvent(new Event('submit',{cancelable:true}));
 assert.equal(input.value,'');assert.equal(input.type,'password');assert.equal(document.getElementById('save-key').disabled,true);assert.equal(document.getElementById('switch-jev').disabled,true);assert.ok(!JSON.stringify(store.state).includes('unit-private-key'));
 release();await tick();assert.equal(store.state.status.provider,'kev');assert.equal(document.getElementById('switch-jev').disabled,false);assert.equal(document.getElementById('switch-kev').disabled,true);
 assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(calls.at(-1)[0],'/api/reviewer/jev-key');assert.deepEqual(JSON.parse(calls.at(-1)[1].body),{apiKey:'unit-private-key'});assert.equal(calls.at(-1)[1].credentials,'omit');
});
test('switch carries last observed revision; stale tab refreshes without retrying switch',async()=>{
 const calls=[];let reads=0;const store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{calls.push([path,opts]);return opts.method?response({error:'PROVIDER_REVISION_CONFLICT'},false):response({...verified,revision:reads++?revision:null});}});
 await store.refresh();assert.equal(await store.switchProvider('jev'),false);
 assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.deepEqual(JSON.parse(calls.find(c=>c[1].method==='POST')[1].body),{provider:'jev',expectedRevision:null,expectedCredentialId:id});assert.equal(store.state.status.revision,revision);assert.equal(store.state.errorCode,'PROVIDER_REVISION_CONFLICT');
});
test('stale verified-key tab sends the observed key ID and never silently activates replacement key',async()=>{
 const nextId='61b7669b-fc1b-4c8c-a2ab-81d2f471e588',calls=[];let reads=0;
 const store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{calls.push([path,opts]);if(opts.method)return response({error:'PROVIDER_REVISION_CONFLICT'},false);
  return response(reads++?{...verified,jev:{...verified.jev,credentialId:nextId}}:verified);}});
 await store.refresh();await store.switchProvider('jev');
 const posts=calls.filter(c=>c[1].method==='POST');assert.equal(posts.length,1);
 assert.deepEqual(JSON.parse(posts[0][1].body),{provider:'jev',expectedRevision:null,expectedCredentialId:id});
 assert.equal(store.state.status.provider,'kev');assert.equal(store.state.status.revision,null);assert.equal(store.state.status.jev.credentialId,nextId);assert.equal(store.state.errorCode,'PROVIDER_REVISION_CONFLICT');
});
test('returning to Kev sends no Jev credential binding',async()=>{
 const calls=[],store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{calls.push([path,opts]);return response({...verified,provider:'jev',model:'jev-1.13.0',credentialId:id,revision});}});
 await store.refresh();await store.switchProvider('kev');
 assert.deepEqual(JSON.parse(calls.at(-1)[1].body),{provider:'kev',expectedRevision:revision});
});
test('unverified Jev cannot switch, verified key rotation is a separate explicit action',async()=>{
 const calls=[];let current=status();const store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{calls.push([path,opts]);return response(current);}}),document=dom();mountReviewerSettings({document,store});await tick();
 assert.equal(await store.switchProvider('jev'),false);assert.equal(calls.some(c=>c[1].method),false);
 current={...verified,provider:'jev',model:'jev-1.13.0',credentialId:'dd939ce7-b9a0-46b4-a5ba-3c4ea6f8b379'};await store.refresh();
 assert.equal(document.getElementById('switch-jev').disabled,false);assert.equal(document.getElementById('switch-jev').textContent,'套用新的 Jev 金鑰');
 current={...current,credentialId:id};await store.refresh();assert.equal(document.getElementById('switch-jev').disabled,true);
});
test('old GET response cannot overwrite newer refresh and raw errors are never displayed',async()=>{
 let resolve;let n=0;const store=new ReviewerSettingsStore({fetchImpl:async()=>{if(!n++)return new Promise(r=>resolve=r);return response({...verified,revision});}});
 const first=store.refresh();await store.refresh();resolve(response(status()));await first;assert.equal(store.state.status.revision,revision);
 store.fetchImpl=async()=>response({error:'<script>private-key</script>'},false);await store.refresh();assert.equal(store.state.errorCode,'REVIEWER_UNAVAILABLE');assert.equal(store.state.status,null);
});
test('keyboard form controls mask/show key, blank key stays local, timestamps use Taipei',async()=>{
 let posts=0;const store=new ReviewerSettingsStore({fetchImpl:async(path,opts)=>{if(opts.method)posts++;return response(verified);}}),document=dom();mountReviewerSettings({document,store});await tick();
 const button=document.getElementById('toggle-key'),input=document.getElementById('jev-api-key');button.dispatchEvent(new Event('click'));assert.equal(input.type,'text');assert.equal(button.attributes['aria-pressed'],'true');button.dispatchEvent(new Event('click'));assert.equal(input.type,'password');
 document.getElementById('jev-key-form').dispatchEvent(new Event('submit',{cancelable:true}));await tick();assert.equal(posts,0);assert.equal(store.state.errorCode,'JEV_KEY_INVALID');assert.match(document.getElementById('verified-at').textContent,/2026-09-29 12:00:00/);
});
