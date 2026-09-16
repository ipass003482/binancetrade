import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { safeEnv } from './codex.mjs';
export async function readAccountFacts(mode,kind,{run=promisify(execFile),now=Date.now()}={}){
 if(!['demo','demo-futures'].includes(mode)||!['costs','equity'].includes(kind))throw Error('FACTS_MODE_REJECTED');
 const {stdout}=await run(join(ROOT,'.venv/Scripts/python.exe'),[join(ROOT,'scripts/demo-account-facts.py'),mode,kind],
  {cwd:ROOT,env:safeEnv(),windowsHide:true,timeout:60000,maxBuffer:1024*1024});
 const value=JSON.parse(stdout),source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 if(value.schemaVersion!==1||value.mode!==mode||value.kind!==kind||value.source!==source||value.readOnly!==true
   ||!Number.isFinite(Date.parse(value.observedAt))||Date.parse(value.observedAt)<now-60000||Date.parse(value.observedAt)>Date.now()+1000)throw Error('FACTS_IDENTITY_REJECTED');
 return value;
}
