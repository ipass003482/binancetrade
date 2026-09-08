import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { modeLocal } from './mode.mjs';
import { makeEngineConfig } from './engine-config.mjs';
import { exists,readJson,writeJson } from './io.mjs';
export async function setupDemo(policy){
 const local=modeLocal('demo'),authFile=join(local,'api-auth.json');
 if(!await exists(authFile))await writeJson(authFile,{username:'demo-bridge',password:randomBytes(32).toString('hex')});
 const auth=await readJson(authFile);
 const file=join(local,'freqtrade/config.json');
 if(!await exists(file)){
  const config=makeEngineConfig(policy,{...auth,jwtSecret:randomBytes(32).toString('hex'),wsToken:randomBytes(32).toString('hex')});
  await writeJson(file,config);
 }
 return {mode:'demo',api:policy.freqtrade.url,credentialsPresent:await exists(join(local,'credentials.dpapi.json')),
  next:'Run powershell.exe -NoProfile -File scripts/configure-demo.ps1 locally. Then engine --mode demo.'};
}
