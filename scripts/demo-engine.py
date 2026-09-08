"""Process-local Binance Demo adapter. Never modifies installed Freqtrade."""
import asyncio
import inspect
import json
import logging
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import ccxt
import freqtrade.exchange as exchanges
from freqtrade.exchange.binance import Binance

ROOT = Path(__file__).resolve().parent.parent
DEMO_HOST = "demo-api.binance.com"

def check_url(url):
    value = urlsplit(str(url))
    if (value.scheme != "https" or value.hostname != DEMO_HOST or value.port not in (None, 443)
        or value.username or value.password or not value.path.startswith("/api/")):
        raise ccxt.PermissionDenied("DEMO_DESTINATION_REJECTED")

def protect_transports():
    # Guard the actual wire request as well as CCXT's composed URL. No redirects.
    import requests
    import aiohttp
    old_send = requests.Session.send
    def send(self, request, **kwargs):
        check_url(request.url)
        kwargs["allow_redirects"] = False
        return old_send(self, request, **kwargs)
    requests.Session.send = send
    old_request = aiohttp.ClientSession._request
    async def request(self, method, str_or_url, **kwargs):
        check_url(str_or_url)
        kwargs["allow_redirects"] = False
        return await old_request(self, method, str_or_url, **kwargs)
    aiohttp.ClientSession._request = request

class DemoBinance(Binance):
    demo_destination_guard = True
    _ft_has = {**Binance._ft_has, "supports_demo_trading": True, "has_delisting": False, "ws_enabled": False}
    def _init_ccxt(self, exchange_config, sync, ccxt_kwargs):
        if exchange_config.get("demo_trading") is not True:
            raise ValueError("DEMO_MODE_REQUIRED")
        api = super()._init_ccxt(exchange_config, sync, ccxt_kwargs)
        if api.options.get("enableDemoTrading") is not True:
            raise ValueError("DEMO_ROUTING_REQUIRED")
        original = api.fetch
        if inspect.iscoroutinefunction(original):
            async def fetch(url, *args, **kwargs):
                check_url(url)
                try:
                    return await original(url, *args, **kwargs)
                except ccxt.BaseError as error:
                    raise type(error)("Demo exchange request failed: " + type(error).__name__) from None
        else:
            def fetch(url, *args, **kwargs):
                check_url(url)
                try:
                    return original(url, *args, **kwargs)
                except ccxt.BaseError as error:
                    raise type(error)("Demo exchange request failed: " + type(error).__name__) from None
        api.fetch = fetch
        return api

def read_credentials():
    result = subprocess.run(["powershell.exe", "-NoProfile", "-File", str(ROOT / "scripts/read-demo-secret.ps1"),
        "-CredentialFile", str(ROOT / "local/demo/credentials.dpapi.json")],
        capture_output=True, text=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise ValueError("DEMO_CREDENTIALS_UNAVAILABLE: run configure-demo.ps1 locally")
    try:
        value = json.loads(result.stdout)
        if any(not isinstance(value.get(k), str) or len(value[k]) < 16 for k in ("key", "secret")):
            raise ValueError()
        return value
    except Exception:
        raise ValueError("DEMO_CREDENTIALS_INVALID") from None

def validate_config(config):
    if (config.get("dry_run") is not False or config.get("trading_mode") != "spot"
        or config.get("bot_name") != "binance-trade-demo" or config.get("strategy") != "CodexDemoSpot"
        or config.get("exchange", {}).get("name") != "binance"
        or config["exchange"].get("demo_trading") is not True):
        raise ValueError("DEMO_CONFIG_REJECTED")
    if config["exchange"].get("key") or config["exchange"].get("secret"):
        raise ValueError("PLAINTEXT_CREDENTIALS_REJECTED")

def install_adapter(credentials):
    class AuthenticatedDemoBinance(DemoBinance):
        def __init__(self, config, **kwargs):
            validate_config(config)
            config["exchange"]["key"] = credentials["key"]
            config["exchange"]["secret"] = credentials["secret"]
            # Disable unsupported services, proxies, websocket and config URL overrides.
            config["exchange"] = {
                "name": "binance", "key": credentials["key"], "secret": credentials["secret"],
                "demo_trading": True, "enable_ws": False,
                "pair_whitelist": config["exchange"]["pair_whitelist"], "pair_blacklist": [],
                "ccxt_config": {"enableRateLimit": True, "options": {
                    "defaultType": "spot", "fetchMarkets": {"types": ["spot"]},
                    "fetchCurrencies": False, "adjustForTimeDifference": True}}
            }
            kwargs['exchange_config'] = None
            super().__init__(config, **kwargs)
    exchanges.Binance = AuthenticatedDemoBinance

def main():
    # Arguments are fixed by the launcher; no arbitrary Freqtrade subcommands/config.
    if len(sys.argv) != 1:
        raise ValueError("DEMO_ARGUMENTS_REJECTED")
    config_path = ROOT / "local/demo/freqtrade/config.json"
    validate_config(json.loads(config_path.read_text(encoding="utf-8-sig")))
    credentials = read_credentials()
    protect_transports()
    install_adapter(credentials)
    # Prevent any dependency logger from emitting actual credentials/signatures.
    old_factory = logging.getLogRecordFactory()
    def factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        message = record.getMessage()
        for value in credentials.values():
            message = message.replace(value, "[REDACTED]")
        import re
        record.msg = re.sub(r"signature=[a-zA-Z0-9]+", "signature=[REDACTED]", message)
        record.args = ()
        return record
    logging.setLogRecordFactory(factory)
    from freqtrade.main import main as freqtrade_main
    directory = ROOT / "local/demo/freqtrade"
    freqtrade_main(["trade", "--config", str(config_path), "--userdir", str(directory),
        "--strategy-path", str(ROOT / "freqtrade/strategies"), "--strategy", "CodexDemoSpot",
        "--db-url", "sqlite:///" + (directory / "trades.demo.sqlite").as_posix(),
        "--logfile", str(directory / "engine.log")])

if __name__ == "__main__":
    main()
