import { join } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, LOCAL, RESEARCH } from './paths.mjs';
import { exists,writeJson,readJson } from './io.mjs';
import { loadPolicy } from './config.mjs';
import { makeEngineConfig } from './engine-config.mjs';
import { installSkills } from '../scripts/install-skills.mjs';
export async function setup() {
 const policy=await loadPolicy();
 for(const path of [LOCAL,join(LOCAL,'runs'),join(LOCAL,'freqtrade'),RESEARCH]) await mkdir(path,{recursive:true});
 const authFile=join(LOCAL,'api-auth.json');
 if(!await exists(authFile)) await writeJson(authFile,{username:'research-bridge',password:randomBytes(32).toString('hex')});
 const auth=await readJson(authFile);
 const configFile=join(LOCAL,'freqtrade/config.json');
 if(!await exists(configFile)) await writeJson(configFile,makeEngineConfig(policy,{
  ...auth,jwtSecret:randomBytes(32).toString('hex'),wsToken:randomBytes(32).toString('hex')}));

 if(!await exists(join(RESEARCH,'AGENTS.md'))) await copyFile(join(ROOT,'templates/research/AGENTS.md'),join(RESEARCH,'AGENTS.md'));
 const skills=await installSkills();
 // Separate git discovery boundary: research runs never inherit the parent trading instructions.
 if(!await exists(join(RESEARCH,'.git'))) execFileSync('git',['init',RESEARCH],{stdio:'pipe'});
 return {status:'ready',mode:'dry-run',skills,api:'http://127.0.0.1:18080',walletUsdt:1000};
}
