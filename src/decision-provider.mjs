import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ROOT} from './paths.mjs';
import {JEV_MODEL,jevError,isJevError,validateJevKey,verifyJevApiKey} from './jev-client.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,expected)=>object(v)&&Object.keys(v).sort().join('\0')===[...expected].sort().join('\0');
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const id=v=>typeof v==='string'&&UUID.test(v);
const pathFor=(root,name)=>join(root,'local','decision-provider',name);
const credentialPath=(root,credentialId)=>pathFor(root,join('credentials',credentialId+'.json'));
const stateError=()=>jevError('PROVIDER_STATE_INVALID');
const time=now=>{const v=now();if(!Number.isFinite(v))throw jevError('JEV_CLOCK_INVALID');return new Date(v).toISOString();};
function safeError(error){return isJevError(error)?jevError(error.code):jevError('PROVIDER_IO_ERROR');}

async function readBounded(path,{optional=false}={}){
 let handle;
 try{
  handle=await open(path,'r');const info=await handle.stat();
  if(!info.isFile()||info.size>65536)throw stateError();
  const bytes=await handle.readFile();if(bytes.length>65536)throw stateError();
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw stateError();}
 }catch(error){if(optional&&error.code==='ENOENT')return undefined;throw safeError(error);}
 finally{try{await handle?.close();}catch{throw jevError('PROVIDER_IO_ERROR');}}
}
async function atomicJson(path,value){
 await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';let handle;
 try{handle=await open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();await handle.close();handle=null;await rename(temp,path);}
 finally{await handle?.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function mutation(root,fn){
 const path=pathFor(root,'mutation.lock');let handle;
 try{await mkdir(dirname(path),{recursive:true});}catch{throw jevError('PROVIDER_IO_ERROR');}
 try{handle=await open(path,'wx',0o600);}catch(error){throw jevError(error.code==='EEXIST'?'PROVIDER_BUSY':'PROVIDER_IO_ERROR');}
 try{await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await handle.sync();return await fn();}
 catch(error){throw safeError(error);}
 finally{try{await handle.close();await unlink(path);}catch{throw jevError('PROVIDER_IO_ERROR');}}
}
function checkSelection(v){
 if(!object(v)||v.version!==1||!['kev','jev'].includes(v.provider)||!id(v.revision)||!iso(v.changedAt)||
  !keys(v,['version','provider','revision','changedAt',...(v.provider==='jev'?['credentialId']:[])])||
  (v.provider==='jev'&&!id(v.credentialId)))throw stateError();
 const {version,...selection}=v;return selection;
}
export async function readProviderSelection({root=ROOT}={}){
 const value=await readBounded(pathFor(root,'selection.json'),{optional:true});
 return value===undefined?null:checkSelection(value);
}
async function readCredential(root,credentialId){
 if(!id(credentialId))throw jevError('JEV_KEY_INVALID');
 const value=await readBounded(credentialPath(root,credentialId),{optional:true});
 if(value===undefined)throw jevError('JEV_KEY_MISSING');
 if(!keys(value,['version','credentialId','createdAt','ciphertext','verifiedAt','verificationMethod'])||value.version!==1||value.credentialId!==credentialId||!iso(value.createdAt)||
  typeof value.ciphertext!=='string'||value.ciphertext.length<20||value.ciphertext.length>20000||!(/^[A-Za-z0-9+/]+={0,2}$/).test(value.ciphertext)||
  !((value.verifiedAt===null&&value.verificationMethod===null)||(iso(value.verifiedAt)&&value.verificationMethod==='authenticated-model-list')))throw stateError();
 return value;
}
async function readLatest(root){
 const latest=await readBounded(pathFor(root,'latest.json'),{optional:true});
 if(latest===undefined)return null;
 if(!keys(latest,['version','credentialId'])||latest.version!==1||!id(latest.credentialId))throw stateError();
 return readCredential(root,latest.credentialId);
}
export async function getDecisionProviderStatus({root=ROOT}={}){
 const selection=await readProviderSelection({root}),latest=await readLatest(root);
 if(selection?.provider==='jev'){
  const selected=await readCredential(root,selection.credentialId);
  if(!selected.verifiedAt)throw jevError('JEV_KEY_NOT_VERIFIED');
 }
 return {provider:selection?.provider??'kev',model:selection?.provider==='jev'?JEV_MODEL:'gpt-6-luna',
  revision:selection?.revision??null,changedAt:selection?.changedAt??null,credentialId:selection?.credentialId??null,
  keyConfigured:latest!==null,keyVerified:!!latest?.verifiedAt,verifiedAt:latest?.verifiedAt??null,
  jev:{model:JEV_MODEL,credentialId:latest?.credentialId??null,verificationStatus:!latest?'missing':latest.verifiedAt?'verified':'unverified'}};
}

// Keys travel over stdin/stdout pipes only. The helper never accepts secrets in
// process arguments or writes plaintext to disk. DPAPI binds the current user.
export async function jevSecret(request){
 if(process.platform!=='win32')throw jevError('JEV_SECRET_FAILED');
 const helper=fileURLToPath(new URL('../scripts/jev-secret.ps1',import.meta.url));
 return new Promise((resolve,reject)=>{
  let settled=false,size=0;const chunks=[];
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(jevError('JEV_SECRET_FAILED'));}else resolve(value);};
  const timer=setTimeout(()=>finish(true),10000);
  child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
  child.stderr.resume();child.stdout.on('data',chunk=>{size+=chunk.length;if(size>24000)finish(true);else chunks.push(chunk);});
  child.on('close',code=>{if(code!==0)return finish(true);try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(true);}});
  child.stdin.end(JSON.stringify(request));
 });
}
async function secretCall(secretImpl,request){
 try{return await secretImpl(request);}catch{throw jevError('JEV_SECRET_FAILED');}
}
export async function loadJevCredential({root=ROOT,credentialId,secretImpl=jevSecret}){
 const credential=await readCredential(root,credentialId);
 if(!credential.verifiedAt)throw jevError('JEV_KEY_NOT_VERIFIED');
 return decrypt(credential,secretImpl);
}
async function decrypt(credential,secretImpl){
 const result=await secretCall(secretImpl,{operation:'unprotect',credentialId:credential.credentialId,ciphertext:credential.ciphertext});
 if(!keys(result,['apiKey']))throw jevError('JEV_SECRET_FAILED');
 try{return validateJevKey(result.apiKey);}catch{throw jevError('JEV_SECRET_FAILED');}
}
export async function saveJevKey({root=ROOT,apiKey,secretImpl=jevSecret,now=Date.now}){
 validateJevKey(apiKey);
 return mutation(root,async()=>{
  await readProviderSelection({root});await readLatest(root);
  const credentialId=randomUUID(),createdAt=time(now);
  const protectedKey=await secretCall(secretImpl,{operation:'protect',credentialId,apiKey});
  if(!keys(protectedKey,['ciphertext'])||typeof protectedKey.ciphertext!=='string'||protectedKey.ciphertext.length<20||protectedKey.ciphertext.length>20000||!(/^[A-Za-z0-9+/]+={0,2}$/).test(protectedKey.ciphertext))throw jevError('JEV_SECRET_FAILED');
  await atomicJson(credentialPath(root,credentialId),{version:1,credentialId,createdAt,ciphertext:protectedKey.ciphertext,verifiedAt:null,verificationMethod:null});
  await atomicJson(pathFor(root,'latest.json'),{version:1,credentialId});
  return getDecisionProviderStatus({root});
 });
}
export async function verifyJevKey({root=ROOT,credentialId,secretImpl=jevSecret,fetchImpl=fetch,timeoutMs=10000,signal,now=Date.now}){
 return mutation(root,async()=>{
  await readProviderSelection({root});const credential=credentialId===undefined?await readLatest(root):await readCredential(root,credentialId);
  if(!credential)throw jevError('JEV_KEY_MISSING');
  const apiKey=await decrypt(credential,secretImpl);
  const verified=await verifyJevApiKey({key:apiKey,timeoutMs,signal,fetchImpl,now});
  await atomicJson(credentialPath(root,credential.credentialId),{...credential,verifiedAt:verified.verifiedAt,verificationMethod:verified.verificationMethod});
  return getDecisionProviderStatus({root});
 });
}
export async function switchDecisionProvider({root=ROOT,provider,expectedRevision,expectedCredentialId,secretImpl=jevSecret,now=Date.now}){
 if(!['kev','jev'].includes(provider))throw jevError('PROVIDER_INVALID');
 if(expectedRevision!==null&&!id(expectedRevision))throw jevError('PROVIDER_REVISION_CONFLICT');
 if(provider==='jev'&&!id(expectedCredentialId))throw jevError('PROVIDER_REVISION_CONFLICT');
 return mutation(root,async()=>{
  const existing=await readProviderSelection({root});
  if((existing?.revision??null)!==expectedRevision)throw jevError('PROVIDER_REVISION_CONFLICT');
  let credentialId;
  if(provider==='jev'){
   const credential=await readLatest(root);if(!credential)throw jevError('JEV_KEY_MISSING');
   if(credential.credentialId!==expectedCredentialId)throw jevError('PROVIDER_REVISION_CONFLICT');
   if(!credential.verifiedAt)throw jevError('JEV_KEY_NOT_VERIFIED');
   await decrypt(credential,secretImpl);credentialId=credential.credentialId;
  }
  const selection={version:1,provider,revision:randomUUID(),changedAt:time(now),...(credentialId?{credentialId}:{})};
  await atomicJson(pathFor(root,'selection.json'),selection);return getDecisionProviderStatus({root});
 });
}
