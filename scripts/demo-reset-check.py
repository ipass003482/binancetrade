"""Read-only full-account Demo reset evidence. Never deletes or submits orders.

CLI: python scripts/demo-reset-check.py demo|demo-futures
An empty native SQLite database is NOT evidence of an empty exchange account.
Schema reference (all-symbol request omits symbol):
https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Algo-Open-Orders
"""
import importlib.util
import json
import logging
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
HOSTS = {'demo': 'demo-api.binance.com', 'demo-futures': 'demo-fapi.binance.com'}
PATHS = {
    'demo': frozenset(('/api/v3/time', '/api/v3/exchangeInfo', '/api/v3/account', '/api/v3/openOrders')),
    'demo-futures': frozenset(('/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v2/account',
        '/fapi/v3/positionRisk', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders',
        '/fapi/v1/positionSide/dual', '/fapi/v1/multiAssetsMargin')),
}
VALIDATION_REASONS = frozenset(('INVALID_NUMBER', 'INVALID_SYMBOL', 'INVALID_RESPONSE_SHAPE',
    'INVALID_POSITION_IDENTITY', 'INVALID_ORDER_IDENTITY', 'INVALID_ORDER_FIELDS',
    'INVALID_ORDER_QUANTITY', 'ACCOUNT_IDENTITY_REJECTED', 'DUPLICATE_BALANCE', 'INVALID_BALANCE'))


def checked_number(value):
    if type(value) not in (str, int, float) or len(str(value)) > 128:
        raise ValueError('INVALID_NUMBER')
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', str(value)):
        raise ValueError('INVALID_NUMBER')
    number = Decimal(str(value))
    if not number.is_finite() or (number and not -40 <= number.adjusted() <= 40):
        raise ValueError('INVALID_NUMBER')
    return number


def symbol(value):
    # Full Binance account inventory can contain CJK token names (observed
    # "币安人生" / "牛来"). Preserve opaque identifiers rather than silently
    # skipping assets outside the bot's ASCII trading-pair whitelist.
    if (not isinstance(value, str) or not 1 <= len(value) <= 80
            or not any(char.isalnum() for char in value)
            or any(not (char.isalnum() or char in '_.-') for char in value)):
        raise ValueError('INVALID_SYMBOL')
    return value


def rows(value):
    if not isinstance(value, list) or len(value) > 20000 or any(not isinstance(r, dict) for r in value):
        raise ValueError('INVALID_RESPONSE_SHAPE')
    return value


def read_only_url(mode, url, method):
    if mode not in HOSTS:
        raise ValueError('DEMO_RESET_MODE_REJECTED')
    parsed = urlsplit(str(url))
    if (method != 'GET' or parsed.scheme != 'https' or parsed.hostname != HOSTS[mode]
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.fragment or parsed.path not in PATHS[mode]):
        raise ValueError('DEMO_RESET_READ_ONLY_REQUIRED')


def install_read_only_transports(adapter, mode):
    # Retain the original Demo destination/no-redirect guard, then narrow it to
    # exact read endpoints before any exchange constructor can make a request.
    adapter.protect_transports()
    import requests
    import aiohttp
    previous_send, previous_request = requests.Session.send, aiohttp.ClientSession._request

    def send(self, request, **kwargs):
        read_only_url(mode, request.url, request.method)
        kwargs['allow_redirects'] = False
        return previous_send(self, request, **kwargs)

    async def request(self, method, url, **kwargs):
        read_only_url(mode, url, method)
        kwargs['allow_redirects'] = False
        return await previous_request(self, method, url, **kwargs)

    requests.Session.send, aiohttp.ClientSession._request = send, request


def parse_positions(value):
    result, seen = [], set()
    for row in rows(value):
        name, side = symbol(row.get('symbol')), row.get('positionSide')
        if side not in ('BOTH', 'LONG', 'SHORT') or (name, side) in seen:
            raise ValueError('INVALID_POSITION_IDENTITY')
        seen.add((name, side))
        amount = checked_number(row.get('positionAmt'))
        for field in ('entryPrice', 'breakEvenPrice', 'markPrice', 'unRealizedProfit',
                      'unrealizedProfit', 'notional', 'isolatedWallet', 'isolatedMargin'):
            if field in row:
                checked_number(row[field])
        if amount:
            result.append({'symbol': name, 'positionSide': side, 'positionAmt': str(amount)})
    return {'checkedRows': len(value), 'nonzeroPositions': result}


def parse_orders(value, algo=False):
    result, seen = [], set()
    id_key, status_key, type_key, qty_key = ('algoId', 'algoStatus', 'orderType', 'quantity') if algo else ('orderId', 'status', 'type', 'origQty')
    for row in rows(value):
        name, order_id = symbol(row.get('symbol')), row.get(id_key)
        if type(order_id) not in (str, int) or not re.fullmatch(r'[1-9]\d{0,30}', str(order_id)) or (name, str(order_id)) in seen:
            raise ValueError('INVALID_ORDER_IDENTITY')
        seen.add((name, str(order_id)))
        side, status, order_type = row.get('side'), row.get(status_key), row.get(type_key)
        if side not in ('BUY', 'SELL') or not isinstance(status, str) or not re.fullmatch(r'[A-Z_]{1,40}', status) or not isinstance(order_type, str) or not re.fullmatch(r'[A-Z_]{1,40}', order_type):
            raise ValueError('INVALID_ORDER_FIELDS')
        quantity = checked_number(row.get(qty_key))
        if quantity < 0:
            raise ValueError('INVALID_ORDER_QUANTITY')
        for field in ('price', 'stopPrice', 'triggerPrice', 'executedQty', 'actualQty', 'actualPrice'):
            if field in row:
                checked_number(row[field])
        result.append({'symbol': name, id_key: str(order_id), 'side': side, status_key: status,
                       type_key: order_type, qty_key: str(quantity)})
    # Every row returned by openOrders remains a blocker, even if its status
    # looks terminal. We never filter rows to manufacture an empty result.
    return result


def parse_account(raw, futures):
    if not isinstance(raw, dict) or raw.get('canTrade') is not True:
        raise ValueError('ACCOUNT_IDENTITY_REJECTED')
    if futures:
        if raw.get('multiAssetsMargin') is not False:
            raise ValueError('ACCOUNT_IDENTITY_REJECTED')
        reported_type = raw.get('accountType')
        if reported_type is not None:
            reported_type = symbol(reported_type)
        result = {'canTrade': True, 'multiAssetsMargin': False, 'reportedAccountType': reported_type,
                  'accountPositions': parse_positions(raw.get('positions'))}
        for key in ('totalWalletBalance', 'totalUnrealizedProfit', 'totalMarginBalance'):
            if key in raw:
                result[key] = str(checked_number(raw[key]))
        return result
    if raw.get('accountType') != 'SPOT':
        raise ValueError('ACCOUNT_IDENTITY_REJECTED')
    balances, seen = [], set()
    for row in rows(raw.get('balances')):
        asset = symbol(row.get('asset'))
        if asset in seen:
            raise ValueError('DUPLICATE_BALANCE')
        seen.add(asset)
        free, locked = checked_number(row.get('free')), checked_number(row.get('locked'))
        if min(free, locked) < 0:
            raise ValueError('INVALID_BALANCE')
        if free or locked:
            balances.append({'asset': asset, 'free': str(free), 'locked': str(locked), 'total': str(free + locked)})
    return {'accountType': 'SPOT', 'canTrade': True, 'checkedBalanceCount': len(raw['balances']), 'balances': balances}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def check_api(mode, api, clock=now_iso):
    if mode not in HOSTS:
        raise ValueError('DEMO_RESET_MODE_REJECTED')
    futures = mode == 'demo-futures'
    result = {'schemaVersion': 1, 'mode': mode, 'source': 'https://' + HOSTS[mode],
              'readOnly': True, 'startedAt': clock(), 'scope': 'all_symbols_no_pair_filter',
              'atomicSnapshot': False, 'flat': None, 'complete': False, 'checks': {}}
    work = ([('account', 'fapiPrivateV2GetAccount', lambda raw: parse_account(raw, True)),
             ('positions', 'fapiPrivateV3GetPositionRisk', parse_positions),
             ('openOrders', 'fapiPrivateGetOpenOrders', parse_orders),
             ('algoOpenOrders', 'fapiPrivateGetOpenAlgoOrders', lambda raw: parse_orders(raw, True))]
            if futures else [('account', 'private_get_account', lambda raw: parse_account(raw, False)),
                             ('openOrders', 'private_get_openorders', parse_orders)])
    for name, method, parse in work:
        phase = 'request'
        try:
            raw = getattr(api, method)({})
            phase = 'validation'
            result[name] = parse(raw)
            result['checks'][name] = {'status': 'ok', 'observedAt': clock()}
        except Exception as error:
            result[name] = None
            reason = str(error) if phase == 'validation' and type(error) is ValueError and str(error) in VALIDATION_REASONS else name.upper() + '_READ_OR_SHAPE_FAILED'
            result['checks'][name] = {'status': 'unavailable', 'phase': phase, 'reason': reason, 'observedAt': clock()}
    result['complete'] = all(c['status'] == 'ok' for c in result['checks'].values())
    if futures and result['complete']:
        key = lambda p: (p['symbol'], p['positionSide'], str(checked_number(p['positionAmt']).normalize()))
        a = {key(p) for p in result['account']['accountPositions']['nonzeroPositions']}
        b = {key(p) for p in result['positions']['nonzeroPositions']}
        if a != b:
            result['complete'] = False
            result['checks']['crossCheck'] = {'status': 'unavailable', 'reason': 'ACCOUNT_POSITION_MISMATCH'}
    if result['complete']:
        result['noOpenOrders'] = not result['openOrders'] and (not futures or not result['algoOpenOrders'])
        if futures:
            result['flat'] = result['noOpenOrders'] and not result['positions']['nonzeroPositions']
        else:
            balances = result['account']['balances']
            result['residualAssets'] = [b for b in balances if b['asset'] != 'USDT']
            result['lockedAssets'] = [b for b in balances if checked_number(b['locked']) != 0]
            result['flat'] = result['noOpenOrders'] and not result['residualAssets'] and not result['lockedAssets']
    else:
        result['noOpenOrders'] = None
    result['completedAt'] = clock()
    result['status'] = 'complete' if result['complete'] else 'incomplete'
    result['note'] = ('Exchange observations only. Repeat after native shutdown; no atomic snapshot or reset authorization. '
                      'Spot residual assets include legacy inventory/dust; this check does not classify them as bot trades or sell them.')
    return result


def load_adapter(mode):
    name = 'demo-futures-engine.py' if mode == 'demo-futures' else 'demo-engine.py'
    spec = importlib.util.spec_from_file_location('reset_check_adapter', ROOT / 'scripts' / name)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    return adapter


def read_check(mode):
    if mode not in HOSTS:
        raise ValueError('DEMO_RESET_MODE_REJECTED')
    logging.disable(logging.CRITICAL)
    adapter = load_adapter(mode)
    install_read_only_transports(adapter, mode)
    credentials = adapter.read_credentials()
    from freqtrade.enums import RunMode
    futures = mode == 'demo-futures'
    config = {'dry_run': False, 'runmode': RunMode.LIVE, 'trading_mode': 'futures' if futures else 'spot',
        'margin_mode': 'isolated' if futures else '', 'exchange': {'name': 'binance', 'demo_trading': True,
        'enable_ws': False, **credentials, 'ccxt_config': {'enableRateLimit': True, 'timeout': 10000,
        'options': {'defaultType': 'future' if futures else 'spot', 'adjustForTimeDifference': True,
                    'fetchMarkets': {'types': ['linear' if futures else 'spot']}, 'fetchCurrencies': False}}}}
    cls = adapter.DemoFuturesBinance if futures else adapter.DemoBinance
    exchange = cls(config, validate=False)
    try:
        if exchange._api.options.get('enableDemoTrading') is not True:
            raise ValueError('DEMO_ROUTING_REQUIRED')
        exchange._api.load_time_difference()
        return check_api(mode, exchange._api)
    finally:
        exchange.close()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('DEMO_RESET_ARGUMENTS')
        report = read_check(sys.argv[1])
        print(json.dumps(report, allow_nan=False))
        sys.exit(0 if report['complete'] else 1)
    except Exception:
        print(json.dumps({'schemaVersion': 1, 'status': 'incomplete', 'readOnly': True,
                          'complete': False, 'flat': None, 'reason': 'DEMO_RESET_CHECK_UNAVAILABLE'}))
        sys.exit(1)
