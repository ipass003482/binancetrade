import Decimal from 'decimal.js';

// Binance spot / linear USDT markets expose quantities in base units. This
// mirrors Freqtrade's native minimum stake, without increasing the caller's
// stake or assuming that a market order will fill at the supplied price.
const D = Decimal.clone({precision: 40});
function number(value, label, {positive = false} = {}) {
 if (!['string', 'number'].includes(typeof value)) throw Error('DEMO_ORDER_SIZE_INVALID_' + label);
 let n;
 try { n = new D(value); } catch { throw Error('DEMO_ORDER_SIZE_INVALID_' + label); }
 if (!n.isFinite() || (positive ? n.lte(0) : n.lt(0))) throw Error('DEMO_ORDER_SIZE_INVALID_' + label);
 return n;
}
function one(filters, type, required = true) {
 const found = filters.filter(f => f?.filterType === type);
 if (found.length > 1 || (required && found.length !== 1)) throw Error('DEMO_ORDER_SIZE_INVALID_' + type);
 return found[0];
}
function lot(filter, label, market = false) {
 if (!filter) throw Error('DEMO_ORDER_SIZE_INVALID_' + label);
 const min = number(filter.minQty, label + '_MIN'), max = number(filter.maxQty, label + '_MAX', {positive: !market});
 const step = number(filter.stepSize, label + '_STEP', {positive: !market});
 if (max.gt(0) && max.lt(min)) throw Error('DEMO_ORDER_SIZE_INVALID_' + label + '_RANGE');
 return {min, max, step};
}
function inputs({market, price, stoploss = -.02, reservePercent = .05, leverage = 1}) {
 if (!Array.isArray(market?.filters)) throw Error('DEMO_ORDER_SIZE_FILTERS_REQUIRED');
 if (market.contractSize !== undefined && !number(market.contractSize, 'CONTRACT_SIZE', {positive: true}).eq(1))
  throw Error('DEMO_ORDER_SIZE_UNSUPPORTED_CONTRACT_SIZE');
 const filters = market.filters, limits = lot(one(filters, 'LOT_SIZE'), 'LOT_SIZE');
 const notionals = [one(filters, 'MIN_NOTIONAL', false), one(filters, 'NOTIONAL', false)].filter(Boolean).map(f => {
  for (const name of ['applyToMarket', 'applyMinToMarket', 'applyMaxToMarket'])
   if (f[name] !== undefined && typeof f[name] !== 'boolean') throw Error('DEMO_ORDER_SIZE_INVALID_NOTIONAL_FLAG');
  const min = number(f.minNotional ?? f.notional, 'MIN_NOTIONAL');
  const max = f.maxNotional === undefined ? null : number(f.maxNotional, 'MAX_NOTIONAL');
  if (max?.gt(0) && max.lt(min)) throw Error('DEMO_ORDER_SIZE_INVALID_NOTIONAL_RANGE');
  return {filter: f, min, max};
 });
 if (!notionals.length) throw Error('DEMO_ORDER_SIZE_NOTIONAL_REQUIRED');
 const rate = number(price, 'PRICE', {positive: true}), lev = number(leverage, 'LEVERAGE', {positive: true});
 if (lev.lt(1)) throw Error('DEMO_ORDER_SIZE_INVALID_LEVERAGE');
 const reserve = number(reservePercent, 'RESERVE_PERCENT');
 let stop;
 try { stop = new D(stoploss); } catch { throw Error('DEMO_ORDER_SIZE_INVALID_STOPLOSS'); }
 if (!['string', 'number'].includes(typeof stoploss) || !stop.isFinite() || stop.gt(0) || stop.lt(-1)) throw Error('DEMO_ORDER_SIZE_INVALID_STOPLOSS');
 const marginReserve = reserve.plus(1);
 const stopReserve = stop.abs().eq(1) ? new D(1.5) : D.max(1, D.min(1.5, marginReserve.div(new D(1).minus(stop.abs()))));
 // CCXT Binance gives MIN_NOTIONAL precedence over NOTIONAL, and uses
 // LOT_SIZE for limits.amount. MARKET_LOT_SIZE is a separate limits.market.
 const minimum = D.max(notionals[0].min.mul(stopReserve), limits.min.mul(rate).mul(marginReserve)).div(lev);
 return {filters, limits, notionals, rate, lev, minimum};
}

export function minimumSafeStake(options) {
 // Round up at the project's stake precision so native validation cannot
 // raise a rounded-down stake above its pre-authorized risk amount.
 return inputs(options).minimum.toFixed(8, D.ROUND_UP);
}

export function checkDemoOrderSize(options) {
 try {
  const data = inputs(options), {limits, notionals, rate, lev} = data;
  const marketLimits = lot(one(data.filters, 'MARKET_LOT_SIZE'), 'MARKET_LOT_SIZE', true);
  const stake = number(options.stakeUsdt, 'STAKE', {positive: true});
  const minimumStakeUsdt = data.minimum.toFixed(8, D.ROUND_UP), reasons = [];
  if (stake.lt(minimumStakeUsdt)) reasons.push('DEMO_SIZE_BELOW_FREQTRADE_MINIMUM');
  // Freqtrade / CCXT rounds by LOT_SIZE precision, not the larger of the
  // LOT_SIZE and MARKET_LOT_SIZE steps. Check the resulting order against both.
  const quantity = stake.mul(lev).div(rate).div(limits.step).floor().mul(limits.step);
  const notional = quantity.mul(rate);
  if (quantity.lte(0) || quantity.lt(limits.min) || quantity.gt(limits.max)) reasons.push('DEMO_SIZE_LOT_LIMIT');
  if (quantity.lt(marketLimits.min) || (marketLimits.max.gt(0) && quantity.gt(marketLimits.max))
   || (marketLimits.step.gt(0) && !quantity.mod(marketLimits.step).eq(0))) reasons.push('DEMO_SIZE_MARKET_LOT_LIMIT');
  for (const {filter, min, max} of notionals) {
   const minApplies = filter.applyToMarket !== false && filter.applyMinToMarket !== false;
   if ((minApplies && notional.lt(min)) || (filter.applyMaxToMarket !== false && max?.gt(0) && notional.gt(max)))
    reasons.push('DEMO_SIZE_NOTIONAL_LIMIT');
  }
  return {eligible: reasons.length === 0, reasons: [...new Set(reasons)], minimumStakeUsdt,
   quantity: quantity.toFixed(), notionalUsdt: notional.toFixed()};
 } catch (error) {
  return {eligible: false, reasons: [error.message], minimumStakeUsdt: null, quantity: null, notionalUsdt: null};
 }
}
