import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import ccxt
import pytest
from freqtrade.enums import RunMode
from demo_model_guard_support import isolate, add_guard, NOW, TAG
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('futures_adapter_tests', ROOT / 'scripts/demo-futures-engine.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

@pytest.fixture(autouse=True)
def isolate_native_runtime_artifacts(tmp_path, monkeypatch):
    import demo_protection
    monkeypatch.setattr(demo_protection, 'ROOT', tmp_path)
    isolate(monkeypatch, tmp_path)

def config():
    return {'dry_run': False, 'runmode': RunMode.LIVE, 'trading_mode': 'futures', 'margin_mode': 'isolated',
        'bot_name': 'binance-trade-demo-futures', 'strategy': 'CodexDemoFutures', 'stake_amount': 150,
        'stake_currency': 'USDT', 'max_open_trades': 1, 'stoploss': -0.02, 'force_entry_enable': True,
        'position_adjustment_enable': False, 'api_server': {'listen_ip_address': '127.0.0.1', 'listen_port': 18084},
        'exchange': {'name': 'binance', 'demo_trading': True, 'enable_ws': False, 'pair_whitelist': adapter.PAIRS,
            'ccxt_config': {'options': {'defaultType': 'future', 'fetchMarkets': {'types': ['linear']}, 'fetchCurrencies': False}}}}

def test_server_time_is_loaded_before_signed_account_init(monkeypatch):
    calls = []
    monkeypatch.setattr(adapter.Binance, 'additional_exchange_init', lambda self: calls.append('account'))
    fake = object.__new__(adapter.DemoFuturesBinance)
    fake.close = lambda: None
    fake._api = SimpleNamespace(load_time_difference=lambda: calls.append('time'))
    adapter.DemoFuturesBinance.additional_exchange_init(fake)
    assert calls == ['time', 'account']

@pytest.mark.parametrize('url', [
    'https://fapi.binance.com/fapi/v1/order', 'https://demo-api.binance.com/api/v3/order',
    'https://demo-dapi.binance.com/dapi/v1/order', 'http://demo-fapi.binance.com/fapi/v1/order',
    'https://demo-fapi.binance.com.evil.invalid/fapi/v1/order', 'https://demo-fapi.binance.com:444/fapi/v1/order',
    'https://user:password@demo-fapi.binance.com/fapi/v1/order', 'https://demo-fapi.binance.com/sapi/v1/asset'])
def test_futures_destinations_fail_closed(url):
    with pytest.raises(ccxt.PermissionDenied):
        adapter.check_url(url)

@pytest.mark.parametrize('field,value', [('dry_run', True), ('trading_mode', 'spot'), ('margin_mode', 'cross'),
    ('stake_amount', 151), ('max_open_trades', 2), ('position_adjustment_enable', True)])
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
            exchange.create_order(pair=adapter.PAIRS[0], side='sell', amount=1.51, rate=100, leverage=1, ordertype='market')
        with pytest.raises(ccxt.PermissionDenied):
            exchange.create_order(pair=adapter.PAIRS[0], side='buy', amount=1.5, rate=100, leverage=2, ordertype='market')
        seen=[]
        monkeypatch.setattr(adapter.Binance, 'create_order', lambda self, **kwargs: seen.append(kwargs))
        with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
            exchange.create_order(pair=adapter.PAIRS[0], side='sell', amount=1.5, rate=100, leverage=1, ordertype='market')
        monkeypatch.setattr(exchange, 'amount_to_precision', lambda pair, amount: amount)
        monkeypatch.setattr(exchange, '_amount_to_contracts', lambda pair, amount: amount)
        exchange.create_order(pair=adapter.PAIRS[0], side='buy', amount=1, rate=120, leverage=2, ordertype='market', reduceOnly=True, initial_order=False)
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
    from datetime import datetime, timezone
    now = NOW
    tag = TAG
    strategy._entry_plan = lambda pair, short, entry_tag: add_guard({'ruleVersion': 'kronos-direction-v12', 'profitProtection': {'version': 'net-profit-trail-v1', 'triggerNetUsdt': .5, 'givebackNetUsdt': .25, 'riskMultiple': .5}, 'atrTimeframe': '15m',
        'timeframe': '5m', 'maxHoldingBars': 48, 'maxHoldingSeconds': 14400,
        'pair': pair, 'isShort': short, 'tag': entry_tag, 'targetFraction': .02,
        'stopFraction': .002, 'riskCostFraction': .001, 'riskBudgetUsdt': 1,
        'maxEntryNotionalUsdt': 150, 'createdAt': now.isoformat()})
    args = dict(pair=adapter.PAIRS[0], order_type='market', amount=1.5, rate=100,
        time_in_force='GTC', current_time=now, entry_tag=tag)
    for side in ['long', 'short']:
        assert strategy.confirm_trade_entry(**args, side=side)
        assert not strategy.confirm_trade_entry(**(args | {'amount': 1.51}), side=side)
    frame = strategy.populate_entry_trend(pd.DataFrame({'close': [100]}), {})
    assert frame['enter_long'].sum() == frame['enter_short'].sum() == 0
    assert strategy.leverage(adapter.PAIRS[0], None, 100, 10, 20, 'tag', 'short') == 1
    strategy.config['margin_mode'] = 'cross'
    assert not strategy.confirm_trade_entry(**args, side='short')


@pytest.mark.parametrize('reserve', [None, True, '0.05', 0, .04, .06, float('nan')])
def test_futures_adapter_rejects_unpinned_minimum_stake_reserve(reserve):
    value = config() | {'amount_reserve_percent': reserve}
    with pytest.raises(ValueError, match='FUTURES_DEMO_AMOUNT_RESERVE_REJECTED'):
        adapter.validate_config(value)


@pytest.mark.parametrize('configured', [False, True])
def test_futures_adapter_pins_reserve_before_native_initialization(monkeypatch, configured):
    seen = []
    def fake_init(self, value, **kwargs):
        self.close = lambda: None
        seen.append(value['amount_reserve_percent'])
    monkeypatch.setattr(adapter.Binance, '__init__', fake_init)
    monkeypatch.setattr(adapter.exchanges, 'Binance', adapter.exchanges.Binance)
    value = config()
    if configured:
        value['amount_reserve_percent'] = .05
    cls = adapter.install_adapter({'key': 'unit-test-key', 'secret': 'unit-test-secret'})
    cls(value)
    assert seen == [.05]
