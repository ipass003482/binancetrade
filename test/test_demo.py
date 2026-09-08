import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import ccxt
import pytest
from freqtrade.enums import RunMode
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("demo_adapter_test", ROOT / "scripts/demo-engine.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

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
    args = dict(pair="BTC/USDT", order_type="market", amount=0.0002, rate=100000, time_in_force="GTC",
        current_time=None, entry_tag="codex-test", side="long")
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
