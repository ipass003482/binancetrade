"""Read-only signed Demo acceptance. Never calls an order submission API."""
import importlib.util
import json
import sys
from pathlib import Path
from freqtrade.enums import RunMode
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("demo_adapter", ROOT / "scripts/demo-engine.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

def check():
    credentials = adapter.read_credentials()
    adapter.protect_transports()
    config = {"dry_run": False, "runmode": RunMode.LIVE, "trading_mode": "spot", "margin_mode": "",
        "exchange": {"name": "binance", "demo_trading": True, "enable_ws": False,
            **credentials, "ccxt_config": {"options": {"defaultType": "spot",
             "fetchMarkets": {"types": ["spot"]}, "fetchCurrencies": False, "adjustForTimeDifference": True}}}}
    exchange = adapter.DemoBinance(config, validate=False)
    try:
        exchange._api.load_markets()
        account = exchange._api.private_get_account()
        orders = exchange._api.private_get_openorders()
        if account.get("accountType") != "SPOT" or account.get("canTrade") is not True:
            raise ValueError("Demo spot trading permission required")
        return {"mode": "demo", "endpoint": "https://demo-api.binance.com", "readOnly": True,
            "accountType": account["accountType"], "canTrade": account["canTrade"],
            "openOrders": len(orders), "balances": [{"asset": b["asset"], "free": b["free"], "locked": b["locked"]}
                for b in account["balances"] if float(b["free"]) != 0 or float(b["locked"]) != 0]}
    finally:
        exchange.close()

if __name__ == "__main__":
    try:
        print(json.dumps(check()))
    except Exception as error:
        print(json.dumps({"status": "failed", "code": type(error).__name__,
            "message": "Check local Demo credentials, permissions and connectivity. No orders submitted."}))
        sys.exit(1)
