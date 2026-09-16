import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/paths.mjs';
import { loadResearchProfile } from '../src/research-profile.mjs';
import { loadPolicy } from '../src/config.mjs';
import { loadAnalyst } from '../src/analyst.mjs';
import { loadEvaluationThresholds } from '../src/evaluation.mjs';
import { loadCosts } from '../src/trading-costs.mjs';
import { loadDecisionConfig } from '../src/decision.mjs';
import { loadPortfolioConfig } from '../src/portfolio.mjs';
import { loadVolumeExperiment } from '../src/volume-experiment.mjs';
let count=0;
async function walk(dir){
 for(const e of await readdir(dir,{withFileTypes:true})){
  const p=join(dir,e.name);
  if(e.isDirectory())await walk(p);
  else if(p.endsWith('.mjs')){execFileSync(process.execPath,['--check',p],{stdio:'pipe'});count++;}
 }
}
for(const d of ['src','scripts','test','ui'])await walk(join(ROOT,d));
await loadPolicy();await loadPolicy('demo');await loadPolicy('demo-futures');await loadResearchProfile();await loadAnalyst();
await loadEvaluationThresholds();
await loadCosts();await loadDecisionConfig();
await loadPortfolioConfig();
await loadVolumeExperiment();
console.log(JSON.stringify({syntaxFiles:count,policy:'valid',mode:'dry-run'}));
