"""Dedicated USDT perpetual Demo runner. No real-money or spot destinations."""
import inspect
import json
import logging
import math
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit
import ccxt
import freqtrade.exchange as exchanges
from freqtrade.exchange.binance import Binance

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'local/demo-futures'
PAIRS = [name + '/USDT:USDT' for name in ('BTC', 'ETH', 'SOL', 'BNB')]

def check_url(url):
    value = urlsplit(str(url))
    if (value.scheme != 'https' or value.hostname != 'demo-fapi.binance.com'
        or value.port not in (None, 443) or value.username or value.password
        or not value.path.startswith('/fapi/')):
        raise ccxt.PermissionDenied('FUTURES_DEMO_DESTINATION_REJECTED')

def protect_transports():
    import requests
    import aiohttp
    old_send = requests.Session.send
    def send(self, request, **kwargs):
        check_url(request.url)
        kwargs['allow_redirects'] = False
        return old_send(self, request, **kwargs)
    requests.Session.send = send
    old_request = aiohttp.ClientSession._request
    async def request(self, method, url, **kwargs):
        check_url(url)
        kwargs['allow_redirects'] = False
        return await old_request(self, method, url, **kwargs)
    aiohttp.ClientSession._request = request

def validate_config(config):
    exchange = config.get('exchange', {})
    api = config.get('api_server', {})
    if (config.get('dry_run') is not False or config.get('trading_mode') != 'futures'
        or config.get('margin_mode') != 'isolated' or config.get('bot_name') != 'binance-trade-demo-futures'
        or config.get('strategy') != 'CodexDemoFutures' or exchange.get('name') != 'binance'
        or exchange.get('demo_trading') is not True or exchange.get('pair_whitelist') != PAIRS
        or config.get('stake_amount') != 50 or config.get('max_open_trades') != 2
        or not -0.02 <= config.get('stoploss', 0) < 0 or config.get('position_adjustment_enable') is not False
        or config.get('force_entry_enable') is not True or config.get('stake_currency') != 'USDT'
        or api.get('listen_ip_address') != '127.0.0.1' or api.get('listen_port') != 18084):
        raise ValueError('FUTURES_DEMO_CONFIG_REJECTED')
    if exchange.get('key') or exchange.get('secret'):
        raise ValueError('PLAINTEXT_CREDENTIALS_REJECTED')

class DemoFuturesBinance(Binance):
    demo_futures_destination_guard = True
    _ft_has = {**Binance._ft_has, 'supports_demo_trading': True, 'has_delisting': False, 'ws_enabled': False}

    def _init_ccxt(self, exchange_config, sync, ccxt_kwargs):
        if exchange_config.get('demo_trading') is not True:
            raise ValueError('FUTURES_DEMO_REQUIRED')
        api = super()._init_ccxt(exchange_config, sync, ccxt_kwargs)
        if api.options.get('enableDemoTrading') is not True:
            raise ValueError('FUTURES_DEMO_ROUTING_REQUIRED')
        original = api.fetch
        if inspect.iscoroutinefunction(original):
            async def fetch(url, *args, **kwargs):
                check_url(url)
                try:
                    return await original(url, *args, **kwargs)
                except ccxt.BaseError as error:
                    raise type(error)('Demo futures request failed: ' + type(error).__name__) from None
        else:
            def fetch(url, *args, **kwargs):
                check_url(url)
                try:
                    return original(url, *args, **kwargs)
                except ccxt.BaseError as error:
                    raise type(error)('Demo futures request failed: ' + type(error).__name__) from None
        api.fetch = fetch
        return api

    def _lev_prep(self, pair, leverage, side, accept_fail=False):
        if not isinstance(leverage, (int, float)) or not math.isfinite(leverage) or not 1 <= leverage <= 3:
            raise ccxt.PermissionDenied('FUTURES_LEVERAGE_LIMIT')
        if self.margin_mode != 'isolated':
            raise ccxt.PermissionDenied('FUTURES_ISOLATED_REQUIRED')
        return super()._lev_prep(pair, leverage, side, accept_fail)

    def create_order(self, *, pair, ordertype, side, amount, rate, leverage=1.0, reduceOnly=False, **kwargs):
        if pair not in PAIRS or side not in ('buy', 'sell'):
            raise ccxt.PermissionDenied('FUTURES_ORDER_IDENTITY_REJECTED')
        if not reduceOnly:
            if (not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (amount, rate, leverage))
                or leverage > 3 or leverage < 1 or amount * rate > 150 + 1e-8
                or amount * rate / leverage > 50 + 1e-8):
                raise ccxt.PermissionDenied('FUTURES_ENTRY_LIMIT')
        return super().create_order(pair=pair, ordertype=ordertype, side=side, amount=amount,
            rate=rate, leverage=leverage, reduceOnly=reduceOnly, **kwargs)

def read_credentials():
    result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(ROOT / 'scripts/read-demo-secret.ps1'),
        '-CredentialFile', str(DIRECTORY / 'credentials.dpapi.json')], capture_output=True, text=True,
        timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise ValueError('FUTURES_DEMO_CREDENTIALS_UNAVAILABLE')
    try:
        value = json.loads(result.stdout)
        if any(not isinstance(value.get(k), str) or len(value[k]) < 16 for k in ('key', 'secret')):
            raise ValueError()
        return {k: value[k] for k in ('key', 'secret')}
    except Exception:
        raise ValueError('FUTURES_DEMO_CREDENTIALS_INVALID') from None

def install_adapter(credentials):
    class AuthenticatedDemoFutures(DemoFuturesBinance):
        def __init__(self, config, **kwargs):
            validate_config(config)
            config['exchange'] = {'name': 'binance', **credentials, 'demo_trading': True, 'enable_ws': False,
                'pair_whitelist': PAIRS, 'pair_blacklist': [], 'ccxt_config': {'enableRateLimit': True,
                'options': {'defaultType': 'future', 'fetchMarkets': {'types': ['linear']},
                            'fetchCurrencies': False, 'adjustForTimeDifference': True}}}
            kwargs['exchange_config'] = None
            super().__init__(config, **kwargs)
    exchanges.Binance = AuthenticatedDemoFutures
    return AuthenticatedDemoFutures

def main():
    if sys.argv[1:] not in ([], ['--check']):
        raise ValueError('FUTURES_DEMO_ARGUMENTS_REJECTED')
    config_path = DIRECTORY / 'freqtrade/config.json'
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    validate_config(config)
    credentials = read_credentials()
    old_factory = logging.getLogRecordFactory()
    def factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        message = record.getMessage()
        for secret in credentials.values():
            message = message.replace(secret, '[REDACTED]')
        import re
        record.msg = re.sub(r'signature=[a-zA-Z0-9]+', 'signature=[REDACTED]', message)
        record.args = ()
        return record
    logging.setLogRecordFactory(factory)
    protect_transports()
    adapter = install_adapter(credentials)
    if sys.argv[1:] == ['--check']:
        from freqtrade.enums import RunMode
        config['runmode'] = RunMode.LIVE
        exchange = adapter(config, validate=False)
        try:
            exchange.additional_exchange_init()
            exchange._api.load_markets()
            positions = exchange._api.fetch_positions(PAIRS)
            orders = [order for pair in PAIRS for order in exchange._api.fetch_open_orders(pair)]
            balance = exchange._api.fetch_balance()
            print(json.dumps({'mode': 'demo-futures', 'status': 'connected', 'marginMode': 'isolated',
                'maxLeverage': 3, 'openPositions': sum(float(p.get('contracts') or 0) != 0 for p in positions),
                'openOrders': len(orders), 'freeUsdt': balance.get('USDT', {}).get('free')}))
        finally:
            exchange.close()
        return
    from freqtrade.main import main as freqtrade_main
    directory = DIRECTORY / 'freqtrade'
    freqtrade_main(['trade', '--config', str(config_path), '--userdir', str(directory),
        '--strategy-path', str(ROOT / 'freqtrade/strategies'), '--strategy', 'CodexDemoFutures',
        '--db-url', 'sqlite:///' + (directory / 'trades.demo-futures.sqlite').as_posix(),
        '--logfile', str(directory / 'engine.log')])

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'failed', 'code': 'FUTURES_DEMO_OPERATION_FAILED'}))
        sys.exit(1)
