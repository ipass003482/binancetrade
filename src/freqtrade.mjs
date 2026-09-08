import { jsonFetch } from './http.mjs';
export class FreqtradeClient {
 constructor(policy,auth,{fetchImpl=fetch}={}) {this.policy=policy;this.auth=auth;this.fetchImpl=fetchImpl;}
 async request(path,body) {
  return jsonFetch(new URL('/api/v1/'+path,this.policy.freqtrade.url),{
   method:body===undefined?'GET':'POST',body,fetchImpl:this.fetchImpl,
   headers:{Authorization:'Basic '+Buffer.from(this.auth.username+':'+this.auth.password).toString('base64')}
  });
 }
 async assertMode() {
  const c=await this.request('show_config'),demo=this.policy.mode==='demo';
  const modeOk=demo
   ? c.dry_run===false && c.runmode==='live' && c.demo_trading===true
   : this.policy.mode==='dry-run' && c.dry_run===true && c.runmode==='dry_run' && c.demo_trading!==true;
  if(!modeOk || c.trading_mode!=='spot' || c.exchange!=='binance'
     || c.bot_name!==this.policy.freqtrade.botName || c.strategy!==this.policy.freqtrade.strategy
     || c.state!=='running' || c.stake_currency!=='USDT' || c.short_allowed!==false
     || c.force_entry_enable!==true || c.position_adjustment_enable!==false
     || !(c.stoploss<0 && c.stoploss>=-0.02) || c.max_open_trades!==this.policy.maxOpenTrades)
   throw new Error('ENGINE_IDENTITY_REJECTED: require matching dedicated '+this.policy.mode+' engine');
  return c;
 }
 async assertDry() {
  if(this.policy.mode!=='dry-run')throw new Error('DRY_RUN_REQUIRED');
  return this.assertMode();
 }
 async snapshot() {
  const engine=await this.assertMode();
  const [trades,balance,daily]=await Promise.all([this.request('status'),this.request('balance'),this.request('daily?timescale=1')]);
  return {engine,trades,balance,daily};
 }
 async history() {
  await this.assertMode();
  const trades=[];let offset=0,total=null;
  for(let page=0;page<1000;page++){
   const r=await this.request('trades?limit=100&offset='+offset);
   if(!Array.isArray(r.trades)||!Number.isInteger(r.total_trades)||r.total_trades<0)throw new Error('INVALID_HISTORY');
   if(total!==null && r.total_trades!==total)throw new Error('HISTORY_CHANGED: retry read');
   total=r.total_trades;trades.push(...r.trades);offset+=r.trades.length;
   if(offset>=total){
    if(trades.length!==total||new Set(trades.map(t=>t.trade_id)).size!==trades.length)throw new Error('INCONSISTENT_HISTORY');
    // /trades contains CLOSED trades only. Include current positions explicitly,
    // then check the closed count again so an intervening close cannot vanish.
    const open=await this.request('status'),check=await this.request('trades?limit=1&offset=0');
    if(!Array.isArray(open)||check.total_trades!==total)throw new Error('HISTORY_CHANGED: retry read');
    const all=[...trades,...open];
    if(new Set(all.map(t=>t.trade_id)).size!==all.length)throw new Error('INCONSISTENT_HISTORY');
    return all;
   }
   if(!r.trades.length)throw new Error('INCOMPLETE_HISTORY');
  }
  throw new Error('HISTORY_LIMIT_EXCEEDED');
 }
 async submit(proposal,tag,tradeId,{validUntil=Infinity}={}) {
  await this.assertMode();
  if(Date.now()>validUntil)throw new Error('ORDER_DEADLINE_EXPIRED');
  if(proposal.action==='buy') return this.request('forceenter',{pair:proposal.pair,side:'long',
    ordertype:'market',stakeamount:Number(proposal.stakeUsdt),entry_tag:tag});
  if(proposal.action==='sell') return this.request('forceexit',{tradeid:tradeId,ordertype:'market'});
  throw new Error('No execution for HOLD');
 }
}
