import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/paths.mjs';
import { loadResearchProfile } from '../src/research-profile.mjs';
import { loadPolicy } from '../src/config.mjs';
let count=0;
async function walk(dir){
 for(const e of await readdir(dir,{withFileTypes:true})){
  const p=join(dir,e.name);
  if(e.isDirectory())await walk(p);
  else if(p.endsWith('.mjs')){execFileSync(process.execPath,['--check',p],{stdio:'pipe'});count++;}
 }
}
for(const d of ['src','scripts','test'])await walk(join(ROOT,d));
await loadPolicy();await loadResearchProfile();
console.log(JSON.stringify({syntaxFiles:count,policy:'valid',mode:'dry-run'}));
