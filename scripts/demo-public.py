"""Public Demo smoke: actual Freqtrade + sync/async CCXT, no keys."""
import importlib.util
import json
from pathlib import Path
from freqtrade.enums import RunMode
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("demo_adapter", ROOT / "scripts/demo-engine.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
adapter.protect_transports()
config = {"dry_run": False, "runmode": RunMode.LIVE, "trading_mode": "spot", "margin_mode": "",
    "exchange": {"name": "binance", "demo_trading": True, "enable_ws": False,
        "ccxt_config": {"options": {"defaultType": "spot", "fetchMarkets": {"types": ["spot"]}, "fetchCurrencies": False}}}}
exchange = adapter.DemoBinance(config, validate=False)
try:
    markets = exchange._api.load_markets()
    assert markets["BTC/USDT"]["spot"] is True
    book = exchange._api.fetch_order_book("BTC/USDT", limit=5)
    assert book["bids"] and book["asks"]
    async def asynchronous():
        await exchange._api_async.load_markets()
        bars = await exchange._api_async.fetch_ohlcv("BTC/USDT", "15m", limit=32)
        assert len(bars) >= 20
        return len(bars)
    bars = exchange.loop.run_until_complete(asynchronous())
    print(json.dumps({"status": "passed", "mode": "demo", "credentialsUsed": False, "ordersSubmitted": 0,
        "syncOrderBook": True, "asyncCandles": bars, "demoGuard": exchange.demo_destination_guard}))
finally:
    exchange.close()
