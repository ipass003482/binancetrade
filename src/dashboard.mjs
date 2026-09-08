import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './paths.mjs';
import { loadPolicy } from './config.mjs';
import { modeLocal,isDemo,isFutures } from './mode.mjs';
import { readJson, exists } from './io.mjs';
import { FreqtradeClient } from './freqtrade.mjs';
import { safeError } from './health.mjs';
import { summarizeTrades } from './report.mjs';
import { market } from './research.mjs';

export async function readEngine(client) {
 const snapshot=await client.snapshot();
 const account={total:snapshot.balance.total,positions:snapshot.trades.map(t=>({id:t.trade_id,pair:t.pair,...(t.trading_mode==='futures'?{isShort:t.is_short,leverage:t.leverage,notional:Number(t.amount)*Number(t.current_rate??t.close_rate??t.open_rate)}:{}),stake:t.stake_amount,openRate:t.open_rate,currentRate:t.current_rate,profit:t.profit_abs,profitRatio:t.profit_ratio}))};
 try {
  const history=await client.history();
  return {account,summary:summarizeTrades(history),historyError:null,trades:history.filter(t=>t.is_open===false).sort((a,b)=>(b.close_timestamp??0)-(a.close_timestamp??0)).slice(0,50).map(t=>({id:t.trade_id,pair:t.pair,...(t.trading_mode==='futures'?{isShort:t.is_short,leverage:t.leverage,notional:Number(t.amount)*Number(t.current_rate??t.close_rate??t.open_rate)}:{}),stake:t.stake_amount,openRate:t.open_rate,closeRate:t.close_rate,profit:t.profit_abs,closedAt:t.close_date??null,exitReason:t.exit_reason??null}))};
 } catch(e) {return {account,summary:null,trades:null,historyError:safeError(e)};}
}
export async function dashboardState(mode) {
 const local=modeLocal(mode),policy=await loadPolicy(mode);
 let account=null,summary=null,trades=null,historyError=null,engineError=null;
 const setup={configured:await exists(join(local,'api-auth.json')),credentialsPresent:isDemo(mode)?await exists(join(local,'credentials.dpapi.json')):null};
 try {
  const client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
  ({account,summary,trades,historyError}=await readEngine(client));
 } catch(e) { engineError=safeError(e); }
 const decisions=[];
 const runs=join(local,'runs');
 if(await exists(runs)) {
  const files=await Promise.all((await readdir(runs)).filter(f=>f.endsWith('.proposal.json')).map(async name=>({name,mtime:(await stat(join(runs,name))).mtimeMs})));
  for(const file of files.sort((a,b)=>b.mtime-a.mtime).slice(0,8)) {
   try { const p=await readJson(join(runs,file.name));decisions.push({action:p.action,pair:p.pair,reason:p.reason,at:new Date(file.mtime).toISOString()}); } catch {}
  }
 }
 const health=await exists(join(local,'health.json'))?await readJson(join(local,'health.json')):{};
 return {mode,observedAt:new Date().toISOString(),account,summary,trades,historyError,setup,engineError,decisions,stopped:await exists(join(local,'STOP')),
  cycle:{stage:health.stage??'idle',lastSuccessAt:health.lastSuccessAt??null},
  policy:{pairs:policy.pairs,...(isFutures(mode)?{marginMode:policy.marginMode,maxLeverage:policy.leverage,maxNotionalUsdt:policy.maxNotionalUsdt,maxTotalNotionalUsdt:policy.maxTotalNotionalUsdt}:{}),maxStakeUsdt:policy.maxStakeUsdt,maxExposureUsdt:policy.maxExposureUsdt,maxDailyLossUsdt:policy.maxDailyLossUsdt,maxOpenTrades:policy.maxOpenTrades}};
}
const assets=new Map([['/','index.html'],['/app.mjs','app.mjs'],['/styles.css','styles.css'],['/store.mjs','store.mjs']]);
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',mjs:'text/javascript; charset=utf-8'};
export function createDashboardServer({port=18100,state=dashboardState,quote=market}={}) {
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
   if(assets.has(url.pathname)){const name=assets.get(url.pathname);return send(200,await readFile(join(ROOT,'ui',name)),types[name.split('.').at(-1)]);}
   const mode=url.searchParams.get('mode')??'dry-run';modeLocal(mode);
   if(url.pathname==='/api/dashboard')return send(200,await cached('state:'+mode,()=>state(mode),5000));
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
 const server=createDashboardServer();server.listen(18100,'127.0.0.1',()=>console.log('Binance trade dashboard: http://127.0.0.1:18100'));
 server.on('error',e=>{console.error(safeError(e));process.exitCode=1;});
}
