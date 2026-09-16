import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from './paths.mjs';
import {modeLocal} from './mode.mjs';
import {loadPolicy} from './config.mjs';
import {FreqtradeClient} from './freqtrade.mjs';
import {exists,readJson,writeJson,lock,journalRead,journalAppend} from './io.mjs';
import {loadPortfolioConfig,buildPortfolioReport,assessPortfolio,summarizePortfolioExposure} from './portfolio.mjs';
import {safeError} from './health.mjs';
import {assertNativeProtection} from './protection.mjs';
export const PORTFOLIO_LOCAL=join(ROOT,'local','portfolio');
const MODES=['demo','demo-futures'];
async function clients(){return Object.fromEntries(await Promise.all(MODES.map(async mode=>[mode,new FreqtradeClient(await loadPolicy(mode),await readJson(join(modeLocal(mode),'api-auth.json')))])));}
async function readSamples(local){const path=join(local,'samples.jsonl');if(!await exists(path))return [];const raw=await readFile(path,'utf8');if(raw&&!raw.endsWith('\n'))throw Error('PORTFOLIO_SAMPLES_TORN');return raw.split('\n').filter(Boolean).map(row=>JSON.parse(row));}
export async function portfolioLock(fn,{local=PORTFOLIO_LOCAL,timeoutMs=3000}={}){
 if(typeof fn!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<0)throw Error('PORTFOLIO_LOCK_OPTIONS_INVALID');
 const until=Date.now()+timeoutMs;
 for(;;){let acquired=false;try{return await lock(join(local,'entry.lock'),async()=>{acquired=true;return fn();});}
  // Retrying acquisition is safe. Once the callback starts it may have sent an
  // order, so NO callback error (even one named BUSY) can trigger another run.
  catch(error){if(acquired||!String(error?.message).startsWith('BUSY_OR_STALE_LOCK'))throw error;if(Date.now()>=until)throw Error('PORTFOLIO_BUSY');await delay(Math.min(100,Math.max(1,until-Date.now())));}}
}

function matchingOpenHistory(history,account){
 if(!Array.isArray(history)||!Array.isArray(account?.trades))throw Error('PORTFOLIO_ACCOUNT_UNAVAILABLE');
 const open=history.filter(trade=>trade?.is_open===true),current=account.trades;
 if(history.some(trade=>!Number.isSafeInteger(trade?.trade_id)||trade.trade_id<=0||typeof trade.is_open!=='boolean')||
  new Set(history.map(trade=>trade.trade_id)).size!==history.length||
  current.some(trade=>!Number.isSafeInteger(trade?.trade_id)||trade.trade_id<=0||trade.is_open!==true)||
  new Set(current.map(trade=>trade.trade_id)).size!==current.length)throw Error('PORTFOLIO_POSITION_INVALID');
 if(open.length!==current.length)return null;
 const replacements=new Map(current.map(trade=>[trade.trade_id,trade]));
 for(const trade of open){
  const latest=replacements.get(trade.trade_id);
  if(!latest||['pair','is_short','enter_tag','open_timestamp'].some(field=>latest[field]!==trade[field]))return null;
 }
 // Whole-record replacement is deliberate: a missing current mark/PnL must
 // remain missing and fail validation, never inherit the older history mark.
 return history.map(trade=>trade.is_open?replacements.get(trade.trade_id):trade);
}

async function stableModeRead(client,now){
 if(typeof client?.history!=='function'||typeof client?.snapshot!=='function')throw Error('PORTFOLIO_ACCOUNT_UNAVAILABLE');
 for(let attempt=0;attempt<2;attempt++){
  try{
   const history=await client.history(),account={...await client.snapshot(),observedAt:new Date(now()).toISOString()};
   const merged=matchingOpenHistory(history,account);
   if(merged)return {history:merged,account};
  }catch(error){
   if(!String(error?.message).startsWith('HISTORY_CHANGED'))throw error;
  }
  // This bounded retry repeats reads only. Order submission lives outside
  // stableModeRead and is never replayed by this path.
 }
 throw Error('PORTFOLIO_HISTORY_CHANGED');
}

async function readContext({local=PORTFOLIO_LOCAL,getClients=clients,getConfig=loadPortfolioConfig,
 modeDirectory=modeLocal,now=()=>Date.now()}={}){
 const broker=await getClients(),histories={},accounts={},journalByMode={},plans={},executionQuotesByMode={};
 const baseline=await readJson(join(local,'baseline.json')),config=await getConfig();
 if(!baseline||!baseline.tagAttributionByMode||!baseline.historyCompleteByMode||MODES.some(mode=>
  !baseline.tagAttributionByMode[mode]||typeof baseline.tagAttributionByMode[mode]!=='object'||Array.isArray(baseline.tagAttributionByMode[mode])))
  throw Error('PORTFOLIO_BASELINE_INVALID');
 for(const mode of MODES){
  const state=await stableModeRead(broker?.[mode],now),directory=modeDirectory(mode);
  histories[mode]=state.history;accounts[mode]=state.account;
  journalByMode[mode]=await journalRead(join(directory,'orders.jsonl'));
  for(const row of journalByMode[mode]){
   if(row.status!=='pending'||!['buy','open-long','open-short'].includes(row.action)||Date.parse(row.at)<Date.parse(baseline.startedAt))continue;
   if(!/^codex-[a-f0-9]{32}$/.test(row.tag??'')||!['strategy','execution_probe'].includes(row.purpose)||!row.ruleVersion)continue;
   const value={purpose:row.purpose,version:row.ruleVersion},old=baseline.tagAttributionByMode[mode][row.tag];
   if(old&&(old.purpose!==value.purpose||old.version!==value.version))throw Error('PORTFOLIO_ATTRIBUTION_CONFLICT');
   baseline.tagAttributionByMode[mode][row.tag]=value;
  }
  baseline.historyCompleteByMode[mode]=true;
  for(const trade of accounts[mode].trades){
   if(!/^codex-[a-f0-9]{32}$/.test(trade.enter_tag??''))throw Error('PORTFOLIO_PLAN_MISSING');
   try{plans[mode+':'+trade.trade_id]=await readJson(join(directory,'entry-plans',trade.enter_tag+'.json'));}
   catch(error){if(error?.code==='ENOENT')throw Error('PORTFOLIO_PLAN_MISSING');throw error;}
  }
  executionQuotesByMode[mode]={};
  for(const row of journalByMode[mode]){
   if(row.status!=='pending'||!/^[-a-f0-9]{36}$/.test(row.snapshotId??''))continue;
   const file=join(directory,'runs',row.snapshotId+'.execution-quote.json');if(!await exists(file))continue;
   const quote=await readJson(file),trade=histories[mode].find(t=>t.enter_tag===row.tag);
   for(const order of trade?.orders??[])if(order.ft_order_tag===row.tag)executionQuotesByMode[mode][order.order_id]={pair:trade.pair,side:row.action==='open-short'?'sell':'buy',price:row.action==='open-short'?quote.bid:quote.ask,source:quote.source,observedAt:quote.fetchedAt,submittedAt:row.at};
  }
 }
 const samples=await readSamples(local),asOf=new Date(now()).toISOString();
 const report=buildPortfolioReport({histories,baseline,config,asOf,samples,executionQuotesByMode});
 report.exposure=summarizePortfolioExposure({accounts,plans,config,now:now()});
 const unresolved=[];
 for(const mode of MODES){
  const latest=new Map(journalByMode[mode].map(row=>[row.id,row]));
  for(const row of latest.values())if(['pending','unknown'].includes(row.status))unresolved.push({mode,id:row.id,status:row.status});
 }
 report.unresolvedSubmissions=unresolved;
 if(unresolved.length){
  // Finding no current position cannot prove an ambiguous submission did not
  // execute. Keep the accounting sample out of the durable equity chain until
  // the existing explicit reconciliation has produced a terminal journal row.
  report.evidenceComplete=false;report.sample.evidenceComplete=false;report.sample.budgetEquityUsdt=null;
  for(const name of ['netRealizedUsdt','unrealizedUsdt','netPnlUsdt','budgetEquityUsdt','returnPct','sampledMaxDrawdownUsdt','currentDrawdownUsdt','drawdownLimitBreached'])report[name]=null;
  report.warnings.push({code:'PORTFOLIO_UNRESOLVED_SUBMISSION',submissions:unresolved});
 }
 await writeJson(join(local,'baseline.json'),baseline);
 if(report.sample.evidenceComplete&&(!samples.length||Date.parse(report.sample.asOf)>Date.parse(samples.at(-1).asOf)))
  await journalAppend(join(local,'samples.jsonl'),report.sample);
 await writeJson(join(local,'report.json'),report);
 return {accounts,journalByMode,plans,config,performance:report,histories};
}
export async function refreshPortfolio(options={}){
 const local=options.local??PORTFOLIO_LOCAL;
 return portfolioLock(async()=>{
  try{return (await readContext(options)).performance;}
  catch(error){await writeJson(join(local,'report.json'),{schemaVersion:1,source:'freqtrade-demo-portfolio',asOf:new Date().toISOString(),evidenceComplete:false,error:safeError(error),budgetEquityUsdt:null,netRealizedUsdt:null,unrealizedUsdt:null,netPnlUsdt:null});throw error;}
 },{local,timeoutMs:options.timeoutMs??3000});
}
export async function withPortfolioEntry(options={},run){
 const now=options.now??(()=>Date.now()),protectionCheckFn=options.protectionCheckFn??assertNativeProtection;
 return portfolioLock(()=>run(async({proposal,mode,entryPlan})=>{
  for(let attempt=0;attempt<3;attempt++){
  const context=await readContext(options);
  // The bridge checks its selected engine. A shared-budget entry must also
  // prove the other engine has no unknown, orphaned or unprotected stops,
  // including when its current position list is empty.
  assessPortfolio({proposal,mode,entryPlan,...context,now:now()});
  try{for(const otherMode of MODES.filter(candidate=>candidate!==mode)){
   const account=context.accounts[otherMode],pair=account.trades[0]?.pair??(await (options.getPolicy??loadPolicy)(otherMode)).pairs[0];
   await protectionCheckFn({mode:otherMode,local:(options.modeDirectory??modeLocal)(otherMode),account,pair});
  }}catch(error){
   // Another mode may have just filled; its native loop attaches protection
   // shortly afterwards. Repeat only this read-only preflight with entirely
   // fresh accounts, never the caller that can submit an order. All checks
   // remain mandatory, and unresolved/identity errors are never retried here.
   if(error?.message!=='NATIVE_PROTECTION_POSITION_UNPROTECTED'||attempt===2)throw error;
   await (options.protectionReadDelay??delay)((attempt+1)*1000);
   continue;
  }
  // Protection inspection can take time. Recheck snapshot/report age before
  // returning permission to the bridge's submission path.
  return assessPortfolio({proposal,mode,entryPlan,...context,now:now()});
  }
 }),{local:options.local??PORTFOLIO_LOCAL,timeoutMs:options.timeoutMs??3000});
}
