import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT, RESEARCH } from '../src/paths.mjs';
import { exists, writeJson } from '../src/io.mjs';
export const PIN='257d287079cfac7d9a173078fc574e8fd7bbf212';
export const SKILLS=['query-token-info','query-token-audit','crypto-market-rank','query-address-info'];
export async function installSkills() {
 const repo=join(ROOT,'.cache/binance-skills-hub');
 if(!await exists(repo)) {
  await mkdir(repo,{recursive:true});
  execFileSync('git',['init',repo],{stdio:'pipe'});
  execFileSync('git',['-C',repo,'fetch','--depth','1','https://github.com/binance/binance-skills-hub.git',PIN],{stdio:'pipe'});
  execFileSync('git',['-C',repo,'checkout','--detach','FETCH_HEAD'],{stdio:'pipe'});
 }
 if(execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==PIN)
  throw new Error('Upstream cache is not the reviewed commit');
 const receipt={repository:'https://github.com/binance/binance-skills-hub',commit:PIN,
  license:'Selected Web3 skills have no explicit license field or root LICENSE at this commit. Private local use; clarify redistribution rights before publishing.',
  patches:['Portable pathToFileURL direct-execution check in three upstream Node scripts.'],files:[]};
 const writes=[];
 async function walk(source,target,relative) {
  for(const entry of await readdir(source,{withFileTypes:true})) {
   if(entry.isSymbolicLink()) throw new Error('Unexpected upstream symlink');
   const src=join(source,entry.name), dest=join(target,entry.name), rel=relative+'/'+entry.name;
   if(entry.isDirectory()) {await walk(src,dest,rel);continue;}
   const original=await readFile(src,'utf8'); let text=original;
   if(entry.name==='cli.mjs') {
    const old='if (import.meta.url === '+String.fromCharCode(96)+'file://$'+'{process.argv[1]}'+String.fromCharCode(96)+')';
    text=text.replace("const TIMEOUT_MS =","import { pathToFileURL } from 'node:url';\n\nconst TIMEOUT_MS =")
      .replace(old, 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)');
   }
   if(await exists(dest) && await readFile(dest,'utf8')!==text) throw new Error('Skill collision: '+rel+'; preserve local edits and review manually');
   writes.push({dest,text});
   receipt.files.push({path:rel,upstreamSha256:createHash('sha256').update(original).digest('hex'),sha256:createHash('sha256').update(text).digest('hex')});
  }
 }
 for(const name of SKILLS) await walk(join(repo,'skills/binance-web3',name),join(RESEARCH,'.agents/skills',name),name);
 for(const {dest,text} of writes) {await mkdir(join(dest,'..'),{recursive:true});await writeFile(dest,text);}
 await writeJson(join(ROOT,'sources/binance-skills.json'),receipt);
 return {skills:SKILLS,commit:PIN,files:writes.length};
}
