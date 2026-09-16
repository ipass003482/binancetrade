import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import ccxt
import pytest
from freqtrade.enums import RunMode
from demo_model_guard_support import isolate, add_guard, NOW, TAG
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("demo_adapter_test", ROOT / "scripts/demo-engine.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

@pytest.fixture(autouse=True)
def isolate_native_runtime_artifacts(tmp_path, monkeypatch):
    import demo_protection
    monkeypatch.setattr(demo_protection, 'ROOT', tmp_path)
    isolate(monkeypatch, tmp_path)

@pytest.mark.parametrize("url", [
    "https://api.binance.com/api/v3/order", "https://testnet.binance.vision/api/v3/order",
    "https://demo-api.binance.com.evil.invalid/api/v3/order", "http://demo-api.binance.com/api/v3/order",
    "https://demo-api.binance.com:444/api/v3/order", "https://demo-api.binance.com/sapi/v1/asset",
    "https://user:password@demo-api.binance.com/api/v3/order", "https://demo-fapi.binance.com/fapi/v1/order",
])
def test_demo_rejects_wrong_wire_destination(url):
    with pytest.raises(ccxt.PermissionDenied):
        adapter.check_url(url)

def test_demo_accepts_official_spot_url():
    adapter.check_url("https://demo-api.binance.com/api/v3/order?symbol=BTCUSDT")

def demo_config():
    return {"dry_run": False, "runmode": RunMode.LIVE, "trading_mode": "spot", "margin_mode": "",
        "exchange": {"name": "binance", "demo_trading": True, "enable_ws": False,
            "ccxt_config": {"options": {"defaultType": "spot", "fetchMarkets": {"types": ["spot"]}, "fetchCurrencies": False}}}}

def test_installed_sync_async_ccxt_both_route_demo_and_reject_live():
    exchange = adapter.DemoBinance(demo_config(), validate=False)
    try:
        assert exchange.demo_destination_guard
        assert not exchange._ft_has["has_delisting"]
        assert exchange._exchange_ws is None
        for api in (exchange._api, exchange._api_async):
            assert api.options["enableDemoTrading"] is True
            assert api.urls["api"]["private"].startswith("https://demo-api.binance.com/")
        with pytest.raises(ccxt.PermissionDenied):
            exchange._api.fetch("https://api.binance.com/api/v3/order")
        with pytest.raises(ccxt.PermissionDenied):
            exchange.loop.run_until_complete(exchange._api_async.fetch("https://api.binance.com/api/v3/order"))
    finally:
        exchange.close()

def test_actual_transport_does_not_follow_redirects(monkeypatch):
    import requests
    import aiohttp
    seen = []
    monkeypatch.setattr(requests.Session, "send", lambda self, request, **kwargs: seen.append(kwargs))
    async def fake_async(self, method, url, **kwargs):
        seen.append(kwargs)
    monkeypatch.setattr(aiohttp.ClientSession, "_request", fake_async)
    adapter.protect_transports()
    session = requests.Session()
    session.send(requests.Request("GET", "https://demo-api.binance.com/api/v3/time").prepare())
    assert seen[-1]["allow_redirects"] is False
    with pytest.raises(ccxt.PermissionDenied):
        session.send(requests.Request("POST", "https://api.binance.com/api/v3/order").prepare())
    asyncio.run(aiohttp.ClientSession._request(None, "GET", "https://demo-api.binance.com/api/v3/time"))
    assert seen[-1]["allow_redirects"] is False
    with pytest.raises(ccxt.PermissionDenied):
        asyncio.run(aiohttp.ClientSession._request(None, "POST", "https://api.binance.com/api/v3/order"))

def test_demo_strategy_requires_guarded_adapter_and_enforces_amount():
    sys.path.insert(0, str(ROOT / "freqtrade/strategies"))
    from CodexDemoSpot import CodexDemoSpot
    config = {"dry_run": False, "trading_mode": "spot", "bot_name": "binance-trade-demo",
        "stake_amount": 25, "exchange": {"name": "binance", "demo_trading": True, "pair_whitelist": ["BTC/USDT"]}}
    strategy = CodexDemoSpot(config)
    strategy.dp = SimpleNamespace(_exchange=SimpleNamespace(demo_destination_guard=False))
    with pytest.raises(ValueError):
        strategy.bot_start()
    strategy.dp._exchange.demo_destination_guard = True
    strategy.bot_start()
    from datetime import datetime, timezone
    now = NOW
    tag = TAG
    strategy._entry_plan = lambda *args: add_guard({'ruleVersion': 'kronos-direction-v12', 'profitProtection': {'version': 'net-profit-trail-v1', 'triggerNetUsdt': .5, 'givebackNetUsdt': .25, 'riskMultiple': .5}, 'atrTimeframe': '15m',
        'timeframe': '5m', 'maxHoldingBars': 48, 'maxHoldingSeconds': 14400,
        'pair': 'BTC/USDT', 'isShort': False, 'tag': tag, 'targetFraction': .02,
        'stopFraction': .01, 'riskCostFraction': .003, 'riskBudgetUsdt': 1,
        'maxEntryNotionalUsdt': 25, 'createdAt': now.isoformat()}, rate=100000)
    args = dict(pair="BTC/USDT", order_type="market", amount=0.0002, rate=100000, time_in_force="GTC",
        current_time=now, entry_tag=tag, side="long")
    assert strategy.confirm_trade_entry(**args)
    assert not strategy.confirm_trade_entry(**(args | {"amount": 1}))
    strategy.config["exchange"]["demo_trading"] = False
    with pytest.raises(ValueError):
        strategy.bot_start()

@pytest.mark.parametrize("field,value", [("dry_run", True), ("trading_mode", "futures"), ("bot_name", "other")])
def test_demo_launcher_rejects_incorrect_config(field, value):
    config = {"dry_run": False, "trading_mode": "spot", "bot_name": "binance-trade-demo",
        "strategy": "CodexDemoSpot", "exchange": {"name": "binance", "demo_trading": True}}
    config[field] = value
    with pytest.raises(ValueError):
        adapter.validate_config(config)


@pytest.mark.parametrize('reserve', [None, True, '0.05', 0, .04, .06, float('nan')])
def test_spot_adapter_rejects_unpinned_minimum_stake_reserve(reserve):
    value = {'dry_run': False, 'trading_mode': 'spot', 'bot_name': 'binance-trade-demo',
             'strategy': 'CodexDemoSpot', 'exchange': {'name': 'binance', 'demo_trading': True},
             'amount_reserve_percent': reserve}
    with pytest.raises(ValueError, match='DEMO_AMOUNT_RESERVE_REJECTED'):
        adapter.validate_config(value)


@pytest.mark.parametrize('configured', [False, True])
def test_spot_adapter_pins_reserve_before_native_initialization(monkeypatch, configured):
    seen = []
    def fake_init(self, value, **kwargs):
        self.close = lambda: None
        seen.append(value['amount_reserve_percent'])
    monkeypatch.setattr(adapter.Binance, '__init__', fake_init)
    monkeypatch.setattr(adapter.exchanges, 'Binance', adapter.exchanges.Binance)
    value = {'dry_run': False, 'trading_mode': 'spot', 'bot_name': 'binance-trade-demo',
             'strategy': 'CodexDemoSpot',
             'exchange': {'name': 'binance', 'demo_trading': True, 'pair_whitelist': ['ETH/USDT']}}
    if configured:
        value['amount_reserve_percent'] = .05
    cls = adapter.install_adapter({'key': 'unit-test-key', 'secret': 'unit-test-secret'})
    cls(value)
    assert seen == [.05]
