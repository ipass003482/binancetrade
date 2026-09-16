import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {portfolioLock,refreshPortfolio,withPortfolioEntry} from '../src/portfolio-store.mjs';
import {PORTFOLIO_DEFAULTS} from '../src/portfolio.mjs';
import {writeJson,readJson,journalAppend,exists} from '../src/io.mjs';

const modes=['demo','demo-futures'],at='2026-09-10T13:00:00.000Z',startedAt='2026-09-10T12:00:00.000Z';
const tag='codex-'+'1'.repeat(32),id='1'.repeat(32);
const position=(extra={})=>({trade_id:1,pair:'ETH/USDT',enter_tag:tag,is_open:true,is_short:false,
 has_open_orders:false,open_timestamp:Date.parse(startedAt)+60000,close_timestamp:null,profit_abs:0,
 current_rate:100,amount:'.5',stake_amount:50,leverage:1,trading_mode:'spot',fee_open_cost:'.025',...extra});
const plan=(extra={})=>({pair:'ETH/USDT',isShort:false,ruleVersion:'rules-v6',purpose:'strategy',
 stopFraction:'.009',riskCostFraction:'.001',riskBudgetUsdt:1,maxEntryNotionalUsdt:50,...extra});
const account=(mode,trades=[])=>({engine:{demo_trading:true,dry_run:false,exchange:'binance',trading_mode:mode==='demo'?'spot':'futures'},
 trades,daily:{stake_currency:'USDT',data:[{date:'2026-09-10',abs_profit:0}]}});
const pending={id,tag,at:'2026-09-10T12:01:00.000Z',status:'pending',action:'buy',pair:'ETH/USDT',tradeId:1,purpose:'strategy',ruleVersion:'rules-v6'};

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'binancetrade-portfolio-store-'));
 // Only this fixture's verified temporary tree is ever removed.
 const absolute=resolve(dir),relativeName=relative(resolve(tmpdir()),absolute);
 t.after(async()=>{if(relativeName.startsWith('..')||isAbsolute(relativeName)||!basename(absolute).startsWith('binancetrade-portfolio-store-'))throw Error('TEST_TEMP_PATH_REJECTED');await rm(absolute,{recursive:true,force:true});});
 const local=join(dir,'portfolio'),modeDirectory=mode=>join(dir,mode),histories={demo:[],'demo-futures':[]},accounts={demo:account('demo'),'demo-futures':account('demo-futures')};
 const calls={demo:{history:0,snapshot:0},'demo-futures':{history:0,snapshot:0}};
 const broker=Object.fromEntries(modes.map(mode=>[mode,{
  history:async()=>{calls[mode].history++;return structuredClone(histories[mode]);},
  snapshot:async()=>{calls[mode].snapshot++;return structuredClone(accounts[mode]);}
 }]));
 const baseline={startedAt,source:'freqtrade-demo',historyCompleteByMode:{demo:false,'demo-futures':false},
  excludedTradeIdsByMode:{demo:[],'demo-futures':[]},tagAttributionByMode:{demo:{},'demo-futures':{}}};
 await writeJson(join(local,'baseline.json'),baseline);
 const options={local,modeDirectory,getClients:async()=>broker,getConfig:async()=>({...PORTFOLIO_DEFAULTS}),now:()=>Date.parse(at),
  protectionCheckFn:async()=>({verified:true}),getPolicy:async mode=>({pairs:[mode==='demo'?'BTC/USDT':'BTC/USDT:USDT']})};
 async function setPosition(trade=position(),riskPlan=plan()){
  histories.demo=[structuredClone(trade)];accounts.demo.trades=[structuredClone(trade)];
  await writeJson(join(modeDirectory('demo'),'entry-plans',tag+'.json'),riskPlan);
  await journalAppend(join(modeDirectory('demo'),'orders.jsonl'),pending);
  await journalAppend(join(modeDirectory('demo'),'orders.jsonl'),{...pending,status:'submitted'});
 }
 return {dir,local,modeDirectory,histories,accounts,calls,broker,baseline,options,setPosition};
}

test('refresh uses injected isolated sources, persists attribution and fsynced equity samples',async t=>{
 const f=await fixture(t);await f.setPosition();const report=await refreshPortfolio(f.options);
 assert.equal(report.evidenceComplete,true);assert.equal(report.capitalUsdt,'2000');assert.equal(report.netPnlUsdt,'0');
 assert.equal(report.exposure.grossUsdt,'50');assert.equal(report.exposure.estimatedOpenRiskUsdt,'0.5');
 const baseline=await readJson(join(f.local,'baseline.json'));
 assert.deepEqual(baseline.tagAttributionByMode.demo[tag],{purpose:'strategy',version:'rules-v6'});
 assert.deepEqual(baseline.historyCompleteByMode,{demo:true,'demo-futures':true});
 const samples=(await readFile(join(f.local,'samples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(samples,[report.sample]);assert.equal(await exists(join(f.local,'entry.lock')),false);
 await refreshPortfolio(f.options);assert.equal((await readFile(join(f.local,'samples.jsonl'),'utf8')).trim().split('\n').length,1);
});

test('fresh snapshot replaces entire open history record, including current PnL and mark',async t=>{
 const f=await fixture(t);await f.setPosition();f.histories.demo[0].profit_abs='200';f.accounts.demo.trades[0].profit_abs='-1';f.accounts.demo.trades[0].current_rate=120;
 const report=await refreshPortfolio(f.options);assert.equal(report.unrealizedUsdt,'-1');assert.equal(report.budgetEquityUsdt,'1999');
 assert.equal(report.exposure.grossUsdt,'60');assert.equal(f.calls.demo.history,1);assert.equal(f.calls.demo.snapshot,1);
});

test('a native close between history and snapshot retries reads once and records the closure',async t=>{
 const f=await fixture(t);await f.setPosition();const old=position(),closed={...old,is_open:false,close_timestamp:Date.parse(at)-1000,profit_abs:'2',fee_close_cost:'.025'};
 f.broker.demo.history=async()=>{f.calls.demo.history++;return structuredClone(f.calls.demo.history===1?[old]:[closed]);};
 f.accounts.demo.trades=[];
 const report=await refreshPortfolio(f.options);assert.equal(report.netRealizedUsdt,'2');assert.equal(report.unrealizedUsdt,'0');
 assert.equal(report.exposure.grossUsdt,'0');assert.equal(f.calls.demo.history,2);assert.equal(f.calls.demo.snapshot,2);
});

test('history consistency error permits one read retry; unrelated errors are not retried',async t=>{
 const f=await fixture(t);f.broker.demo.history=async()=>{f.calls.demo.history++;if(f.calls.demo.history===1)throw Error('HISTORY_CHANGED: retry read');return [];};
 assert.equal((await refreshPortfolio(f.options)).evidenceComplete,true);assert.equal(f.calls.demo.history,2);assert.equal(f.calls.demo.snapshot,1);
 f.calls.demo.history=0;f.broker.demo.history=async()=>{f.calls.demo.history++;throw Error('ENGINE_IDENTITY_REJECTED');};
 await assert.rejects(refreshPortfolio(f.options),/ENGINE_IDENTITY_REJECTED/);assert.equal(f.calls.demo.history,1);
});

test('persistent native position change fails closed without appending a sample',async t=>{
 const f=await fixture(t);await f.setPosition();f.accounts.demo.trades=[];
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_HISTORY_CHANGED/);
 assert.equal(f.calls.demo.history,2);assert.equal(f.calls.demo.snapshot,2);assert.equal(await exists(join(f.local,'samples.jsonl')),false);
 const cached=await readJson(join(f.local,'report.json'));assert.equal(cached.evidenceComplete,false);assert.equal(cached.budgetEquityUsdt,null);
 assert.equal(cached.error,'PORTFOLIO_HISTORY_CHANGED');
});

test('identity changes sharing a trade ID are detected instead of merging unrelated positions',async t=>{
 const f=await fixture(t);await f.setPosition();f.accounts.demo.trades[0].enter_tag='codex-'+'2'.repeat(32);
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_HISTORY_CHANGED/);assert.equal(f.calls.demo.history,2);
});

test('missing fresh marks never inherit old history values, even for excluded baseline positions',async t=>{
 const f=await fixture(t);await f.setPosition();f.baseline.excludedTradeIdsByMode.demo=[1];await writeJson(join(f.local,'baseline.json'),f.baseline);
 delete f.accounts.demo.trades[0].current_rate;
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_POSITION_MARK_UNAVAILABLE/);
 assert.equal((await readJson(join(f.local,'report.json'))).evidenceComplete,false);
 assert.equal(await exists(join(f.local,'samples.jsonl')),false);
});

test('missing plan and zero marks cannot be shown as healthy actual exposure',async t=>{
 const f=await fixture(t);await f.setPosition();f.accounts.demo.trades[0].current_rate=0;
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_POSITION_MARK_UNAVAILABLE/);
 f.accounts.demo.trades[0].current_rate=100;await rm(join(f.modeDirectory('demo'),'entry-plans',tag+'.json'));
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_PLAN_MISSING/);
});

test('torn sample history remains intact and blocks new accounting',async t=>{
 const f=await fixture(t),file=join(f.local,'samples.jsonl');await writeFile(file,'{"source":"unfinished"');
 await assert.rejects(refreshPortfolio(f.options),/PORTFOLIO_SAMPLES_TORN/);assert.equal(await readFile(file,'utf8'),'{"source":"unfinished"');
});

test('portfolio lock never retries a callback that might have submitted an order',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(portfolioLock(async()=>{calls++;throw Error('BUSY_OR_STALE_LOCK: downstream after submission');},{local:f.local,timeoutMs:1000}),/BUSY_OR_STALE_LOCK/);
 assert.equal(calls,1);assert.equal(await exists(join(f.local,'entry.lock')),false);
 await assert.rejects(withPortfolioEntry(f.options,async()=>{calls++;throw Error('BUSY_OR_STALE_LOCK: downstream after submission');}),/BUSY_OR_STALE_LOCK/);
 assert.equal(calls,2);
});

test('global lock covers fresh cross-mode check through caller submission completion',async t=>{
 const f=await fixture(t);let unlock,started;const ready=new Promise(resolve=>{started=resolve;}),finish=new Promise(resolve=>{unlock=resolve;});
 let callbacks=0;
 const active=withPortfolioEntry(f.options,async check=>{
  callbacks++;assert.equal(await exists(join(f.local,'entry.lock')),true);
  const risk=await check({mode:'demo',proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},entryPlan:plan({pair:'BTC/USDT'})});
  assert.equal(risk.grossExposureAfterUsdt,'50');started();await finish;
  assert.equal(await exists(join(f.local,'entry.lock')),true);return {status:'submitted'};
 });
 await ready;
 try{await assert.rejects(portfolioLock(()=>{throw Error('must not enter callback');},{local:f.local,timeoutMs:0}),/PORTFOLIO_BUSY/);}
 finally{unlock();}
 assert.deepEqual(await active,{status:'submitted'});assert.equal(callbacks,1);assert.equal(await exists(join(f.local,'entry.lock')),false);
});

test('unknown submission blocks the caller before its fake order and does not clear journal',async t=>{
 const f=await fixture(t);await journalAppend(join(f.modeDirectory('demo-futures'),'orders.jsonl'),{id,at,status:'unknown'});let orders=0;
 await assert.rejects(withPortfolioEntry(f.options,async check=>{
  await check({mode:'demo',proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},entryPlan:plan({pair:'BTC/USDT'})});orders++;
 }),/PORTFOLIO_UNRESOLVED_SUBMISSION/);
 assert.equal(orders,0);assert.ok((await readFile(join(f.modeDirectory('demo-futures'),'orders.jsonl'),'utf8')).includes('unknown'));
 const cached=await readJson(join(f.local,'report.json'));assert.equal(cached.evidenceComplete,false);assert.equal(cached.budgetEquityUsdt,null);
 assert.equal(cached.unresolvedSubmissions.length,1);assert.equal(await exists(join(f.local,'samples.jsonl')),false);
});

test('other mode native protection blocks entries even when its positions are flat; reports remain read only',async t=>{
 const f=await fixture(t);let orders=0,checks=0;
 f.options.protectionCheckFn=async args=>{
  checks++;assert.equal(args.mode,'demo-futures');assert.equal(args.local,f.modeDirectory('demo-futures'));
  assert.equal(args.pair,'BTC/USDT:USDT');assert.equal(args.account.trades.length,0);
  throw Error('NATIVE_PROTECTION_RECONCILIATION_REQUIRED');
 };
 await assert.rejects(withPortfolioEntry(f.options,async check=>{
  await check({mode:'demo',proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},entryPlan:plan({pair:'BTC/USDT'})});orders++;
 }),/NATIVE_PROTECTION_RECONCILIATION_REQUIRED/);
 assert.equal(orders,0);assert.equal(checks,1);
 assert.equal((await refreshPortfolio(f.options)).evidenceComplete,true);assert.equal(checks,1);
});

test('other mode existing position determines protection pair before futures entry',async t=>{
 const f=await fixture(t);await f.setPosition();let checked;
 f.options.protectionCheckFn=async args=>{checked=args;return {verified:true};};
 await withPortfolioEntry(f.options,async check=>check({mode:'demo-futures',proposal:{action:'open-short',pair:'BTC/USDT:USDT',stakeUsdt:'50',leverage:1},
  entryPlan:plan({pair:'BTC/USDT:USDT',isShort:true})}));
 assert.equal(checked.mode,'demo');assert.equal(checked.pair,'ETH/USDT');assert.equal(checked.account.trades[0].trade_id,1);
});

test('cross-mode protection lag refreshes full accounts without replaying submission callback',async t=>{
 const f=await fixture(t);await f.setPosition();let checks=0,callbacks=0,orders=0;const waits=[];
 f.accounts.demo.trades[0].orders=[];
 f.options.protectionReadDelay=async ms=>{
  waits.push(ms);f.accounts.demo.trades[0].orders=[{status:'open',order_id:'native-stop'}];
 };
 f.options.protectionCheckFn=async({account})=>{
  checks++;
  if(!account.trades[0].orders.length)throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');
  assert.equal(account.trades[0].orders[0].order_id,'native-stop');
 };
 await withPortfolioEntry(f.options,async check=>{
  callbacks++;
  await check({mode:'demo-futures',proposal:{action:'open-short',pair:'BTC/USDT:USDT',stakeUsdt:'50',leverage:1},entryPlan:plan({pair:'BTC/USDT:USDT',isShort:true})});orders++;
 });
 assert.equal(callbacks,1);assert.equal(orders,1);assert.equal(checks,2);
 assert.deepEqual(waits,[1000]);assert.equal(f.calls.demo.snapshot,2);assert.equal(f.calls['demo-futures'].snapshot,2);
});

test('persistent cross-mode protection absence remains blocked after bounded reads',async t=>{
 const f=await fixture(t);let checks=0,callbacks=0,orders=0;const waits=[];
 f.options.protectionReadDelay=async ms=>{waits.push(ms);};
 f.options.protectionCheckFn=async()=>{checks++;throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');};
 await assert.rejects(withPortfolioEntry(f.options,async check=>{
  callbacks++;await check({mode:'demo',proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},entryPlan:plan({pair:'BTC/USDT'})});orders++;
 }),/NATIVE_PROTECTION_POSITION_UNPROTECTED/);
 assert.equal(callbacks,1);assert.equal(orders,0);assert.equal(checks,3);assert.deepEqual(waits,[1000,2000]);
 assert.equal(f.calls.demo.snapshot,3);assert.equal(f.calls['demo-futures'].snapshot,3);
});

test('new unresolved submission during protection wait is rejected by fresh risk assessment',async t=>{
 const f=await fixture(t);let orders=0,checks=0;
 f.options.protectionCheckFn=async()=>{checks++;throw Error('NATIVE_PROTECTION_POSITION_UNPROTECTED');};
 f.options.protectionReadDelay=async()=>journalAppend(join(f.modeDirectory('demo-futures'),'orders.jsonl'),{id:'f'.repeat(32),at,status:'unknown'});
 await assert.rejects(withPortfolioEntry(f.options,async check=>{
  await check({mode:'demo',proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},entryPlan:plan({pair:'BTC/USDT'})});orders++;
 }),/PORTFOLIO_UNRESOLVED_SUBMISSION/);
 assert.equal(orders,0);assert.equal(checks,1);
});
