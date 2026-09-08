import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT,LOCAL } from '../src/paths.mjs';
import { loadPolicy } from '../src/config.mjs';
import { readJson,writeJson } from '../src/io.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { execute } from '../src/bridge.mjs';
import { collect } from '../src/research.mjs';
import { safeEnv } from '../src/codex.mjs';
import { PYTHON } from '../src/engine.mjs';
import { buildReport } from '../src/report.mjs';
import { runCycle } from '../src/workflow.mjs';
if(process.argv[2]!=='--allow-dry-run-orders') throw new Error('Pass --allow-dry-run-orders for isolated simulated buy/sell acceptance');
const dir=join(LOCAL,'native-smoke',randomUUID());await mkdir(dir,{recursive:true});
const policy=await loadPolicy();policy.freqtrade.url='http://127.0.0.1:18081';
const auth={username:'smoke',password:randomBytes(24).toString('hex')};
const config=await readJson(join(LOCAL,'freqtrade/config.json'));
config.dry_run=true;config.exchange.key='';config.exchange.secret='';
config.api_server={...config.api_server,listen_port:18081,...auth};
await writeJson(join(dir,'config.json'),config);
const log=await open(join(dir,'process.log'),'w');
const child=spawn(PYTHON,['-m','freqtrade','trade','--config',join(dir,'config.json'),
 '--userdir',dir,'--strategy-path',join(ROOT,'freqtrade/strategies'),'--strategy','CodexResearchSpot',
 '--db-url','sqlite:///'+join(dir,'trades.dryrun.sqlite').replaceAll('\\','/')],{
 cwd:ROOT,env:safeEnv(),shell:false,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
let childError;
child.on('error',e=>{childError=e;});
const client=new FreqtradeClient(policy,auth);
async function waitFor(fn,limit=60000) {
 const end=Date.now()+limit;
 while(Date.now()<end){if(childError)throw childError;if(child.exitCode!==null)throw new Error('Smoke engine exited; inspect '+dir);
  try{const value=await fn();if(value)return value;}catch(e){if(Date.now()+1000>=end)throw e;}
  await delay(1000);
 }throw new Error('Timed out; inspect '+dir);
}
let result;
try {
 await waitFor(()=>client.assertDry(),120000);
 assert.deepEqual((await client.snapshot()).trades,[]);
 const snapshot=await collect(policy,{includeWeb3:false});
 const proposal={action:'buy',pair:'BTC/USDT',stakeUsdt:policy.maxStakeUsdt,snapshotId:snapshot.id,
   evidenceIds:['spot:BTC/USDT'],reason:'Isolated native dry-run acceptance; not a strategy signal'};
 await writeJson(join(dir,'runs',snapshot.id+'.snapshot.json'),snapshot);
 await writeJson(join(dir,'runs',snapshot.id+'.proposal.json'),proposal);
 const entry=await execute({snapshot,proposal,policy,client,local:dir});
 await assert.rejects(execute({snapshot,proposal,policy,client,local:dir}),/ALREADY_CONSUMED/);
 await waitFor(async()=>{const s=await client.snapshot();return s.trades.length===1&&!s.trades[0].has_open_orders;});
 const exitSnapshot=await collect(policy,{includeWeb3:false});
 const exitProposal={...proposal,action:'sell',stakeUsdt:'0',snapshotId:exitSnapshot.id};
 await writeJson(join(dir,'runs',exitSnapshot.id+'.snapshot.json'),exitSnapshot);
 await writeJson(join(dir,'runs',exitSnapshot.id+'.proposal.json'),exitProposal);
 const exit=await execute({snapshot:exitSnapshot,proposal:exitProposal,policy,client,local:dir});
 await waitFor(async()=>(await client.snapshot()).trades.length===0);
 const history=await client.request('trades?limit=100');
 assert.equal(history.trades_count,1);assert.equal(history.trades[0].is_open,false);
 const hold=await runCycle({local:dir,policy,client,collectFn:p=>collect(p,{includeWeb3:false}),
  analyzeFn:async s=>({proposal:{action:'hold',pair:'',stakeUsdt:'0',snapshotId:s.id,evidenceIds:[],reason:'Native lifecycle smoke HOLD'}})});
 assert.equal(hold.result.status,'hold');
 const report=await buildReport(dir,client,'dry-run');
 assert.equal(report.historyFresh,true);assert.equal(report.summary.closedTrades,1);
 const reportData=await readJson(report.json);
 assert.equal(reportData.decisions.filter(d=>d.tradeIds.length===1).length,2);
 result={report,status:'passed',engine:'Freqtrade 2026.8 native Windows',mode:'dry-run',entry,exit,openTrades:0,realOrders:0,artifacts:dir};
 await writeJson(join(dir,'result.json'),result);
 console.log(JSON.stringify(result,null,2));
} finally {
 // Never touch another engine; only this child and its isolated simulated database.
 if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('close',r)),delay(10000)]);}
 await log.close();
}
