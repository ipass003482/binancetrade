"""Read-only Demo account facts. Secrets stay inside the guarded adapter process."""
import importlib.util
import json
import logging
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def number(value):
    if isinstance(value, bool) or value is None:
        raise ValueError('INVALID_NUMBER')
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError('INVALID_NUMBER')
    return result


def commission(value, futures=False):
    if futures:
        buy = sell = number(value['takerCommissionRate'])
        method = 'symbol_taker_rate'
    else:
        # Conservative undiscounted estimate: no assumed BNB balance or discounts.
        parts = [value[name] for name in ('standardCommission', 'taxCommission', 'specialCommission')]
        buy = sum((number(p['taker']) + number(p['buyer']) for p in parts), Decimal(0))
        sell = sum((number(p['taker']) + number(p['seller']) for p in parts), Decimal(0))
        method = 'standard_plus_tax_plus_special_no_bnb_discount'
    if min(buy, sell) < 0 or max(buy, sell) > Decimal('0.1'):
        raise ValueError('COMMISSION_RANGE')
    return {'buyRate': str(buy), 'sellRate': str(sell), 'method': method}


def spot_equity(account, books):
    prices = {b['symbol']: b for b in books}
    assets, missing, total = [], [], Decimal(0)
    for item in account['balances']:
        amount = number(item['free']) + number(item['locked'])
        if amount < 0:
            raise ValueError('BALANCE_INVALID')
        if not amount:
            continue
        asset = item['asset']
        value = amount if asset == 'USDT' else None
        if asset != 'USDT':
            book = prices.get(asset + 'USDT')
            if book and number(book['bidPrice']) > 0 and number(book['askPrice']) >= number(book['bidPrice']):
                value = amount * number(book['bidPrice'])
        if value is None:
            missing.append(asset)
        else:
            total += value
        assets.append({'asset': asset, 'amount': str(amount), 'valueUsdt': str(value) if value is not None else None})
    return {'equityUsdt': str(total) if not missing else None, 'assets': assets,
            'missingAssets': missing, 'method': 'free_plus_locked_at_bid_before_liquidation_fees'}


def read_facts(mode, kind):
    if mode not in ('demo', 'demo-futures') or kind not in ('costs', 'equity'):
        raise ValueError('ARGUMENTS_REJECTED')
    futures = mode == 'demo-futures'
    path = ROOT / 'scripts' / ('demo-futures-engine.py' if futures else 'demo-engine.py')
    spec = importlib.util.spec_from_file_location('facts_adapter', path)
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    logging.disable(logging.CRITICAL)
    credentials = adapter.read_credentials()
    adapter.protect_transports()
    from freqtrade.enums import RunMode
    config = {'dry_run': False, 'runmode': RunMode.LIVE, 'trading_mode': 'futures' if futures else 'spot',
              'margin_mode': 'isolated' if futures else '',
              'exchange': {'name': 'binance', 'demo_trading': True, 'enable_ws': False, **credentials,
                           'ccxt_config': {'enableRateLimit': True, 'timeout': 10000, 'options': {
                               'defaultType': 'future' if futures else 'spot', 'adjustForTimeDifference': True,
                               'fetchMarkets': {'types': ['linear' if futures else 'spot']}, 'fetchCurrencies': False}}}}
    cls = adapter.DemoFuturesBinance if futures else adapter.DemoBinance
    exchange = cls(config, validate=False)
    api = exchange._api
    original = api.fetch
    allowed = ({'/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/commissionRate', '/fapi/v2/account'}
               if futures else {'/api/v3/time', '/api/v3/exchangeInfo', '/api/v3/account',
                                '/api/v3/account/commission', '/api/v3/ticker/bookTicker'})
    def read_only(url, method='GET', *args, **kwargs):
        if method != 'GET' or urlsplit(url).path not in allowed:
            raise ValueError('FACTS_READ_ONLY_REQUIRED')
        return original(url, method, *args, **kwargs)
    api.fetch = read_only
    endpoint = 'https://demo-fapi.binance.com' if futures else 'https://demo-api.binance.com'
    result = {'schemaVersion': 1, 'mode': mode, 'kind': kind, 'source': endpoint, 'readOnly': True}
    try:
        api.load_time_difference()
        if kind == 'costs':
            policy = json.loads((ROOT / 'config/policy.json').read_text(encoding='utf-8-sig'))
            pairs = [p + ':USDT' for p in policy['pairs']] if futures else policy['demoSpot']['pairs']
            rows = []
            for pair in pairs:
                symbol = pair.split(':')[0].replace('/', '')
                try:
                    raw = api.request('commissionRate' if futures else 'account/commission',
                                      'fapiPrivate' if futures else 'private', 'GET', {'symbol': symbol})
                    if raw.get('symbol') != symbol:
                        raise ValueError('SYMBOL_MISMATCH')
                    rows.append({'pair': pair, 'status': 'ok', **commission(raw, futures)})
                except Exception:
                    rows.append({'pair': pair, 'status': 'unavailable', 'reason': 'COMMISSION_UNAVAILABLE'})
            result['rates'] = rows
        elif futures:
            raw = api.fapiPrivateV2GetAccount()
            if raw.get('canTrade') is not True or raw.get('multiAssetsMargin') is not False:
                raise ValueError('ACCOUNT_IDENTITY_REJECTED')
            wallet, unrealized = number(raw['totalWalletBalance']), number(raw['totalUnrealizedProfit'])
            equity = wallet + unrealized
            if abs(equity - number(raw['totalMarginBalance'])) > Decimal('0.000001'):
                raise ValueError('EQUITY_MISMATCH')
            result['valuation'] = {'equityUsdt': str(equity), 'walletUsdt': str(wallet),
                                   'unrealizedUsdt': str(unrealized), 'missingAssets': [],
                                   'method': 'single_asset_usdt_wallet_plus_mark_unrealized'}
        else:
            raw = api.private_get_account()
            if raw.get('accountType') != 'SPOT' or raw.get('canTrade') is not True:
                raise ValueError('ACCOUNT_IDENTITY_REJECTED')
            result['valuation'] = spot_equity(raw, api.public_get_ticker_bookticker())
        result['observedAt'] = datetime.now(timezone.utc).isoformat()
        return result
    finally:
        exchange.close()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('ARGUMENTS_REJECTED')
        print(json.dumps(read_facts(*sys.argv[1:])))
    except Exception:
        print(json.dumps({'status': 'failed', 'code': 'DEMO_FACTS_UNAVAILABLE'}))
        sys.exit(1)
