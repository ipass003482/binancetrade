#!/usr/bin/env node
import { runHighFrequency } from '../src/ai-high-frequency.mjs';

function options(argv){
 const result={cycles:1,intervalSeconds:60,strategyProfile:'auto',sensitivity:'balanced'};
 for(let i=0;i<argv.length;i++){
  const key=argv[i],value=argv[++i];
  if(key==='--cycles')result.cycles=Number(value);
  else if(key==='--interval-seconds')result.intervalSeconds=Number(value);
  else if(key==='--profile')result.strategyProfile=value;
  else if(key==='--sensitivity')result.sensitivity=value;
  else if(key==='--help')return null;
  else throw new Error('INVALID_ARGUMENTS: --cycles N --interval-seconds N --profile auto|momentum|mean-reversion|breakout --sensitivity conservative|balanced|aggressive');
 }
 return result;
}
const argv=options(process.argv.slice(2));
if(!argv)console.log('AI adaptive high-frequency CLI observer (dry-run only)\n  npm run ai:high-frequency -- --cycles 1 --interval-seconds 60 --profile auto --sensitivity balanced');
else runHighFrequency(argv).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(JSON.stringify({error:String(error.message??error)}));process.exitCode=1;});
