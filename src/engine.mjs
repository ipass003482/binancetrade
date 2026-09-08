import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, LOCAL } from './paths.mjs';
import { modeLocal,isDemo,isFutures } from './mode.mjs';
import { loadPolicy } from './config.mjs';
import { readJson,lock,writeJson } from './io.mjs';
import { safeEnv } from './codex.mjs';
export const PYTHON=join(ROOT,'.venv','Scripts','python.exe');
export async function engineArguments(mode='dry-run') {
 const p=await loadPolicy(mode),local=modeLocal(mode),config=await readJson(join(local,'freqtrade/config.json'));
 const demo=isDemo(mode),futures=isFutures(mode);
 if(config.dry_run!==!demo||config.trading_mode!==(futures?'futures':'spot')||(futures&&config.margin_mode!=='isolated')||config.exchange?.name!=='binance'
  ||config.exchange?.key||config.exchange?.secret||config.bot_name!==p.freqtrade.botName
  ||(demo && (config.exchange.demo_trading!==true||config.strategy!==p.freqtrade.strategy))
  ||(!demo && config.exchange.demo_trading===true)
  ||config.max_open_trades!==p.maxOpenTrades||String(config.stake_amount)!==p.maxStakeUsdt
  ||!(config.stoploss<0&&config.stoploss>=-0.02)||config.position_adjustment_enable!==false
  ||JSON.stringify(config.exchange.pair_whitelist)!==JSON.stringify(p.pairs)
  ||config.api_server?.listen_ip_address!=='127.0.0.1'
  ||config.api_server?.listen_port!==Number(new URL(p.freqtrade.url).port))
   throw new Error('ENGINE_CONFIG_REJECTED: review mode, identity and policy');
 if(demo)return [join(ROOT,futures?'scripts/demo-futures-engine.py':'scripts/demo-engine.py')];
 return ['-m','freqtrade','trade','--config',join(LOCAL,'freqtrade/config.json'),
  '--userdir',join(LOCAL,'freqtrade'),'--strategy-path',join(ROOT,'freqtrade/strategies'),
  '--strategy','CodexResearchSpot','--db-url','sqlite:///'+join(LOCAL,'freqtrade/trades.dryrun.sqlite').replaceAll('\\','/'),
  '--logfile',join(LOCAL,'freqtrade/engine.log')];
}
export async function startEngine(mode='dry-run') {
 const args=await engineArguments(mode),file=join(modeLocal(mode),'engine.lock');
 return lock(file,async owner=>{
  const child=spawn(PYTHON,args,{cwd:ROOT,env:safeEnv(),shell:false,windowsHide:true,stdio:'inherit'});
  const ended=new Promise((resolve,reject)=>{
   child.once('error',()=>reject(new Error('ENGINE_START_FAILED')));
   child.once('close',code=>code?reject(new Error('ENGINE_EXIT_'+code)):resolve());
  });
  // Attach error handler before asynchronous persistence.
  ended.catch(()=>{});
  const stop=()=>child.kill();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
   await owner.update({pid:process.pid,childPid:child.pid,at:new Date().toISOString(),mode});
   return await ended;
  } finally {
   stop();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
 });
}
