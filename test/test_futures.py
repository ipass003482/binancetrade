import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import ccxt
import pytest
from freqtrade.enums import RunMode
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('futures_adapter_tests', ROOT / 'scripts/demo-futures-engine.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

def config():
    return {'dry_run': False, 'runmode': RunMode.LIVE, 'trading_mode': 'futures', 'margin_mode': 'isolated',
        'bot_name': 'binance-trade-demo-futures', 'strategy': 'CodexDemoFutures', 'stake_amount': 50,
        'stake_currency': 'USDT', 'max_open_trades': 2, 'stoploss': -0.02, 'force_entry_enable': True,
        'position_adjustment_enable': False, 'api_server': {'listen_ip_address': '127.0.0.1', 'listen_port': 18084},
        'exchange': {'name': 'binance', 'demo_trading': True, 'enable_ws': False, 'pair_whitelist': adapter.PAIRS,
            'ccxt_config': {'options': {'defaultType': 'future', 'fetchMarkets': {'types': ['linear']}, 'fetchCurrencies': False}}}}

@pytest.mark.parametrize('url', [
    'https://fapi.binance.com/fapi/v1/order', 'https://demo-api.binance.com/api/v3/order',
    'https://demo-dapi.binance.com/dapi/v1/order', 'http://demo-fapi.binance.com/fapi/v1/order',
    'https://demo-fapi.binance.com.evil.invalid/fapi/v1/order', 'https://demo-fapi.binance.com:444/fapi/v1/order',
    'https://user:password@demo-fapi.binance.com/fapi/v1/order', 'https://demo-fapi.binance.com/sapi/v1/asset'])
def test_futures_destinations_fail_closed(url):
    with pytest.raises(ccxt.PermissionDenied):
        adapter.check_url(url)

@pytest.mark.parametrize('field,value', [('dry_run', True), ('trading_mode', 'spot'), ('margin_mode', 'cross'),
    ('stake_amount', 51), ('max_open_trades', 3), ('position_adjustment_enable', True)])
def test_futures_config_limits(field, value):
    value_config = config()
    adapter.validate_config(value_config)
    value_config[field] = value
    with pytest.raises(ValueError):
        adapter.validate_config(value_config)

def test_installed_ccxt_routes_sync_async_futures_and_blocks_other_destinations(monkeypatch):
    # Stub only the signed account-mode query. This test does not load local credentials.
    monkeypatch.setattr(adapter.DemoFuturesBinance, 'additional_exchange_init', lambda self: None)
    exchange = adapter.DemoFuturesBinance(config(), validate=False)
    try:
        assert exchange._exchange_ws is None
        for api in (exchange._api, exchange._api_async):
            assert api.options['enableDemoTrading'] is True
            assert api.urls['api']['fapiPublic'].startswith('https://demo-fapi.binance.com/')
        with pytest.raises(ccxt.PermissionDenied):
            exchange._api.fetch('https://fapi.binance.com/fapi/v1/order')
        with pytest.raises(ccxt.PermissionDenied):
            exchange.loop.run_until_complete(exchange._api_async.fetch('https://demo-api.binance.com/api/v3/order'))
        with pytest.raises(ccxt.PermissionDenied):
            exchange._lev_prep(adapter.PAIRS[0], 4, 'sell')
        with pytest.raises(ccxt.PermissionDenied):
            exchange.create_order(pair=adapter.PAIRS[0], side='sell', amount=2, rate=100, leverage=3, ordertype='market')
        with pytest.raises(ccxt.PermissionDenied):
            exchange.create_order(pair=adapter.PAIRS[0], side='buy', amount=1.1, rate=100, leverage=2, ordertype='market')
        seen=[]
        monkeypatch.setattr(adapter.Binance, 'create_order', lambda self, **kwargs: seen.append(kwargs))
        exchange.create_order(pair=adapter.PAIRS[0], side='sell', amount=1.5, rate=100, leverage=3, ordertype='market')
        assert seen[-1]['reduceOnly'] is False
        exchange.create_order(pair=adapter.PAIRS[0], side='buy', amount=1, rate=120, leverage=3, ordertype='market', reduceOnly=True)
        assert seen[-1]['reduceOnly'] is True
    finally:
        exchange.close()

def test_futures_actual_transport_rejects_spot_and_disables_redirects(monkeypatch):
    import requests
    import aiohttp
    seen = []
    monkeypatch.setattr(requests.Session, 'send', lambda self, request, **kwargs: seen.append(kwargs))
    async def fake_async(self, method, url, **kwargs):
        seen.append(kwargs)
    monkeypatch.setattr(aiohttp.ClientSession, '_request', fake_async)
    adapter.protect_transports()
    session = requests.Session()
    session.send(requests.Request('GET', 'https://demo-fapi.binance.com/fapi/v1/time').prepare())
    assert seen[-1]['allow_redirects'] is False
    with pytest.raises(ccxt.PermissionDenied):
        session.send(requests.Request('POST', 'https://fapi.binance.com/fapi/v1/order').prepare())
    asyncio.run(aiohttp.ClientSession._request(None, 'GET', 'https://demo-fapi.binance.com/fapi/v1/time'))
    assert seen[-1]['allow_redirects'] is False

def test_futures_strategy_accepts_both_sides_and_has_no_autonomous_entries():
    sys.path.insert(0, str(ROOT / 'freqtrade/strategies'))
    from CodexDemoFutures import CodexDemoFutures
    import pandas as pd
    strategy = CodexDemoFutures(config())
    strategy.dp = SimpleNamespace(_exchange=SimpleNamespace(demo_futures_destination_guard=True))
    strategy.bot_start()
    args = dict(pair=adapter.PAIRS[0], order_type='market', amount=1.5, rate=100,
        time_in_force='GTC', current_time=None, entry_tag='codex-synthetic')
    for side in ['long', 'short']:
        assert strategy.confirm_trade_entry(**args, side=side)
        assert not strategy.confirm_trade_entry(**(args | {'amount': 2}), side=side)
    frame = strategy.populate_entry_trend(pd.DataFrame({'close': [100]}), {})
    assert frame['enter_long'].sum() == frame['enter_short'].sum() == 0
    assert strategy.leverage(adapter.PAIRS[0], None, 100, 10, 20, 'tag', 'short') == 3
    strategy.config['margin_mode'] = 'cross'
    assert not strategy.confirm_trade_entry(**args, side='short')
