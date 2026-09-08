import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Decimal from 'decimal.js';
import { ROOT } from '../src/paths.mjs';
import { modeLocal } from '../src/mode.mjs';
import { loadPolicy } from '../src/config.mjs';
import { PYTHON } from '../src/engine.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { readJson,writeJson,exists,lock } from '../src/io.mjs';
import { collect } from '../src/research.mjs';
import { execute } from '../src/bridge.mjs';
import { buildReport } from '../src/report.mjs';
import { safeEnv } from '../src/codex.mjs';
import { safeError } from '../src/health.mjs';
if(process.argv.length!==3||process.argv[2]!=='--allow-demo-orders')throw new Error('Explicit --allow-demo-orders required');
const local=modeLocal('demo'),policy=await loadPolicy('demo');
const client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
const artifact=join(local,'acceptance',randomUUID()+'.json');
function checkAccount(){
 const output=execFileSync(PYTHON,[join(ROOT,'scripts/demo-check.py')],{cwd:ROOT,env:safeEnv(),encoding:'utf8',
  timeout:90000,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const r=JSON.parse(output);assert.equal(r.mode,'demo');assert.equal(r.endpoint,'https://demo-api.binance.com');
 assert.equal(r.readOnly,true);assert.equal(r.accountType,'SPOT');assert.equal(r.canTrade,true);
 return r;
}
async function waitFor(fn){
 const end=Date.now()+90000;
 while(Date.now()<end){const r=await fn();if(r)return r;await delay(1500);}
 throw new Error('DEMO_ACCEPTANCE_TIMEOUT: inspect state; no blind retry');
}
await lock(join(local,'watch.lock'),()=>lock(join(local,'cycle.lock'),async()=>{
 if(await exists(join(local,'STOP')))throw new Error('ENTRIES_PAUSED: review state before explicit resume');
 const before=checkAccount();assert.equal(before.openOrders,0,'Demo account must have no pending orders');
 assert.deepEqual((await client.snapshot()).trades,[],'Managed Demo positions must be empty');
 const result={mode:'demo',startedAt:new Date().toISOString(),before,status:'running'};
 try{
  const snapshot=await collect(policy,{includeWeb3:false}),proposal={action:'buy',pair:'BTC/USDT',stakeUsdt:policy.maxStakeUsdt,
   snapshotId:snapshot.id,evidenceIds:['spot:BTC/USDT'],reason:'Explicit Demo account acceptance, virtual funds only'};
  await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),snapshot);
  await writeJson(join(local,'runs',snapshot.id+'.proposal.json'),proposal);
  result.entry=await execute({proposal,snapshot,policy,client,local});
  await waitFor(async()=>{const s=await client.snapshot();return s.trades.length===1&&!s.trades[0].has_open_orders;});
  const exitSnapshot=await collect(policy,{includeWeb3:false}),exitProposal={...proposal,action:'sell',stakeUsdt:'0',snapshotId:exitSnapshot.id};
  await writeJson(join(local,'runs',exitSnapshot.id+'.snapshot.json'),exitSnapshot);
  await writeJson(join(local,'runs',exitSnapshot.id+'.proposal.json'),exitProposal);
  result.exit=await execute({proposal:exitProposal,snapshot:exitSnapshot,policy,client,local});
  await waitFor(async()=>(await client.snapshot()).trades.length===0);
  result.after=checkAccount();assert.equal(result.after.openOrders,0);
  const balance=(a,asset)=>{const b=a.balances.find(b=>b.asset===asset);return new Decimal(b?.free??0).plus(b?.locked??0);};
  result.btcBalanceDelta=balance(result.after,'BTC').minus(balance(before,'BTC')).toFixed();
  result.usdtBalanceDelta=balance(result.after,'USDT').minus(balance(before,'USDT')).toFixed();
  result.openManagedTrades=0;
  // A remaining base-currency difference needs review; never liquidate pre-existing Demo balances.
  result.status=new Decimal(result.btcBalanceDelta).abs().lte('0.00001')?'passed':'balance_review_required';
  result.report=await buildReport(local,client,'demo');
 }catch(e){result.status='failed';result.error=safeError(e);process.exitCode=1;}
 finally{
  try{result.finalManagedTrades=(await client.snapshot()).trades;}catch{result.finalStateUnavailable=true;}
  result.finishedAt=new Date().toISOString();await writeJson(artifact,result);
  console.log(JSON.stringify({status:result.status,artifact,openManagedTrades:result.finalManagedTrades?.length??null,
   message:'Engine remains running. If failed, inspect status/reconcile; do not blindly rerun.'},null,2));
  if(result.status!=='passed')process.exitCode=1;
 }
}));
