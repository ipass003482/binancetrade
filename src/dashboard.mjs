import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { loadPolicy } from './config.mjs';
import { modeLocal,isDemo,isFutures } from './mode.mjs';
import { readJson, exists } from './io.mjs';
import { FreqtradeClient } from './freqtrade.mjs';
import { safeError,healthStatus,pidState } from './health.mjs';
import { summarizeTrades } from './report.mjs';
import { market } from './research.mjs';
import { timeMonitor } from './time-monitor.mjs';
import { loadDecisionConfig,RULE_ENGINE_VERSION } from './decision.mjs';
import { readEntryDiagnostics } from './entry-diagnostics.mjs';
import {readTodayPnl} from './today-pnl.mjs';
import {readStrategyReview} from './strategy-review.mjs';
import {readCapitalView,startCapitalObserver} from './capital-flow-store.mjs';
import {readDemoSession,readActiveDemoScope,validateDemoSession,sessionTrades} from './demo-session.mjs';

export async function readEngine(client,{snapshot:providedSnapshot,session=null}={}) {
 const snapshot=providedSnapshot??await client.snapshot();
 const account={total:snapshot.balance.total_bot??snapshot.balance.total,accountTotal:snapshot.balance.total,positions:snapshot.trades.map(t=>({id:t.trade_id,pair:t.pair,...(t.trading_mode==='futures'?{isShort:t.is_short,leverage:t.leverage,notional:Number(t.amount)*Number(t.current_rate??t.close_rate??t.open_rate)}:{}),stake:t.stake_amount,openRate:t.open_rate,currentRate:t.current_rate,profit:t.profit_abs,profitRatio:t.profit_ratio}))};
 const engineVersion=snapshot.engine?.strategy_version??null;
 if(session)for(let i=0;i<account.positions.length;i++){
  const opened=snapshot.trades[i].open_timestamp;
  account.positions[i].sessionStatus=!Number.isSafeInteger(opened)||opened<=0?'unknown':opened<Date.parse(session.startedAt)?'outside_session':'current_session';
 }
 try {
  const history=sessionTrades(await client.history(),session);
  if(session&&account.positions.some(p=>p.sessionStatus!=='current_session'))throw Error('OUTSIDE_SESSION_OPEN_POSITION');
  return {account,engineVersion,summary:summarizeTrades(history),historyError:null,trades:history.filter(t=>t.is_open===false).sort((a,b)=>(b.close_timestamp??0)-(a.close_timestamp??0)).slice(0,50).map(t=>({id:t.trade_id,pair:t.pair,...(t.trading_mode==='futures'?{isShort:t.is_short,leverage:t.leverage,notional:Number(t.amount)*Number(t.current_rate??t.close_rate??t.open_rate)}:{}),stake:t.stake_amount,openRate:t.open_rate,closeRate:t.close_rate,profit:t.profit_abs,closedAt:t.close_date??null,exitReason:t.exit_reason??null}))};
 } catch(e) {return {account,engineVersion,summary:null,trades:null,historyError:safeError(e)};}
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const numeric=value=>['string','number'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))?value:null;
const string=value=>typeof value==='string'?value:null;
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const scalarFields=(value,names)=>Object.fromEntries(names.map(name=>[name,numeric(value?.[name])]));
const warningsView=value=>(Array.isArray(value)?value:[]).slice(0,100).map(warning=>({code:safeError({code:warning?.code})}));
const freshAt=(value,now,maxAge)=>time(value)!==null&&now-Date.parse(value)>=0&&now-Date.parse(value)<=maxAge;
async function optionalJson(file){try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function groupView(value){return object(value)?{...scalarFields(value,['closedTrades','openTrades','netRealizedUsdt','unrealizedUsdt','netPnlUsdt',
 'averageNetUsdt','winRate','profitFactor','engineFeesUsdt']),pnlComplete:value.pnlComplete===true,feesComplete:value.feesComplete===true}:null;}
export async function readPortfolioView(file,{now=Date.now()}={}){
 let raw;try{raw=await optionalJson(file);}catch(error){return {schemaVersion:1,source:'freqtrade-demo-portfolio',evidenceComplete:false,error:safeError(error),warnings:[{code:'PORTFOLIO_REPORT_UNREADABLE'}]};}
 if(!raw)return null;
 if(raw.schemaVersion!==1||raw.source!=='freqtrade-demo-portfolio'||!time(raw.asOf))return {
  schemaVersion:1,source:'freqtrade-demo-portfolio',evidenceComplete:false,error:'PORTFOLIO_REPORT_INVALID',warnings:[{code:'PORTFOLIO_REPORT_INVALID'}]};
 const fresh=freshAt(raw.asOf,now,180000),complete=fresh&&raw.evidenceComplete===true;
 const report={schemaVersion:1,source:raw.source,asOf:raw.asOf,startedAt:time(raw.startedAt),fresh,evidenceComplete:complete,
  capitalUsdt:numeric(raw.capitalUsdt),...scalarFields(raw,['sampleCount','maxSampleGapSeconds']),
  drawdownLimitBreached:complete&&typeof raw.drawdownLimitBreached==='boolean'?raw.drawdownLimitBreached:null,
  strategy:groupView(raw.strategy),probes:groupView(raw.probes),total:groupView(raw.total),warnings:warningsView(raw.warnings),
  byVersion:(Array.isArray(raw.byVersion)?raw.byVersion:[]).map(group=>({purpose:string(group.purpose),version:string(group.version),...groupView(group)})),
  executionCosts:object(raw.executionCosts)?scalarFields(raw.executionCosts,['actualSignedSlippageUsdt','coveredOrders','requiredOrders']):null,
  exposure:fresh&&object(raw.exposure)?{asOf:time(raw.exposure.asOf)??raw.asOf,
   ...scalarFields(raw.exposure,['grossUsdt','estimatedOpenRiskUsdt','allocatedMarginUsdt'])}:null};
 for(const field of ['netRealizedUsdt','unrealizedUsdt','netPnlUsdt','budgetEquityUsdt','returnPct','sampledMaxDrawdownUsdt','currentDrawdownUsdt'])report[field]=complete?numeric(raw[field]):null;
 report.grossExposureUsdt=report.exposure?.grossUsdt??null;
 if(!fresh)report.warnings.push({code:'PORTFOLIO_REPORT_STALE'});
 if(raw.error)report.error=safeError({code:raw.error});
 return report;
}
export async function readProtectionView(file,mode,{now=Date.now()}={}){
 const unknown=(error,asOf=null)=>({mode,available:false,fresh:false,status:'unknown',asOf,configured:null,activeStops:null,unresolvedStops:null,error});
 let raw;try{raw=await optionalJson(file);}catch(error){return unknown(safeError(error));}
 if(!raw)return unknown('DEMO_PROTECTION_NOT_OBSERVED');
 if(raw.version!=='demo-native-stop-v1'||raw.mode!==mode||!time(raw.asOf)||!Array.isArray(raw.activeStops)
  ||!Array.isArray(raw.attempts)||!Number.isInteger(raw.unresolvedStops)||raw.unresolvedStops<0
  ||raw.attempts.some(attempt=>!attempt||!['pending','unknown','confirmed','rejected'].includes(attempt.status)))
  return unknown('DEMO_PROTECTION_STATE_INVALID',time(raw.asOf));
 if(!freshAt(raw.asOf,now,120000))return unknown('DEMO_PROTECTION_STATE_STALE',raw.asOf);
 const rows=[];
 for(const stop of raw.activeStops){
  const proof=raw.attempts.find(attempt=>attempt?.status==='confirmed'&&attempt.orderStatus==='open'&&attempt.orderId===stop?.orderId);
  const valid=object(stop)&&typeof stop.orderId==='string'&&stop.orderId.length>0&&
   (mode==='demo-futures'?/^[A-Z0-9]+\/USDT:USDT$/:/^[A-Z0-9]+\/USDT$/).test(stop.pair)&&['buy','sell'].includes(stop.side)&&
   numeric(stop.amount)!==null&&Number(stop.amount)>0&&numeric(stop.stopPrice)!==null&&Number(stop.stopPrice)>0&&
   freshAt(stop.observedAt,now,120000)&&proof?.pair===stop.pair&&proof.side===stop.side&&proof.acceptedAmount===stop.amount&&proof.stopPrice===stop.stopPrice;
  if(!valid)return unknown('DEMO_PROTECTION_ORDER_EVIDENCE_INVALID',raw.asOf);
  rows.push({pair:stop.pair,orderId:stop.orderId,side:stop.side,amount:stop.amount,stopPrice:stop.stopPrice,observedAt:stop.observedAt});
 }
 if(rows.length!==raw.attempts.filter(attempt=>attempt.status==='confirmed'&&attempt.orderStatus==='open').length)
  return unknown('DEMO_PROTECTION_ORDER_EVIDENCE_INVALID',raw.asOf);
 const unresolved=Math.max(raw.unresolvedStops,raw.attempts.filter(attempt=>['pending','unknown'].includes(attempt?.status)).length);
 return {mode,available:true,fresh:true,version:raw.version,engineVersion:string(raw.engineVersion),asOf:raw.asOf,
  status:unresolved?'reconciliation_required':rows.length?'active_order_observed':'no_active_order_observed',
  configured:typeof raw.configured==='boolean'?raw.configured:null,unresolvedStops:unresolved,activeStops:rows,
  capabilities:object(raw.capabilities)?Object.fromEntries(Object.entries(raw.capabilities).map(([pair,value])=>[pair,{
   status:string(value?.status),orderType:string(value?.orderType),destination:string(value?.destination),reduceOnly:value?.reduceOnly===true}])):{},
  protectionEvidence:string(raw.protectionEvidence)};
}
export async function readSupervisorView(file,{now=Date.now(),state=pidState}={}){
 let raw;try{raw=await optionalJson(file);}catch(error){return {available:false,fresh:false,running:false,error:safeError(error)};}
 if(!raw)return {available:false,fresh:false,running:false,error:'SUPERVISOR_NOT_OBSERVED'};
 if(!Number.isInteger(raw.pid)||!time(raw.observedAt)||!Array.isArray(raw.states))return {available:false,fresh:false,running:false,error:'SUPERVISOR_STATUS_INVALID'};
 const fresh=freshAt(raw.observedAt,now,45000),owner=state(raw.pid);
 return {available:true,fresh,running:fresh&&owner==='alive',processState:owner,observedAt:raw.observedAt,
  states:raw.states.filter(row=>['demo','demo-futures'].includes(row?.mode)).map(row=>({mode:row.mode,action:string(row.action),reason:string(row.reason),
   engineAvailable:typeof row.engineAvailable==='boolean'?row.engineAvailable:null,watchRunning:typeof row.watchRunning==='boolean'?row.watchRunning:null,
   cycleFresh:typeof row.cycleFresh==='boolean'?row.cycleFresh:null,stopped:typeof row.stopped==='boolean'?row.stopped:null}))};
}
export async function dashboardState(mode,{local=modeLocal(mode),policy:providedPolicy,client:providedClient,
 getTiming=timeMonitor,getDecision=loadDecisionConfig,now=()=>Date.now(),readSession=readDemoSession,session:providedSession,
 portfolioLocal=join(ROOT,'local','portfolio'),supervisorLocal=join(ROOT,'local','supervisor'),localFor=modeLocal}={}) {
 const started=now(),session=isDemo(mode)?(providedSession===undefined?await readSession({now:started}):providedSession):null;
 if(session)validateDemoSession(session,{now:started});
 const policy=providedPolicy??await loadPolicy(mode);
 let account=null,summary=null,trades=null,historyError=null,engineError=null,engineVersion=null;
 let snapshot=null;
 const tradingDisabled=await exists(join(local,'TRADING_DISABLED'));
 const setup={configured:await exists(join(local,'api-auth.json')),credentialsPresent:isDemo(mode)?await exists(join(local,'credentials.dpapi.json')):null};
 try {
  const client=providedClient??new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
  snapshot=await client.snapshot();
  ({account,summary,trades,historyError,engineVersion}=await readEngine(client,{snapshot,session}));
 } catch(e) { engineError=safeError(e); }
 const decisions=[];
 const runs=join(local,'runs');
 if(await exists(runs)) {
  const files=await Promise.all((await readdir(runs)).filter(f=>f.endsWith('.proposal.json')).map(async name=>({name,mtime:(await stat(join(runs,name))).mtimeMs})));
  for(const file of files.sort((a,b)=>b.mtime-a.mtime)) {
   try {
    const p=await readJson(join(runs,file.name));let at=new Date(file.mtime).toISOString();
    if(session){const snapshot=await readJson(join(runs,file.name.replace(/\.proposal\.json$/,'.snapshot.json')));
     if(snapshot.id!==p.snapshotId||snapshot.mode!==mode||!time(snapshot.createdAt)||Date.parse(snapshot.createdAt)<Date.parse(session.startedAt)||Date.parse(snapshot.createdAt)>started)continue;
     at=snapshot.createdAt;
    }
    decisions.push({action:p.action,pair:p.pair,reason:p.reason,at});if(decisions.length===8)break;
   } catch {}
  }
 }
 const observed=now(),snapshotClient={snapshot:async()=>{if(snapshot)return snapshot;throw Error(engineError??'ENGINE_UNAVAILABLE');}};
 const values=await Promise.allSettled([
  healthStatus(local,snapshotClient,policy,{now:observed}),getTiming(local,mode),getDecision(),
  optionalJson(join(local,'equity-summary.json')),optionalJson(join(local,'forward-report.json')),
  isDemo(mode)?readPortfolioView(join(portfolioLocal,'report.json'),{now:observed}):null,
  isDemo(mode)?readSupervisorView(join(supervisorLocal,'status.json'),{now:observed}):null,
  isDemo(mode)?Promise.all(['demo','demo-futures'].map(checkMode=>readProtectionView(join(localFor(checkMode),'protection-readiness.json'),checkMode,{now:observed}))):null,
 ]);
 const value=index=>values[index].status==='fulfilled'?values[index].value:null;
 const operations=value(0)??{mode,healthy:false,engineAvailable:snapshot!==null,entryState:'fault',
  problems:[safeError(values[0].reason)],watchRunning:null,freshCycle:null};
 const timing=value(1),decision=value(2),supervisor=value(6),protection=value(7),sessionArtifactErrors=[];
 const scopedArtifact=(raw,field,artifact)=>{
  if(!session||raw===null)return raw;
  const at=Date.parse(raw?.[field]);
  if(Number.isFinite(at)&&at>=Date.parse(session.startedAt)&&at<=observed)return raw;
  sessionArtifactErrors.push({artifact,code:'ARTIFACT_OUTSIDE_DEMO_SESSION'});return null;
 };
 const equity=scopedArtifact(value(3),'firstObservedAt','equity'),forward=scopedArtifact(value(4),'startedAt','forward'),portfolio=scopedArtifact(value(5),'startedAt','portfolio');
 let diagnostics=null,diagnosticsError=null;
 if(isDemo(mode)&&decision)try{diagnostics=await readEntryDiagnostics(local,{mode,ruleVersion:decision.ruleVersion,
  allowance:operations.dailyEntryAllowance??null,now:observed,since:session?.startedAt??null});}catch(error){diagnosticsError=safeError(error);}
 return {mode,session,observedAt:new Date(observed).toISOString(),account,summary,trades,historyError,setup,engineError,decisions,tradingDisabled,stopped:await exists(join(local,'STOP')),
  operations,diagnostics,diagnosticsError,timing,equity,forward,portfolio,supervisor,protection,
  artifactErrors:[...sessionArtifactErrors,...values.flatMap((result,index)=>result.status==='rejected'?[{artifact:['operations','timing','strategy','equity','forward','portfolio','supervisor','protection'][index],code:safeError(result.reason)}]:[])],
  strategy:{timeframe:policy.timeframe,decisionEngine:isDemo(mode)?decision?.demoEngine??null:'ai',ruleVersion:decision?.ruleVersion??null,engineVersion,rulesReady:engineVersion===RULE_ENGINE_VERSION},
  cycle:{stage:operations.cycle?.stage??'unknown',lastSuccessAt:operations.cycle?.lastSuccessAt??null},
  policy:{pairs:policy.pairs,...(isFutures(mode)?{marginMode:policy.marginMode,maxLeverage:policy.leverage,maxNotionalUsdt:policy.maxNotionalUsdt,maxTotalNotionalUsdt:policy.maxTotalNotionalUsdt}:{}),maxStakeUsdt:policy.maxStakeUsdt,maxExposureUsdt:policy.maxExposureUsdt,maxDailyLossUsdt:policy.maxDailyLossUsdt,maxOpenTrades:policy.maxOpenTrades,maxEntriesPerDay:policy.maxEntriesPerDay}};
}
const assets=new Map([['/','index.html'],['/app.mjs','app.mjs'],['/styles.css','styles.css'],['/starfield.css','starfield.css'],['/store.mjs','store.mjs'],['/timing.mjs','timing.mjs'],['/today.mjs','today.mjs'],['/capital.mjs','capital.mjs'],['/strategy.mjs','strategy.mjs']]);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8'};
export function createDashboardServer({port=18100,state=dashboardState,quote=market,today=readTodayPnl,capital=readCapitalView,strategy=readStrategyReview,readSession=readDemoSession,readTodayScope=readActiveDemoScope}={}) {
 const inflight=new Map(),cache=new Map();
 async function cached(key,fn,ttl) {
  const old=cache.get(key);if(old&&Date.now()-old.at<ttl)return old.value;
  if(inflight.has(key))return inflight.get(key);
  const task=fn().then(value=>{cache.set(key,{value,at:Date.now()});return value;}).finally(()=>inflight.delete(key));inflight.set(key,task);return task;
 }
 return createServer(async(req,res)=>{
  const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const host='127.0.0.1:'+port;
  if(req.headers.host!==host || (req.headers.origin&&req.headers.origin!=='http://'+host) || req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'LOCAL_ORIGIN_REQUIRED'});
  if(req.method!=='GET')return send(405,{error:'READ_ONLY_DASHBOARD'});
  try {
   const url=new URL(req.url,'http://'+host);
   const session=['/api/today-pnl','/api/strategy-review'].includes(url.pathname)||url.pathname==='/api/dashboard'&&isDemo(url.searchParams.get('mode')??'dry-run')?await readSession():null;
   // Keep the execution/dashboard session authoritative while allowing the
   // PnL card to start a fresh, explicitly archived reporting scope. Tests and
   // callers that inject a session reader retain the legacy behavior.
   const activeScope=readSession===readDemoSession&&(
    url.pathname==='/api/today-pnl'||url.pathname==='/api/strategy-review'||url.pathname==='/api/dashboard'&&isDemo(url.searchParams.get('mode')??'dry-run'))
    ?await readTodayScope():null;
   const reportingSession=activeScope?.session??session;
   const epoch=reportingSession?reportingSession.id+':'+reportingSession.startedAt:'legacy';
   if(url.pathname==='/api/today-pnl')return send(200,await cached('today:'+(reportingSession?reportingSession.id+':'+reportingSession.startedAt:epoch),()=>today({session:reportingSession,goal:activeScope?.goal??null}),0));
   if(url.pathname==='/api/strategy-review')return send(200,await cached('strategy:'+epoch,()=>strategy({session:reportingSession}),15000));
   if(url.pathname==='/api/capital-flow')return send(200,await cached('capital',capital,0));
   if(assets.has(url.pathname)){const name=assets.get(url.pathname);return send(200,await readFile(join(ROOT,'ui',name)),types[name.split('.').at(-1)]);}
   const mode=url.searchParams.get('mode')??'dry-run';modeLocal(mode);
   if(url.pathname==='/api/dashboard')return send(200,await cached('state:'+mode+':'+epoch,()=>state(mode,{session:reportingSession}),0));
   if(url.pathname==='/api/market') {
    const pair=url.searchParams.get('pair')??'BTC/USDT';
    if(!(await loadPolicy(mode)).pairs.includes(pair))return send(400,{error:'PAIR_REJECTED'});
    return send(200,await cached('market:'+mode+pair,()=>quote(pair,{mode}),15000));
   }
   return send(404,{error:'NOT_FOUND'});
  }catch(e){return send(503,{error:safeError(e)});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const server=createDashboardServer();let stopCapital=null;
 server.listen(18100,'127.0.0.1',()=>{console.log('Binance trade dashboard: http://127.0.0.1:18100');stopCapital=startCapitalObserver();});
 server.on('close',()=>stopCapital?.());
 server.on('error',e=>{console.error(safeError(e));process.exitCode=1;});
}
