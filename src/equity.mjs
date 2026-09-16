import { join } from 'node:path';
import { appendFile,readFile } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { readAccountFacts } from './account-facts.mjs';
import { lock,writeJson,exists } from './io.mjs';
import { safeError } from './health.mjs';
const decimal=value=>{if(!['number','string'].includes(typeof value)||String(value).trim()==='')throw Error('EQUITY_INVALID');const n=new Decimal(value);if(!n.isFinite())throw Error('EQUITY_INVALID');return n;};
export function equitySummary(samples){
 const valid=samples.filter(s=>s.status==='ok');
 if(!valid.length)return {status:'unavailable',samples:0};
 let peak=decimal(valid[0].equityUsdt),drawdown=new Decimal(0),pct=new Decimal(0),maxGap=0;
 for(let i=0;i<valid.length;i++){
  const s=valid[i],value=decimal(s.equityUsdt);if(value.lt(0))throw Error('EQUITY_INVALID');
  const at=Date.parse(s.observedAt);if(!Number.isFinite(at)||(i&&at<=Date.parse(valid[i-1].observedAt)))throw Error('EQUITY_TIME_INVALID');
  if(i)maxGap=Math.max(maxGap,at-Date.parse(valid[i-1].observedAt));
  peak=Decimal.max(peak,value);drawdown=Decimal.max(drawdown,peak.minus(value));if(peak.gt(0))pct=Decimal.max(pct,peak.minus(value).div(peak).mul(100));
 }
 const first=valid[0],last=valid.at(-1);
 return {status:'observed_unadjusted',samples:valid.length,failedSamples:samples.length-valid.length,firstObservedAt:first.observedAt,observedAt:last.observedAt,
  equityUsdt:last.equityUsdt,changeSinceFirstUsdt:decimal(last.equityUsdt).minus(first.equityUsdt).toFixed(),
  sampledUnadjustedDrawdownUsdt:drawdown.toFixed(),sampledUnadjustedDrawdownPct:pct.toFixed(),maxGapSeconds:maxGap/1000,
  flowAdjustedProfitUsdt:null,flowAdjustedDrawdownPct:null,
  note:'Whole account sampled equity includes holdings; raw changes include external transfers and non-bot assets. Capital flows are not reconciled: changes are NOT strategy profit. Sampled drawdown can miss intraminute extremes.'};
}
export async function recordEquity(local,mode,{read=readAccountFacts}={}){
 if(!['demo','demo-futures'].includes(mode))return null;
 return lock(join(local,'equity.lock'),async()=>{
  let sample;
  try{
   const facts=await read(mode,'equity'),v=facts.valuation;
   if(!v||v.equityUsdt===null||decimal(v.equityUsdt).lt(0)||!Array.isArray(v.missingAssets)||v.missingAssets.length)throw Error('EQUITY_VALUATION_INCOMPLETE');
   sample={mode,status:'ok',observedAt:facts.observedAt,equityUsdt:decimal(v.equityUsdt).toFixed(),source:facts.source,valuation:v};
  }catch(e){sample={mode,status:'unavailable',observedAt:new Date().toISOString(),reason:safeError(e)};}
  const file=join(local,'equity.jsonl'),text=await exists(file)?await readFile(file,'utf8'):'';
  if(text&&!text.endsWith('\n'))throw Error('EQUITY_JOURNAL_INCOMPLETE');
  const previous=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(previous.some(s=>s.mode!==mode))throw Error('EQUITY_MODE_MISMATCH');
  const summary=equitySummary([...previous,sample]);
  await appendFile(file,JSON.stringify(sample)+'\n',{mode:0o600});
  const result={...summary,lastAttempt:sample};
  await writeJson(join(local,'equity-summary.json'),result);return result;
 });
}
