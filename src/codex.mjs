import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { RESEARCH } from './paths.mjs';
import { writeJson } from './io.mjs';
import { proposalSchema } from './config.mjs';
import { buildAnalystPrompt } from './analyst.mjs';
export const RESEARCH_MODEL='gpt-5.6-sol';
export function modelArgs(){return ['--model',RESEARCH_MODEL];}
export function safeEnv(input=process.env) {
 const allow=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','CODEX_HOME']);
 return Object.fromEntries(Object.entries(input).filter(([k])=>allow.has(k.toUpperCase())));
}
export async function analyze(snapshot,policy,account={trades:[]},{timeoutMs=180000,forceHold=false,signal}={}) {
 const runDir=join(RESEARCH,'runs',randomUUID()); await mkdir(runDir,{recursive:true});
 const schema=join(runDir,'schema.json'), output=join(runDir,'proposal.json');
 await writeJson(schema,z.toJSONSchema(proposalSchema(policy)));
 const {prompt,metadata}=await buildAnalystPrompt({snapshot,policy,account,forceHold});
 metadata.requestedModel=RESEARCH_MODEL;
 await writeJson(join(runDir,'analysis.json'),metadata);
 const executable=process.platform==='win32'?'codex.exe':'codex';
 const args=['exec',...modelArgs(),'--cd',RESEARCH,'--sandbox','read-only','--ignore-user-config','--ephemeral',
  '-c','features.shell_tool=false','-c','features.unified_exec=false',
  '--output-schema',schema,'--output-last-message',output,'-'];
 await new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:RESEARCH,env:safeEnv(),shell:false,windowsHide:true,stdio:['pipe','ignore','pipe']});
  let diagnostic='',timedOut=false;
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-4000);});
  child.on('error',e=>{clearTimeout(timer);reject(new Error('CODEX_START_FAILED: '+e.code));});
  child.on('close',code=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(signal?.aborted) reject(new Error('CODEX_ABORTED: no order submitted'));
   else if(timedOut) reject(new Error('CODEX_TIMEOUT: no order submitted'));
   else if(code!==0) reject(new Error('CODEX_FAILED: exit '+code+'; check native Codex login and availability'));
   else resolve();
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(prompt);
 });
 const proposal=proposalSchema(policy).parse(JSON.parse(await readFile(output,'utf8')));
 if(proposal.snapshotId!==snapshot.id) throw new Error('CODEX_SNAPSHOT_MISMATCH');
 if(forceHold && proposal.action!=='hold') throw new Error('CODEX_SMOKE_NOT_HOLD');
 return {proposal,runDir,metadata};
}
