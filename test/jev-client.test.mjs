import test from 'node:test';
import assert from 'node:assert/strict';
import {callJev,verifyJevApiKey,validateJevKey,JEV_MODEL} from '../src/jev-client.mjs';
const key='test-only-never-a-real-credential';
const request={model:JEV_MODEL,state:{mode:'demo',amount:'0.00001000',nested:{description:'quotes " and \\'}} ,questions:{entry:{type:'choice',criteria:{q0:'buy existing candidate',hold:'no entry'}}}};
const reply=()=>({model:JEV_MODEL,answers:{entry:{type:'choice',choice:'q0',probabilities:{q0:0.7,hold:0.3},confidence:0.6}},usage:{input_tokens:123,output_tokens:0},extra:{opaque:'retained'}});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const code=expected=>error=>error.code===expected&&error.message===expected&&!String(error).includes(key);
test('Jev preserves exact public request, original official response and truthful local provenance',async()=>{
 let calls=0;const original=reply();const result=await callJev({request,key,timeoutMs:500,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer '+key);assert.deepEqual(JSON.parse(options.body),request);return response(original);
 }});
 assert.equal(calls,1);assert.deepEqual(result.upstream,original);assert.equal(result.usage.output_tokens,0);
 assert.equal(result.backend.name,'typesafe-api');assert.equal(result.backend.actual_model,JEV_MODEL);
 assert.equal(result.backend.weights_loaded,false);assert.equal(result.backend.probabilities_calibrated,false);
 assert.equal(result.backend.api_calls,1);assert.equal(result.backend.request_id_source,'host');assert.equal(result.backend.timestamp_source,'host');
 assert.match(result.request_id,/^[a-f0-9-]{36}$/);assert.equal(new Date(result.created_at).toISOString(),result.created_at);
 assert.equal(JSON.stringify(result).includes(key),false);
});
test('authenticated model list verifies actual structured body and accepts documented alias',async()=>{
 for(const name of [JEV_MODEL,'jev-latest']){
  let calls=0;const result=await verifyJevApiKey({key,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.typesafe.ai/v1/models');assert.equal(options.method,'GET');assert.equal(options.body,undefined);return response({models:[{name,description:'model',release_date:'2026-09-24'}]});}});
  assert.equal(result.model,JEV_MODEL);assert.equal(calls,1);
 }
 for(const value of [{models:[]},{ok:true},{models:[{name:JEV_MODEL}]}])await assert.rejects(verifyJevApiKey({key,fetchImpl:async()=>response(value)}),code('JEV_RESPONSE_INVALID'));
 await assert.rejects(verifyJevApiKey({key,fetchImpl:async()=>response({models:[{name:'unrelated',description:'other',release_date:'2026'}]})}),code('JEV_MODEL_UNAVAILABLE'));
});
test('Jev rejects malformed/model/choice/probability/confidence/usage responses',async()=>{
 const edits=[r=>{r.model='jev-latest';},r=>{r.answers.entry.choice='q999';},r=>{r.answers.extra={};},r=>{r.answers.entry.probabilities={q0:.7};},r=>{r.answers.entry.probabilities={q0:.5,hold:.5};},r=>{r.answers.entry.probabilities.q0=.9;},r=>{r.answers.entry.confidence=1.1;},r=>{r.usage.input_tokens=0;},r=>{r.usage.output_tokens=-1;},r=>{r.extra=key;}];
 for(const edit of edits){const value=reply();edit(value);await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>response(value)}),code('JEV_RESPONSE_INVALID'));}
});
test('Jev bounded errors never echo arbitrary body, credential, network exception or retry',async()=>{
 for(const [status,expected] of [[401,'JEV_HTTP_AUTH'],[403,'JEV_HTTP_AUTH'],[429,'JEV_HTTP_RATE_LIMIT'],[529,'JEV_HTTP_RATE_LIMIT'],[500,'JEV_HTTP_ERROR'],[302,'JEV_HTTP_ERROR']]){
  let calls=0;await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>{calls++;return new Response(key,{status});}}),code(expected));assert.equal(calls,1);
 }
 await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>{throw Object.assign(new Error(key),{code:'JEV_HTTP_AUTH'});}}),code('JEV_NETWORK_ERROR'));
 await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>({status:200,redirected:true})}),code('JEV_HTTP_ERROR'));
 const echoed=JSON.stringify({...reply(),extra:key}).replace(key,[...key].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
 await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>new Response(echoed)}),code('JEV_RESPONSE_INVALID'));
 for(const headers of [{},{'content-length':'65537'}])await assert.rejects(callJev({request,key,timeoutMs:500,fetchImpl:async()=>new Response('x'.repeat(65537),{headers})}),code('JEV_RESPONSE_TOO_LARGE'));
});
test('Jev fixed deadline covers response body and caller abort without retry',async()=>{
 let cancelled=false,calls=0;
 await assert.rejects(callJev({request,key,timeoutMs:15,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true;}}));}}),code('JEV_TIMEOUT'));
 assert.equal(calls,1);assert.equal(cancelled,true);
 const controller=new AbortController();controller.abort();let invoked=false;
 await assert.rejects(callJev({request,key,timeoutMs:500,signal:controller.signal,fetchImpl:async()=>{invoked=true;return response(reply());}}),code('JEV_ABORTED'));assert.equal(invoked,false);
 const during=new AbortController();await assert.rejects(callJev({request,key,timeoutMs:500,signal:during.signal,fetchImpl:async()=>{during.abort();return response(reply());}}),code('JEV_ABORTED'));
 let times=[1000,900];await assert.rejects(callJev({request,key,timeoutMs:500,now:()=>times.shift(),fetchImpl:async()=>response(reply())}),code('JEV_CLOCK_INVALID'));
 times=[1000,1500];await assert.rejects(callJev({request,key,timeoutMs:500,now:()=>times.shift(),fetchImpl:async()=>response(reply())}),code('JEV_TIMEOUT'));
});
test('decoded credential echoes are rejected in nested values and property names for quote/backslash keys',async()=>{
 const escapedToken=text=>'"'+[...text].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 for(const privateKey of ['synthetic-"quote-secret','synthetic-\\slash-secret','synthetic-"both\\secret']){
  assert.equal(validateJevKey(privateKey),privateKey);
  for(const location of ['value','name'])for(const unicodeEncoded of [false,true]){
   const embedded='prefix:'+privateKey+':suffix';
   const original={...reply(),extra:{nested:[location==='value'?{debug:embedded}:{[embedded]:'nonsecret'}]}};
   let text=JSON.stringify(original);
   if(unicodeEncoded)text=text.replace(JSON.stringify(embedded),escapedToken(embedded));
   assert.equal(text.includes(privateKey),false,'fixture reproduces the serialized-string blind spot');
   let calls=0;
   await assert.rejects(callJev({request,key:privateKey,timeoutMs:500,fetchImpl:async()=>{calls++;return new Response(text);}}),error=>{
    assert.equal(error.code,'JEV_RESPONSE_INVALID');assert.equal(error.message,'JEV_RESPONSE_INVALID');
    assert.equal(String(error).includes(privateKey),false);return true;
   });
   assert.equal(calls,1);
  }
  // Legitimate unrelated escaped data remains lossless; the scan is read-only.
  const clean={...reply(),extra:{nested:['ordinary "quote" and \\ slash',{label:'safe'}]}};
  const result=await callJev({request,key:privateKey,timeoutMs:500,fetchImpl:async()=>response(clean)});
  assert.deepEqual(result.upstream,clean);
 }
 const models={models:[{name:'jev-latest',description:'normal',release_date:'2026-09-24'}],debug:{['prefix:synthetic-"model\\secret:suffix']:'other'}};
 await assert.rejects(verifyJevApiKey({key:'synthetic-"model\\secret',fetchImpl:async()=>response(models)}),code('JEV_RESPONSE_INVALID'));
});
test('invalid keys and requests never invoke network',async()=>{
 for(const v of ['',null,' test-key-long','test-key\nlong','é'.repeat(20),'x'.repeat(4097)])assert.throws(()=>validateJevKey(v),code('JEV_KEY_INVALID'));
 for(const r of [{...request,model:'gpt-6-luna'},{...request,state:'x'.repeat(32768)},{...request,questions:{entry:{type:'choice',criteria:{hold:'only'}}}}]){
  let called=false;await assert.rejects(callJev({request:r,key,timeoutMs:500,fetchImpl:async()=>{called=true;return response(reply());}}),code('JEV_REQUEST_INVALID'));assert.equal(called,false);
 }
});
