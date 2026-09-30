import {randomUUID} from 'node:crypto';

export const JEV_MODEL='jev-1.13.0';
export const JEV_ORIGIN='https://api.typesafe.ai';
class JevError extends Error {constructor(code){super(code);this.code=code;}}
export function jevError(code){return new JevError(code);}
export const isJevError=error=>error instanceof JevError;
export function validateJevKey(key){
 if(typeof key!=='string'||key.length<10||key.length>4096||!(/^[\x21-\x7e]+$/).test(key))throw jevError('JEV_KEY_INVALID');
 return key;
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameKeys=(value,keys)=>object(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
function containsCredential(value,key){
 // Inspect decoded strings, including property names. Re-serializing would
 // escape quotes/backslashes in permitted keys and miss those exact secrets.
 // Iteration also avoids stack overflow on deeply nested, byte-bounded JSON.
 const pending=[value];
 while(pending.length){
  const item=pending.pop();
  if(typeof item==='string'){if(item.includes(key))return true;}
  else if(item!==null&&typeof item==='object'){
   for(const [name,child] of Object.entries(item)){if(name.includes(key))return true;pending.push(child);}
  }
 }
 return false;
}

async function boundedJson(response,key,signal){
 if(!response||response.redirected||response.status<200||response.status>=300){
  response?.body?.cancel?.().catch(()=>{});
  throw jevError([401,403].includes(response?.status)?'JEV_HTTP_AUTH':[429,529].includes(response?.status)?'JEV_HTTP_RATE_LIMIT':'JEV_HTTP_ERROR');
 }
 const length=response.headers?.get('content-length');
 if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>65536)){
  response.body?.cancel?.().catch(()=>{});throw jevError('JEV_RESPONSE_TOO_LARGE');
 }
 if(!response.body?.getReader)throw jevError('JEV_RESPONSE_INVALID');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 const abortRead=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abortRead,{once:true});
 try{
  while(true){
   if(signal.aborted)throw jevError('JEV_TIMEOUT');
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.byteLength;if(bytes>65536)throw jevError('JEV_RESPONSE_TOO_LARGE');chunks.push(value);
  }
 }catch(error){reader.cancel().catch(()=>{});throw error;}finally{signal.removeEventListener('abort',abortRead);reader.releaseLock();}
 const text=Buffer.concat(chunks).toString('utf8');
 if(text.includes(key))throw jevError('JEV_RESPONSE_INVALID');
 try{const parsed=JSON.parse(text);if(containsCredential(parsed,key))throw jevError('JEV_RESPONSE_INVALID');return parsed;}
 catch{throw jevError('JEV_RESPONSE_INVALID');}
}

async function requestJson({path,method,key,request,timeoutMs,signal,fetchImpl=fetch,now=Date.now}){
 validateJevKey(key);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw jevError('JEV_TIMEOUT_INVALID');
 if(signal?.aborted)throw jevError('JEV_ABORTED');
 const started=now();if(!Number.isFinite(started))throw jevError('JEV_CLOCK_INVALID');
 const controller=new AbortController();let timer,onAbort;
 const interrupted=new Promise((_,reject)=>{
  onAbort=()=>{controller.abort();reject(jevError('JEV_ABORTED'));};signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{controller.abort();reject(jevError('JEV_TIMEOUT'));},timeoutMs);
 });
 try{
  const result=await Promise.race([interrupted,(async()=>{
   const response=await fetchImpl(JEV_ORIGIN+path,{method,redirect:'error',signal:controller.signal,
    headers:{Authorization:'Bearer '+key,...(request?{'Content-Type':'application/json'}:{})},
    ...(request?{body:JSON.stringify(request)}:{})});
   return boundedJson(response,key,controller.signal);
  })()]);
  const completed=now();if(signal?.aborted)throw jevError('JEV_ABORTED');
  if(!Number.isFinite(completed)||completed<started)throw jevError('JEV_CLOCK_INVALID');
  if(completed-started>=timeoutMs)throw jevError('JEV_TIMEOUT');
  return {result,completed};
 }catch(error){
  if(isJevError(error))throw jevError(error.code);
  throw jevError(signal?.aborted?'JEV_ABORTED':controller.signal.aborted?'JEV_TIMEOUT':'JEV_NETWORK_ERROR');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}

export async function verifyJevApiKey({key,timeoutMs=10000,signal,fetchImpl=fetch,now=Date.now}){
 const {result,completed}=await requestJson({path:'/v1/models',method:'GET',key,timeoutMs,signal,fetchImpl,now});
 if(!object(result)||!Array.isArray(result.models)||result.models.length<1||result.models.length>256||
  result.models.some(m=>!object(m)||typeof m.name!=='string'||!m.name||typeof m.description!=='string'||typeof m.release_date!=='string'||!m.release_date))
  throw jevError('JEV_RESPONSE_INVALID');
 // Official model listing currently lists aliases; pinned version IDs remain
 // accepted even if absent. This verifies credentials, not inference quota.
 if(!result.models.some(m=>[JEV_MODEL,'jev-latest'].includes(m.name)))throw jevError('JEV_MODEL_UNAVAILABLE');
 return {model:JEV_MODEL,verifiedAt:new Date(completed).toISOString(),verificationMethod:'authenticated-model-list'};
}

export async function callJev({request,timeoutMs,signal,fetchImpl=fetch,key,now=Date.now}){
 let payload;
 try{payload=JSON.stringify(request);}catch{throw jevError('JEV_REQUEST_INVALID');}
 if(!object(request)||request.model!==JEV_MODEL||!sameKeys(request.questions,['entry'])||request.questions.entry?.type!=='choice'||
  !object(request.questions.entry.criteria)||Buffer.byteLength(payload)>32768)throw jevError('JEV_REQUEST_INVALID');
 const choices=Object.keys(request.questions.entry.criteria);
 if(choices.length<2||choices.length>33||!choices.includes('hold')||choices.some(k=>k!=='hold'&&!/^q\d+$/.test(k)))throw jevError('JEV_REQUEST_INVALID');
 const {result:upstream,completed}=await requestJson({path:'/v1/systemone',method:'POST',request,key,timeoutMs,signal,fetchImpl,now});
 const answer=upstream?.answers?.entry,p=answer?.probabilities;
 if(!object(upstream)||upstream.model!==JEV_MODEL||!sameKeys(upstream.answers,['entry'])||answer?.type!=='choice'||
  !choices.includes(answer.choice)||!sameKeys(p,choices)||choices.some(c=>typeof p[c]!=='number'||!Number.isFinite(p[c])||p[c]<0||p[c]>1)||
  Math.abs(choices.reduce((sum,c)=>sum+p[c],0)-1)>0.011||choices.some(c=>c!==answer.choice&&p[answer.choice]<=p[c])||
  typeof answer.confidence!=='number'||!Number.isFinite(answer.confidence)||answer.confidence<0||answer.confidence>1||
  !Number.isSafeInteger(upstream.usage?.input_tokens)||upstream.usage.input_tokens<1||
  !Number.isSafeInteger(upstream.usage?.output_tokens)||upstream.usage.output_tokens<0)throw jevError('JEV_RESPONSE_INVALID');
 return {model:JEV_MODEL,answers:upstream.answers,usage:upstream.usage,upstream,
  request_id:randomUUID(),created_at:new Date(completed).toISOString(),
  backend:{name:'typesafe-api',actual_model:JEV_MODEL,weights_loaded:false,probabilities_calibrated:false,
   api_calls:1,request_id_source:'host',timestamp_source:'host'}};
}
