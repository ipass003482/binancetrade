import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeJson,exists,readJson } from '../src/io.mjs';
import { recordFailure,recoverLock,healthStatus } from '../src/health.mjs';
import { runCycle } from '../src/workflow.mjs';
import { summarizeTrades,buildReport,markdown } from '../src/report.mjs';
import { modeArgs,modeLocal,modePolicy } from '../src/mode.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { fixture,engineConfig } from './fixtures.mjs';
import { assess } from '../src/risk.mjs';
const temp=()=>mkdtemp(join(tmpdir(),'binance-ops-'));
test('modes have separate state and unsupported live mode fails',()=>{
 assert.notEqual(modeLocal('demo'),modeLocal('dry-run'));
 assert.throws(()=>modeArgs(['cycle','--mode','live']),/MODE_REJECTED/);
 assert.deepEqual(modeArgs(['cycle','--mode','demo']),{mode:'demo',args:['cycle']});
});
test('Demo client refuses live exchange masquerading as selected bot',async()=>{
 const f=await fixture(),p=modePolicy(f.policy,'demo');
 const c={...engineConfig(p),dry_run:false,runmode:'live',demo_trading:false};
 const client=new FreqtradeClient(p,{username:'fake',password:'fake'},{fetchImpl:async()=>new Response(JSON.stringify(c))});
 await assert.rejects(client.assertMode(),/IDENTITY_REJECTED/);
 c.demo_trading=true;assert.equal((await client.assertMode()).demo_trading,true);
 await assert.rejects(client.assertDry(),/DRY_RUN_REQUIRED/);
});
test('last pre-send deadline prevents order after slow identity check',async()=>{
 const f=await fixture();let posts=0;
 const client=new FreqtradeClient(f.policy,{username:'fake',password:'fake'},{fetchImpl:async(u,o)=>{
  if(o.method==='POST')posts++;return new Response(JSON.stringify(engineConfig(f.policy)));
 }});
 await assert.rejects(client.submit(f.proposal,'tag',null,{validUntil:Date.now()-1}),/DEADLINE_EXPIRED/);
 assert.equal(posts,0);
});
test('Demo risk rejects public live quote even for a Demo-labelled snapshot',async()=>{
 const f=await fixture();f.policy=modePolicy(f.policy,'demo');f.snapshot.mode='demo';
 assert.throws(()=>assess(f),/DEMO_QUOTE_REQUIRED/);
 for(const q of [f.snapshot.markets[0],f.executionQuote])Object.assign(q,{mode:'demo',source:'https://demo-api.binance.com'});
 assert.equal(assess(f).action,'buy');
 f.snapshot.mode='dry-run';assert.throws(()=>assess(f),/MODE_MISMATCH/);
});
test('three persistent failures pause entries without requesting liquidation',async()=>{
 const local=await temp();
 for(let n=0;n<3;n++)await recordFailure(local,new Error('NETWORK_FAILED: sensitive-details'));
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,3);
 assert.equal(await exists(join(local,'STOP')),true);
 assert.equal((await readJson(join(local,'health.json'))).lastError,'NETWORK_FAILED');
});
test('recovery refuses alive owner, orphan child, and other project processes',async()=>{
 const local=await temp();await writeJson(join(local,'engine.lock'),{pid:12,childPid:13});
 await assert.rejects(recoverLock(local,'engine',{state:()=> 'alive',processes:async()=>[]}),/OWNER_NOT_PROVEN_DEAD/);
 await assert.rejects(recoverLock(local,'engine',{state:p=>p===13?'alive':'dead',processes:async()=>[]}),/OWNER_NOT_PROVEN_DEAD/);
 await assert.rejects(recoverLock(local,'engine',{state:()=> 'dead',processes:async()=>[{pid:99}]}),/PROCESSES_STILL_RUNNING/);
 assert.equal(await exists(join(local,'engine.lock')),true);
 await recoverLock(local,'engine',{state:()=> 'dead',processes:async()=>[]});
 assert.equal(await exists(join(local,'engine.lock')),false);
});
test('stale watch heartbeat is unhealthy even when engine is reachable',async()=>{
 const local=await temp(),f=await fixture();
 await writeJson(join(local,'watch.lock'),{pid:process.pid});
 await writeJson(join(local,'watch-heartbeat.json'),{pid:process.pid,at:'2000-01-01T00:00:00Z'});
 const h=await healthStatus(local,{snapshot:async()=>f.account},f.policy);
 assert.equal(h.healthy,false);assert.ok(h.problems.includes('WATCH_HEARTBEAT_STALE'));
});
test('cycle saves proposal and failure cause when risk rejects it',async()=>{
 const local=await temp(),f=await fixture();
 await assert.rejects(runCycle({local,policy:f.policy,client:{snapshot:async()=>f.account},
  collectFn:async()=>f.snapshot,analyzeFn:async()=>({proposal:f.proposal}),
  executeFn:async()=>{throw new Error('STAKE_LIMIT');}}),/STAKE_LIMIT/);
 assert.equal((await readJson(join(local,'runs',f.snapshot.id+'.outcome.json'))).code,'STAKE_LIMIT');
 assert.equal((await readJson(join(local,'runs',f.snapshot.id+'.proposal.json'))).action,'buy');
});
test('successful HOLD resets failure count; aborted research cannot submit',async()=>{
 const local=await temp(),f=await fixture();await recordFailure(local,new Error('FAILED'));
 const opts={local,policy:f.policy,client:{snapshot:async()=>f.account},
  collectFn:async()=>f.snapshot,analyzeFn:async()=>({proposal:{...f.proposal,action:'hold',stakeUsdt:'0'}})};
 await runCycle({...opts,executeFn:async()=>({status:'hold'})});
 assert.equal((await readJson(join(local,'health.json'))).consecutiveFailures,0);
 const ctrl=new AbortController();ctrl.abort();let submits=0;
 await assert.rejects(runCycle({...opts,signal:ctrl.signal,executeFn:async()=>{submits++;}}),/ABORTED/);
 assert.equal(submits,0);
});
test('report preserves fee currencies and does not subtract fees twice',()=>{
 const trades=[{trade_id:1,is_open:false,profit_abs:'0.1',close_timestamp:1,fee_open_cost:'0.01',fee_open_currency:'USDT',fee_close_cost:'0.001',fee_close_currency:'BNB'},
 {trade_id:2,is_open:false,profit_abs:'-0.3',close_timestamp:2}];
 const r=summarizeTrades(trades);
 assert.equal(r.netRealizedUsdt,'-0.2');assert.equal(r.closedTradeDrawdownUsdt,'0.3');
 assert.equal(r.winRate,0.5);assert.deepEqual(r.feesByCurrency,{USDT:'0.01',BNB:'0.001'});
 assert.equal(summarizeTrades([{is_open:false,profit_abs:null}]).netRealizedUsdt,null);
});
test('offline report labels cached positions stale and escapes model Markdown',async()=>{
 const local=await temp(),snapshotId=randomUUID();
 await writeJson(join(local,'trade-history.json'),{mode:'demo',observedAt:'2000-01-01T00:00:00Z',trades:[],openTrades:[]});
 await writeJson(join(local,'runs',snapshotId+'.proposal.json'),{snapshotId,action:'hold',pair:'',reason:'![remote](https://evil.invalid) <img>',evidenceIds:[]});
 const result=await buildReport(local,{history:async()=>{throw new Error('OFFLINE');}},'demo');
 const report=await readJson(result.json);
 assert.equal(report.historyFresh,false);assert.ok(report.warnings.length);
 assert.equal(report.decisions[0].submission,'not_submitted');
 assert.ok(!markdown(report).includes('![remote]('));
});
test('history includes active positions because Freqtrade trades endpoint is closed-only',async()=>{
 const f=await fixture(),c=new FreqtradeClient(f.policy,{});
 c.assertMode=async()=>({});
 c.request=async path=>path==='status'?[{trade_id:2,is_open:true,enter_tag:'codex-active'}]
  :{trades:[{trade_id:1,is_open:false}],total_trades:1};
 const history=await c.history();
 assert.equal(history.length,2);assert.equal(history.find(t=>t.trade_id===2).is_open,true);
 c.request=async path=>path==='status'?[]:path.includes('limit=1&')?{trades:[],total_trades:2}
  :{trades:[{trade_id:1}],total_trades:1};
 await assert.rejects(c.history(),/HISTORY_CHANGED/);
});
