import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {createDashboardServer} from '../src/dashboard.mjs';
const keyId='61b7669b-fc1b-4c8c-a2ab-81d2f471e589',revision='501d3a24-56f2-4d4e-9050-f9b6131f5e12';
const status=(changes={})=>({provider:'kev',model:'gpt-6-luna',revision:null,changedAt:null,credentialId:null,keyConfigured:false,keyVerified:false,verifiedAt:null,
 jev:{model:'jev-1.13.0',credentialId:null,verificationStatus:'missing'},...changes});
const saved=status({keyConfigured:true,jev:{model:'jev-1.13.0',credentialId:keyId,verificationStatus:'unverified'}});
const verified={...saved,keyVerified:true,verifiedAt:'2026-09-29T04:00:00.000Z',jev:{...saved.jev,verificationStatus:'verified'}};
async function fixture(t,overrides={}){
 const calls=[],server=createDashboardServer({port:18129,providerRoot:'TEST-ONLY',getProviderStatus:async args=>{calls.push(['status',args]);return status();},
 saveProviderKey:async args=>{calls.push(['save',args]);return saved;},verifyProviderKey:async args=>{calls.push(['verify',args]);return verified;},
 switchProvider:async args=>{calls.push(['switch',args]);return status({provider:args.provider,model:args.provider==='jev'?'jev-1.13.0':'gpt-6-luna',revision,changedAt:'2026-09-29T04:00:00.000Z'});},...overrides});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(path,{method='GET',body,raw,headers={}}={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'127.0.0.1:18129',...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,text,body:json,headers:res.headers});});});req.on('error',reject);req.end(raw??(body===undefined?undefined:JSON.stringify(body)));
 });
 const token=(await call('/api/reviewer/status')).body.csrfToken;
 const post=(path,body,headers={})=>call(path,{method:'POST',body,headers:{Origin:'http://127.0.0.1:18129','Content-Type':'application/json','X-Reviewer-CSRF':token,...headers}});
 return {calls,server,call,post,token};
}
test('reviewer status is uncached, explicit default Kev, secret projection, per-server CSRF',async t=>{
 const f=await fixture(t,{getProviderStatus:async()=>({...status(),apiKey:'PRIVATE-KEY',secret:'PRIVATE-KEY',jev:{...status().jev,apiKey:'PRIVATE-KEY'}})}),g=await fixture(t);
 assert.match(f.token,/^[a-f0-9]{64}$/);assert.notEqual(f.token,g.token);
 const r=await f.call('/api/reviewer/status');assert.equal(r.status,200);assert.equal(r.body.provider,'kev');assert.equal(r.body.revision,null);assert.ok(!r.text.includes('PRIVATE'));
 assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['access-control-allow-origin'],undefined);assert.ok(r.headers['content-security-policy'].includes("script-src 'self'"));
});
test('admin POST requires exact loopback host, Origin and this server CSRF token',async t=>{
 const f=await fixture(t),payload={apiKey:'unit-test-key'};
 for(const headers of [{Origin:''},{Origin:'https://evil.test'},{Host:'localhost:18129'},{'X-Reviewer-CSRF':''},{'X-Reviewer-CSRF':'a'.repeat(63)},{'X-Reviewer-CSRF':'é'.repeat(64)},{'Sec-Fetch-Site':'cross-site'}]){
  const r=await f.post('/api/reviewer/jev-key',payload,headers);assert.equal(r.status,403,JSON.stringify(headers));
 }
 assert.equal(f.calls.filter(c=>c[0]!=='status').length,0);
});
test('only two explicit mutation routes are writable; no query or generic settings route',async t=>{
 const f=await fixture(t);
 for(const path of ['/api/dashboard','/settings','/api/reviewer/status','/api/reviewer/execute'])assert.equal((await f.post(path,{apiKey:'unit-key'})).status,405,path);
 assert.equal((await f.call('/api/reviewer/jev-key')).status,405);
 assert.equal((await f.post('/api/reviewer/jev-key?provider=jev',{apiKey:'unit-key'})).status,400);
 assert.equal((await f.call('/api/reviewer/status?key=x')).status,400);
 assert.equal(f.calls.filter(c=>c[0]!=='status').length,0);
});
test('JSON requests have bounded exact schemas and reject alternate encoding',async t=>{
 const f=await fixture(t);
 const bodies=[{},[],null,{apiKey:''},{apiKey:'has space'},{apiKey:'a\nb'},{apiKey:3},{apiKey:'a',provider:'jev'},{apiKey:'a'.repeat(4097)}];
 for(const body of bodies)assert.equal((await f.post('/api/reviewer/jev-key',body)).status,400);
 for(const body of [{provider:'jev'},{provider:'jev',expectedRevision:null},{provider:'jev',expectedRevision:null,expectedCredentialId:null},{provider:'jev',expectedRevision:'old',expectedCredentialId:keyId},{provider:'other',expectedRevision:null},{provider:'kev',expectedRevision:null,expectedCredentialId:keyId},{provider:'kev',expectedRevision:null,command:'x'}])assert.equal((await f.post('/api/reviewer/switch',body)).status,400);
 assert.equal((await f.post('/api/reviewer/jev-key',{apiKey:'a'},{'Content-Type':'text/plain'})).status,415);
 assert.equal((await f.post('/api/reviewer/jev-key',{apiKey:'a'},{'Content-Encoding':'gzip'})).status,415);
 assert.equal((await f.post('/api/reviewer/jev-key',{apiKey:'a'.repeat(9000)})).status,413);
 assert.equal((await f.call('/api/reviewer/jev-key',{method:'POST',raw:'{',headers:{Origin:'http://127.0.0.1:18129','Content-Type':'application/json','X-Reviewer-CSRF':f.token}})).status,400);
 assert.equal(f.calls.filter(c=>c[0]!=='status').length,0);
});
test('save verifies the exact saved key, returns no key, and never switches',async t=>{
 const f=await fixture(t),r=await f.post('/api/reviewer/jev-key',{apiKey:'unit-private-value'});
 assert.equal(r.status,200);assert.equal(r.body.provider,'kev');assert.equal(r.body.keyVerified,true);assert.ok(!r.text.includes('unit-private-value'));
 assert.deepEqual(f.calls.filter(c=>c[0]!=='status'),[['save',{root:'TEST-ONLY',apiKey:'unit-private-value'}],['verify',{root:'TEST-ONLY',credentialId:keyId}]]);
});
test('verification failure stays explicit and never switches or echoes provider error details',async t=>{
 const f=await fixture(t,{verifyProviderKey:async()=>{throw Object.assign(Error('secret credential upstream text'),{code:'JEV_HTTP_AUTH',response:'secret'});}});
 const r=await f.post('/api/reviewer/jev-key',{apiKey:'unit-private-value'});assert.equal(r.status,502);assert.deepEqual(r.body,{error:'JEV_HTTP_AUTH'});assert.equal(f.calls.some(c=>c[0]==='switch'),false);
});
test('concurrent key rotation between save and verify cannot report wrong latest key as verified',async t=>{
 const differentId='61b7669b-fc1b-4c8c-a2ab-81d2f471e588';
 const f=await fixture(t,{verifyProviderKey:async({credentialId})=>{assert.equal(credentialId,keyId);return {...verified,jev:{...verified.jev,credentialId:differentId}};}});
 const r=await f.post('/api/reviewer/jev-key',{apiKey:'unit-private-value'});assert.equal(r.status,409);assert.deepEqual(r.body,{error:'PROVIDER_REVISION_CONFLICT'});
});
test('inconsistent latest-key verification state never enables Jev through status response',async t=>{
 const f=await fixture(t,{getProviderStatus:async()=>status({keyVerified:true})});
 assert.deepEqual((await f.call('/api/reviewer/status')).body,{error:'PROVIDER_STATE_INVALID'});
});
test('unexpected failures and corrupted status never expose keys through model/time fields',async t=>{
 const f=await fixture(t,{getProviderStatus:async()=>status({model:'unit-private-value'})});
 assert.deepEqual((await f.call('/api/reviewer/status')).body,{error:'PROVIDER_STATE_INVALID'});
 const g=await fixture(t,{saveProviderKey:async()=>{throw Object.assign(Error('PRIVATE-KEY'),{code:'PRIVATE_KEY'});}});
 const r=await g.post('/api/reviewer/jev-key',{apiKey:'unit-private-value'});assert.equal(r.status,503);assert.deepEqual(r.body,{error:'PROVIDER_IO_ERROR'});
});
test('switch passes observed revision exactly; conflicts do not retry',async t=>{
 const calls=[],f=await fixture(t,{switchProvider:async args=>{calls.push(args);throw Object.assign(Error('x'),{code:'PROVIDER_REVISION_CONFLICT'});}});
 assert.equal((await f.post('/api/reviewer/switch',{provider:'jev',expectedRevision:null,expectedCredentialId:keyId})).status,409);
 assert.equal((await f.post('/api/reviewer/switch',{provider:'kev',expectedRevision:revision})).status,409);
 assert.deepEqual(calls,[{root:'TEST-ONLY',provider:'jev',expectedRevision:null,expectedCredentialId:keyId},{root:'TEST-ONLY',provider:'kev',expectedRevision:revision}]);
});
test('simultaneous mutation is rejected and failures release only this server mutation lock',async t=>{
 let finish,start;const started=new Promise(resolve=>start=resolve),held=new Promise(resolve=>finish=resolve);
 const f=await fixture(t,{verifyProviderKey:async()=>{start();await held;throw Object.assign(Error('x'),{code:'JEV_TIMEOUT'});}});
 const first=f.post('/api/reviewer/jev-key',{apiKey:'unit-key'});await started;
 assert.equal((await f.post('/api/reviewer/switch',{provider:'kev',expectedRevision:null})).status,409);
 assert.equal((await f.call('/api/reviewer/status')).status,200);
 finish();assert.equal((await first).status,504);
 assert.equal((await f.post('/api/reviewer/switch',{provider:'kev',expectedRevision:null})).status,200);
});
test('settings page and modules are allowlisted under CSP without inline handlers or storage',async t=>{
 const f=await fixture(t);
 const html=await f.call('/settings');assert.equal(html.status,200);assert.match(html.text,/lang="zh-Hant"/);assert.match(html.text,/type="password"/);assert.match(html.text,/src="\/settings.mjs"/);assert.doesNotMatch(html.text,/\son(?:click|submit|load)=|<script(?![^>]*src=)/);
 for(const path of ['/settings.css','/settings.mjs','/reviewer-store.mjs']){const r=await f.call(path);assert.equal(r.status,200);assert.doesNotMatch(r.text,/localStorage|sessionStorage/);}
 assert.match((await f.call('/')).text,/href="\/settings"/);
 assert.equal((await f.call('/decision-provider.mjs')).status,404);
});
