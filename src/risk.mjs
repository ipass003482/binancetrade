import Decimal from 'decimal.js';
import { proposalSchema } from './config.mjs';
import { isFutures,isEntry,isExit } from './mode.mjs';
function dec(v,label) {
 if(typeof v!=='number' && typeof v!=='string') throw new Error('Invalid '+label);
 let d; try {d=new Decimal(v);} catch {throw new Error('Invalid '+label);}
 if(!d.isFinite()) throw new Error('Invalid '+label); return d;
}
export function assess({proposal,snapshot,account,policy,records,stopped,executionQuote,now=Date.now()}) {
 const p=proposalSchema(policy).parse(proposal),futures=isFutures(policy.mode);
 if(futures&&(!Number.isInteger(policy.leverage)||policy.leverage<1||policy.leverage>3||policy.marginMode!=='isolated'||p.leverage>policy.leverage))throw new Error('LEVERAGE_MODE_REJECTED');
 if(snapshot.mode!==policy.mode) throw new Error('SNAPSHOT_MODE_MISMATCH');
 if(p.snapshotId!==snapshot.id) throw new Error('SNAPSHOT_MISMATCH');
 const age=now-Date.parse(snapshot.createdAt);
 if(!Number.isFinite(age)||age<0||age>policy.maxSignalAgeSeconds*1000) throw new Error('STALE_SNAPSHOT');
 if(p.evidenceIds.some(id=>!snapshot.evidence.some(e=>e.id===id && e.status==='ok'))) throw new Error('INVALID_EVIDENCE');
 if(p.action==='hold') {
  if(p.stakeUsdt!=='0') throw new Error('HOLD_STAKE_MUST_BE_ZERO');
  return {action:'hold'};
 }
 if(!policy.pairs.includes(p.pair)) throw new Error('PAIR_NOT_ALLOWED');
 if(!p.evidenceIds.includes((futures?'futures:':'spot:')+p.pair)) throw new Error(futures?'FUTURES_EVIDENCE_REQUIRED':'SPOT_EVIDENCE_REQUIRED');
 if(!Array.isArray(account.trades)) throw new Error('INVALID_ACCOUNT_STATE');
 const trades=account.trades;
 for(const t of trades) {
  if(!Number.isInteger(t.trade_id)||typeof t.pair!=='string'||typeof t.has_open_orders!=='boolean'||(futures?typeof t.is_short!=='boolean':t.is_short!==false)||t.is_open!==true) throw new Error('INVALID_TRADE_STATE');
  if(futures&&(!Number.isFinite(t.leverage)||t.leverage<1||t.trading_mode!=='futures'))throw new Error('INVALID_FUTURES_POSITION');
  if(dec(t.stake_amount,'stake').lt(0)) throw new Error('INVALID_TRADE_STAKE');
 }
 if(isExit(p.action)) {
  if(p.stakeUsdt!=='0') throw new Error(futures?'CLOSE_STAKE_MUST_BE_ZERO':'SELL_STAKE_MUST_BE_ZERO');
  const own=trades.filter(t=>t.pair===p.pair);
  if(own.length!==1||own[0].has_open_orders) throw new Error('NO_UNAMBIGUOUS_POSITION_TO_CLOSE');
  if(futures&&own[0].is_short!==(p.action==='close-short'))throw new Error('CLOSE_DIRECTION_MISMATCH');
  return {action:p.action,tradeId:own[0].trade_id};
 }
 if(futures&&trades.some(t=>t.leverage>3))throw new Error('EXISTING_LEVERAGE_LIMIT');
 if(stopped) throw new Error('ENTRY_STOPPED');
 const quote=snapshot.markets.find(m=>m.pair===p.pair);
 if(futures&&(quote?.source!=='https://demo-fapi.binance.com'||executionQuote?.source!=='https://demo-fapi.binance.com'||quote?.mode!==policy.mode||executionQuote?.mode!==policy.mode))throw new Error('FUTURES_DEMO_QUOTE_REQUIRED');
 if(policy.mode==='demo'&&(quote?.source!=='https://demo-api.binance.com'||executionQuote?.source!=='https://demo-api.binance.com'
   ||quote?.mode!=='demo'||executionQuote?.mode!=='demo'))throw new Error('DEMO_QUOTE_REQUIRED');
 if(!(futures?quote?.verifiedFutures:quote?.verifiedSpot) || !Number.isFinite(quote.spreadBps)||quote.spreadBps<0||quote.spreadBps>policy.maxSpreadBps) throw new Error('QUOTE_REJECTED');
 const quoteAge=now-Date.parse(quote.fetchedAt);
 if(!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>policy.maxSignalAgeSeconds*1000) throw new Error('STALE_QUOTE');
 if(!executionQuote || executionQuote.pair!==p.pair || (futures?executionQuote.verifiedFutures!==true:executionQuote.verifiedSpot!==true)
    || !Number.isFinite(executionQuote.spreadBps) || executionQuote.spreadBps<0 || executionQuote.spreadBps>policy.maxSpreadBps)
   throw new Error('EXECUTION_QUOTE_REJECTED');
 const executionAge=now-Date.parse(executionQuote.fetchedAt);
 if(!Number.isFinite(executionAge)||executionAge<0||executionAge>15000) throw new Error('STALE_EXECUTION_QUOTE');
 const oldAsk=dec(p.action==='open-short'?quote.bid:quote.ask,'snapshot price'),newAsk=dec(p.action==='open-short'?executionQuote.bid:executionQuote.ask,'execution price');
 if(oldAsk.lte(0)||newAsk.lte(0)||newAsk.minus(oldAsk).abs().div(oldAsk).mul(10000).gt(policy.maxPriceMoveBps))
   throw new Error('PRICE_MOVED');
 const stake=dec(p.stakeUsdt,'proposal stake');
 if(stake.lte(0)||stake.gt(policy.maxStakeUsdt)) throw new Error('STAKE_LIMIT');
 if(futures){
  const notional=stake.mul(p.leverage);
  const total=trades.reduce((sum,t)=>{const cost=dec(t.stake_amount,'margin').mul(t.leverage),amount=dec(t.amount,'amount'),rate=dec(t.current_rate,'current rate');if(amount.lte(0)||rate.lte(0))throw new Error('INVALID_POSITION_NOTIONAL');return sum.plus(Decimal.max(cost,amount.mul(rate)));},new Decimal(0));
  if(notional.gt(policy.maxNotionalUsdt)||total.plus(notional).gt(policy.maxTotalNotionalUsdt))throw new Error('NOTIONAL_LIMIT');
  const filters=executionQuote.filters;
  if(!Array.isArray(filters))throw new Error('FUTURES_FILTERS_REQUIRED');
  const lots=filters.filter(f=>['LOT_SIZE','MARKET_LOT_SIZE'].includes(f.filterType)),minimum=filters.find(f=>f.filterType==='MIN_NOTIONAL');
  if(lots.length!==2||!minimum)throw new Error('FUTURES_FILTERS_REQUIRED');
  const step=Decimal.max(...lots.map(l=>dec(l.stepSize,'step')));
  if(step.lte(0))throw new Error('INVALID_QUANTITY_STEP');
  const amount=notional.div(newAsk).div(step).floor().mul(step);
  if(amount.lte(0)||amount.mul(newAsk).lt(dec(minimum.notional,'minimum notional'))||lots.some(l=>amount.lt(dec(l.minQty,'min qty'))||amount.gt(dec(l.maxQty,'max qty'))||!amount.mod(dec(l.stepSize,'step')).eq(0)))throw new Error('FUTURES_MINIMUM_OR_QUANTITY_LIMIT');
 }
 if(trades.some(t=>t.pair===p.pair)) throw new Error('POSITION_ALREADY_EXISTS');
 if(trades.length>=policy.maxOpenTrades) throw new Error('POSITION_LIMIT');
 const exposure=trades.reduce((sum,t)=>sum.plus(dec(t.stake_amount,'stake')),new Decimal(0));
 if(exposure.plus(stake).gt(policy.maxExposureUsdt)) throw new Error('EXPOSURE_LIMIT');
 if(account.balance?.stake!=='USDT') throw new Error('INVALID_BALANCE_CURRENCY');
 const usdt=account.balance.currencies?.find(c=>c.currency==='USDT');
 if(!usdt || dec(usdt.free,'free balance').lt(stake.mul('1.01'))) throw new Error('INSUFFICIENT_BALANCE');
 const today=new Date(now).toISOString().slice(0,10);
 const daily=account.daily?.data?.find(d=>d.date===today);
 if(account.daily?.stake_currency!=='USDT'||!daily) throw new Error('DAILY_STATE_UNAVAILABLE');
 const pnl=trades.reduce((sum,t)=>sum.plus(dec(t.total_profit_abs,'unrealized pnl')),dec(daily.abs_profit,'daily pnl'));
 if(pnl.lte(new Decimal(policy.maxDailyLossUsdt).negated())) throw new Error('DAILY_LOSS_LIMIT');
 const entries=records.filter(r=>r.status==='pending'&&isEntry(r.action)&&r.at.startsWith(today));
 if(entries.length>=policy.maxEntriesPerDay) throw new Error('ENTRY_RATE_LIMIT');
 return {action:p.action,stakeUsdt:stake.toFixed(),...(futures?{leverage:p.leverage}:{})};
}
