"""Public-only futures connectivity probe. No keys, no engine, no account writes."""
import importlib.util
import json
from pathlib import Path
from freqtrade.enums import RunMode
spec = importlib.util.spec_from_file_location('futures_public_adapter', Path(__file__).with_name('demo-futures-engine.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class PublicProbe(adapter.DemoFuturesBinance):
    def additional_exchange_init(self):
        # Public-only probe deliberately does not query account settings.
        pass
    def create_order(self, **kwargs):
        raise RuntimeError('PUBLIC_PROBE_CANNOT_ORDER')

adapter.protect_transports()
exchange = PublicProbe({'dry_run': False, 'runmode': RunMode.OTHER, 'trading_mode': 'futures', 'margin_mode': 'isolated',
    'exchange': {'name': 'binance', 'demo_trading': True, 'enable_ws': False,
        'ccxt_config': {'options': {'defaultType': 'future', 'fetchMarkets': {'types': ['linear']}, 'fetchCurrencies': False}}}}, validate=False)
try:
    markets = exchange._api.load_markets()
    result = []
    for pair in adapter.PAIRS:
        market = markets[pair]
        if not (market['swap'] and market['linear'] and market['settle'] == 'USDT' and market['active']):
            raise ValueError('NOT_A_VERIFIED_USDT_PERPETUAL')
        book = exchange._api.fetch_order_book(pair, 5)
        if not book['bids'] or not book['asks']:
            raise ValueError('MISSING_ORDERBOOK')
        result.append({'pair': pair, 'verified': True, 'minCost': market['limits']['cost']['min']})
    bars = exchange.loop.run_until_complete(exchange._api_async.fetch_ohlcv(adapter.PAIRS[0], '15m', limit=32))
    print(json.dumps({'mode': 'demo-futures', 'markets': result, 'asyncCandles': len(bars), 'accountChecked': False, 'ordersSubmitted': 0}))
finally:
    exchange.close()
