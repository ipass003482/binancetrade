import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import Decimal from 'decimal.js';
import {minimumSafeStake, checkDemoOrderSize} from '../src/demo-order-size.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function market(cost = '5', min = '.001', step = '.001') {
 return {filters: [
  {filterType: 'LOT_SIZE', minQty: min, maxQty: '10000', stepSize: step},
  {filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '1000', stepSize: '0'},
  {filterType: 'MIN_NOTIONAL', minNotional: cost}
 ]};
}

test('native minimum is reserved and ceiling-rounded, without raising requested stake', () => {
 const options = {market: market('100'), price: '100', stakeUsdt: '105.26315789'};
 assert.equal(minimumSafeStake(options), '107.14285715');
 const result = checkDemoOrderSize(options);
 assert.equal(result.eligible, false);
 assert.deepEqual(result.reasons, ['DEMO_SIZE_BELOW_FREQTRADE_MINIMUM']);
 assert.equal(options.stakeUsdt, '105.26315789');
 assert.equal(checkDemoOrderSize({...options, stakeUsdt: result.minimumStakeUsdt}).eligible, true);
});

test('LOT_SIZE minimum and leverage use native Freqtrade semantics', () => {
 assert.equal(minimumSafeStake({market: market('5', '.05'), price: 1000}), '52.50000000');
 assert.equal(minimumSafeStake({market: market('100'), price: 100, leverage: 3}), '35.71428572');
 assert.equal(minimumSafeStake({market: market('100'), price: 100, stoploss: -.9}), '150.00000000');
 assert.equal(minimumSafeStake({market: market('100'), price: 100, stoploss: -1}), '150.00000000');
});

test('market order quantity is rounded by LOT_SIZE then checked against MARKET_LOT_SIZE', () => {
 const value = market('5', '.001', '.001');
 value.filters[1] = {filterType: 'MARKET_LOT_SIZE', minQty: '.01', maxQty: '1', stepSize: '.01'};
 const result = checkDemoOrderSize({market: value, price: '100', stakeUsdt: '25.5'});
 assert.equal(result.quantity, '0.255');
 assert.equal(result.eligible, false);
 assert.deepEqual(result.reasons, ['DEMO_SIZE_MARKET_LOT_LIMIT']);
 assert.equal(checkDemoOrderSize({market: value, price: '100', stakeUsdt: '25'}).eligible, true);
 assert.equal(checkDemoOrderSize({market: value, price: '100', stakeUsdt: '101'}).eligible, false);
});

test('futures notional key and spot NOTIONAL filter are supported, including max limits', () => {
 const value = market();
 value.filters[2] = {filterType: 'MIN_NOTIONAL', notional: '5'};
 assert.equal(checkDemoOrderSize({market: value, price: '100', stakeUsdt: '25', leverage: 1}).eligible, true);
 value.filters[2] = {filterType: 'NOTIONAL', minNotional: '5', maxNotional: '20', applyMinToMarket: true, applyMaxToMarket: true};
 assert.deepEqual(checkDemoOrderSize({market: value, price: '100', stakeUsdt: '25'}).reasons, ['DEMO_SIZE_NOTIONAL_LIMIT']);
 value.filters[2].applyMaxToMarket = false;
 assert.equal(checkDemoOrderSize({market: value, price: '100', stakeUsdt: '25'}).eligible, true);
});

test('incomplete or invalid metadata and nonfinite inputs fail closed', () => {
 const base = {market: market(), price: '100', stakeUsdt: '25'};
 for (const options of [{...base, market: {}}, {...base, price: NaN}, {...base, price: Infinity},
  {...base, price: 0}, {...base, price: true}, {...base, leverage: 0}, {...base, leverage: null},
  {...base, reservePercent: -.1}, {...base, reservePercent: Infinity}, {...base, stoploss: NaN},
  {...base, stoploss: .02}, {...base, stoploss: -2}, {...base, market: {...market(), contractSize: 10}}]) {
  assert.throws(() => minimumSafeStake(options), /DEMO_ORDER_SIZE/);
  assert.equal(checkDemoOrderSize(options).eligible, false);
 }
 for (const mutate of [m => {delete m.filters[0].stepSize;}, m => {m.filters[0].minQty = 'NaN';},
  m => {m.filters[0].maxQty = null;}, m => {m.filters.pop();}, m => {m.filters.push({...m.filters[0]});}]) {
  const value = market(); mutate(value);
  assert.throws(() => minimumSafeStake({...base, market: value}), /DEMO_ORDER_SIZE/);
 }
 const missingMarketLot = market(); missingMarketLot.filters.splice(1, 1);
 assert.equal(checkDemoOrderSize({...base, market: missingMarketLot}).eligible, false);
 assert.equal(checkDemoOrderSize({...base, stakeUsdt: Infinity}).eligible, false);
 assert.equal(checkDemoOrderSize({...base, stakeUsdt: '-1'}).eligible, false);
});

test('minimum matches installed Freqtrade on offline synthetic markets', () => {
 const cases = [
  {cost: 100, min: .001, price: 100, stoploss: -.02, reserve: .05, leverage: 1},
  {cost: 5, min: .05, price: 1000, stoploss: -.02, reserve: .05, leverage: 1},
  {cost: 100, min: .001, price: 100, stoploss: -.02, reserve: .05, leverage: 3},
  {cost: 100, min: .001, price: 100, stoploss: -.9, reserve: .05, leverage: 1},
  {cost: 100, min: .001, price: 100, stoploss: -1, reserve: .05, leverage: 1},
  {cost: 100, min: .001, price: 100, stoploss: 0, reserve: 0, leverage: 1}
 ];
 const code = `import json, sys\nfrom types import SimpleNamespace\nfrom freqtrade.exchange import Exchange\nrows=json.load(sys.stdin)\nresult=[]\nfor r in rows:\n fake=SimpleNamespace(markets={'TEST/USDT':{'limits':{'cost':{'min':r['cost']},'amount':{'min':r['min']}}}},_config={'amount_reserve_percent':r['reserve']},_contracts_to_amount=lambda pair,x:x,_get_stake_amount_considering_leverage=lambda x,lev:x/lev)\n result.append(Exchange._get_stake_amount_limit(fake,'TEST/USDT',r['price'],r['stoploss'],'min',r['leverage']))\nprint(json.dumps(result))\n`;
 const python = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
 const result = spawnSync(python, ['-B', '-c', code], {cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8',
  windowsHide: true, shell: false, timeout: 20000, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
 assert.ifError(result.error);
 assert.equal(result.status, 0, result.stderr);
 const expected = JSON.parse(result.stdout);
 cases.forEach((row, i) => {
  const actual = minimumSafeStake({market: market(String(row.cost), String(row.min)), price: row.price,
   stoploss: row.stoploss, reservePercent: row.reserve, leverage: row.leverage});
  assert.ok(new Decimal(actual).minus(expected[i]).gte(0), `${actual} is below native ${expected[i]}`);
  assert.ok(new Decimal(actual).minus(expected[i]).lt('0.00000001'));
 });
});
