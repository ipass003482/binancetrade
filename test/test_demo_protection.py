"""Actual installed Freqtrade + CCXT routing contracts, with network stubbed."""
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from types import SimpleNamespace

import ccxt
import pytest
from freqtrade.enums import RunMode
from freqtrade.exceptions import TemporaryError, InvalidOrderException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import demo_protection as protection


def load_adapter(futures):
    name = 'demo-futures-engine' if futures else 'demo-engine'
    spec = importlib.util.spec_from_file_location(name + '_stops_test', ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(params=[False, True], ids=['spot', 'futures'])
def native(request, tmp_path, monkeypatch):
    futures = request.param
    adapter = load_adapter(futures)
    cls = adapter.DemoFuturesBinance if futures else adapter.DemoBinance
    monkeypatch.setattr(cls, 'additional_exchange_init', lambda self: None)
    monkeypatch.setattr(protection, 'ROOT', tmp_path)
    pair = 'ETH/USDT:USDT' if futures else 'ETH/USDT'
    config = {'dry_run': False, 'runmode': RunMode.LIVE, 'trading_mode': 'futures' if futures else 'spot',
        'margin_mode': 'isolated' if futures else '', 'stake_currency': 'USDT',
        'exchange': {'name': 'binance', 'demo_trading': True, 'enable_ws': False,
            'pair_whitelist': [pair], 'key': 'unit-test-key', 'secret': 'unit-test-secret',
            'ccxt_config': {'options': {'defaultType': 'future' if futures else 'spot',
                'fetchMarkets': {'types': ['linear'] if futures else ['spot']}, 'fetchCurrencies': False}}}}
    protection.pin_demo_exit_config(config, futures)
    exchange = cls(config, validate=False)
    market = {'id': 'ETHUSDT', 'symbol': pair, 'base': 'ETH', 'quote': 'USDT', 'settle': 'USDT' if futures else None,
        'baseId': 'ETH', 'quoteId': 'USDT', 'settleId': 'USDT' if futures else None,
        'type': 'swap' if futures else 'spot', 'spot': not futures, 'swap': futures, 'future': False,
        'option': False, 'contract': futures, 'linear': futures, 'inverse': False, 'active': True,
        'contractSize': 1 if futures else None, 'precision': {'amount': .001, 'price': .01},
        'limits': {'amount': {'min': .001, 'max': 10000}, 'price': {'min': .01, 'max': 100000},
                   'cost': {'min': 5, 'max': None}, 'leverage': {'min': 1, 'max': 3}},
        'info': {'orderTypes': ['LIMIT', 'MARKET', 'STOP_MARKET' if futures else 'STOP_LOSS_LIMIT']}}
    exchange._api.set_markets([market])
    exchange._markets = exchange._api.markets
    exchange._lev_prep = lambda *args, **kwargs: None
    wire = []
    replies = []
    accepted = {}

    def fetch(url, method='GET', headers=None, body=None):
        adapter.check_url(url)
        values = {key: value[0] for key, value in parse_qs(body or urlsplit(url).query).items()}
        wire.append((urlsplit(url).hostname, urlsplit(url).path, method, values))
        if method == 'POST':
            if replies:
                response = replies.pop(0)
                if isinstance(response, Exception):
                    raise response
            if futures:
                accepted.update(algoId='9001', clientAlgoId=values['clientAlgoId'], algoType='CONDITIONAL',
                    orderType='STOP_MARKET', symbol='ETHUSDT', side=values['side'], positionSide='BOTH',
                    quantity=values['quantity'], algoStatus='NEW', triggerPrice=values['triggerPrice'],
                    reduceOnly=True, createTime=1700000000000, updateTime=1700000000000)
            else:
                accepted.update(orderId='9001', clientOrderId=values['newClientOrderId'], symbol='ETHUSDT',
                    side='SELL', type='STOP_LOSS_LIMIT', origQty=values['quantity'], executedQty='0',
                    cummulativeQuoteQty='0', price=values['price'], stopPrice=values['stopPrice'],
                    status='NEW', timeInForce='GTC', transactTime=1700000000000)
        if method == 'DELETE':
            accepted['algoStatus' if futures else 'status'] = 'CANCELED'
        return dict(accepted)

    exchange._api.fetch = fetch
    value = SimpleNamespace(exchange=exchange, parent=adapter.Binance, pair=pair, futures=futures, wire=wire, replies=replies,
        accepted=accepted, order_types=config['order_types'])
    try:
        yield value
    finally:
        exchange.close()


def create(native):
    return native.exchange.create_stoploss(native.pair, .01, 2400, native.order_types,
                                           'buy' if native.futures else 'sell', 1)


def test_installed_native_stop_create_query_cancel_all_route_demo(native):
    state = native.exchange.demo_protection_capabilities()
    assert state['stopPriceVersion'] == 'stable-unarmed-stop-v1'
    assert state['riskPolicyVersion'] == 'native-stop-risk-v1'
    assert state['stopLimitRatio'] == (None if native.futures else .995)
    assert state['capabilities'][native.pair]['status'] == 'capability_validated'
    assert state['protectionEvidence'] == 'actual_order_ack_required'
    assert state['attempts'] == []
    order = create(native)
    assert order['id'] == '9001'
    host, path, method, payload = native.wire[-1]
    assert method == 'POST'
    assert payload['type'] == ('STOP_MARKET' if native.futures else 'STOP_LOSS_LIMIT')
    if native.futures:
        assert (host, path) == ('demo-fapi.binance.com', '/fapi/v1/algoOrder')
        assert payload['reduceOnly'] == 'true'
        assert payload['algoType'] == 'CONDITIONAL'
        assert payload['workingType'] == 'CONTRACT_PRICE'
        assert payload['clientAlgoId'].startswith('codex-sl-')
    else:
        assert (host, path) == ('demo-api.binance.com', '/api/v3/order')
        assert float(payload['price']) < float(payload['stopPrice'])
        assert payload['newClientOrderId'].startswith('codex-sl-')
    state = native.exchange._read_protection()
    assert state['attempts'][0]['status'] == 'confirmed'
    assert state['attempts'][0]['orderStatus'] == 'open'
    native.exchange.fetch_stoploss_order('9001', native.pair)
    assert native.wire[-1][2] == 'GET'
    native.exchange.cancel_stoploss_order('9001', native.pair)
    assert native.wire[-1][2] == 'DELETE'
    assert native.exchange._read_protection()['attempts'][0]['orderStatus'] == 'canceled'
    assert native.exchange._read_protection()['attempts'][0]['protectionStatus'] == 'resolved'
    assert native.exchange._read_protection()['activeStops'] == []
    assert not (native.exchange._protection_path.parent / 'STOP').exists()


@pytest.mark.parametrize('version', ['atr15m-forward-v9', 'atr15m-forward-v10', 'kronos-forward-v11', 'kronos-direction-v12'])
def test_profit_protection_replaces_native_stop_once_and_keeps_direction_quantity_and_receipt(native, version):
    from datetime import timedelta
    from freqtrade.freqtradebot import FreqtradeBot
    from freqtrade.persistence import Order
    from test_rule_exit_profiles import fixture
    from RuleExits import TRAILING_RULE_VERSIONS, BREAKEVEN_KEY, TRAILING_KEY
    strategy, trade, plan, now = fixture(version, native.futures)
    strategy.order_types = native.order_types
    strategy.dp._exchange = native.exchange
    side = 'buy' if native.futures else 'sell'
    old = native.exchange.create_stoploss(native.pair, trade.amount, 101 if native.futures else 99,
                                          native.order_types, side, 1)
    rate = 98 if native.futures else 102
    strategy.ft_stoploss_adjust(rate, trade, now, trade.calc_profit_ratio(rate), 0)
    key = TRAILING_KEY if version in TRAILING_RULE_VERSIONS else BREAKEVEN_KEY
    state = trade.get_custom_data(key=key)
    target = state['stopPrice']
    trade.orders = [Order(ft_order_side='stoploss', ft_pair=trade.pair, ft_is_open=True,
                          order_id=old['id'], status='open', order_date=now - timedelta(seconds=20))]
    receipts = []
    def cancel(t):
        receipt = native.exchange.cancel_stoploss_order_with_result(old['id'], t.pair, t.amount)
        assert receipt['status'] == 'canceled'
        receipts.append(receipt)
    def replace(*, trade, stop_price):
        receipts.append(native.exchange.create_stoploss(trade.pair, trade.amount, stop_price,
                                                        native.order_types, side, trade.leverage))
        return True
    bot = SimpleNamespace(exchange=native.exchange, strategy=strategy,
                          cancel_stoploss_on_exchange=cancel, create_stoploss_order=replace)
    # Actual installed native replacement scheduler plus guarded adapter and
    # CCXT serialization. Only HTTP replies are stubbed; this is not Demo PnL.
    FreqtradeBot.handle_trailing_stoploss_on_exchange(bot, trade, old)
    assert len(receipts) == 2
    assert [row[2] for row in native.wire if row[2] != 'GET'] == ['POST', 'DELETE', 'POST']
    wire_count = len(native.wire)
    host, path, _, payload = native.wire[-1]
    assert host == ('demo-fapi.binance.com' if native.futures else 'demo-api.binance.com')
    assert payload['side'] == side.upper()
    assert float(payload['quantity']) == trade.amount
    assert float(payload['triggerPrice' if native.futures else 'stopPrice']) == target
    assert trade.calculate_profit(target).profit_abs >= 0
    if version in TRAILING_RULE_VERSIONS:
        assert trade.calculate_profit(target).profit_abs >= state['protectedNetUsdt'] - 1e-8
    if native.futures:
        assert payload['reduceOnly'] == 'true'
    for seconds in range(5, 61, 5):
        strategy.ft_stoploss_adjust(rate, trade, now + timedelta(seconds=seconds), trade.calc_profit_ratio(rate), 0)
        FreqtradeBot.handle_trailing_stoploss_on_exchange(bot, trade, receipts[-1])
    assert trade.stop_loss == target
    assert len(native.wire) == wire_count  # No rounding drift or repeated cancel/create.


def test_missing_market_capability_rejects_before_any_order(native):
    native.exchange._markets[native.pair]['info']['orderTypes'] = ['LIMIT', 'MARKET']
    assert not native.exchange.demo_entry_protection_allowed(native.pair)
    with pytest.raises(TemporaryError, match='PREFLIGHT_REJECTED'):
        create(native)
    assert native.wire == []
    assert native.exchange._protection_path.parent.joinpath('STOP').exists()


def test_uncertain_stop_reply_is_persisted_and_never_resubmitted(native):
    native.replies.append(ccxt.RequestTimeout('No receipt'))
    with pytest.raises(TemporaryError, match='RECONCILIATION_REQUIRED'):
        create(native)
    assert native.exchange._read_protection()['attempts'][0]['status'] == 'unknown'
    assert not native.exchange.demo_entry_protection_allowed(native.pair)
    with pytest.raises(TemporaryError, match='RECONCILIATION_REQUIRED'):
        create(native)
    assert len([row for row in native.wire if row[2] == 'POST']) == 1
    assert native.exchange._read_protection()['attempts'][0]['status'] == 'unknown'


def test_uncertain_stop_can_be_adopted_only_by_matching_client_identity(native):
    order = create(native)
    state = native.exchange._read_protection()
    attempt = state['attempts'][0]
    attempt['status'] = 'unknown'
    attempt.pop('orderId')
    native.exchange._write_protection(state)
    adopted = create(native)
    assert adopted['id'] == order['id']
    assert len([row for row in native.wire if row[2] == 'POST']) == 1
    state = native.exchange._read_protection()
    assert state['attempts'][0]['reconciled'] is True
    assert state['attempts'][0]['status'] == 'confirmed'
    assert native.wire[-1][3].get('clientAlgoId' if native.futures else 'origClientOrderId') == attempt['clientOrderId']


def test_definitive_exchange_rejection_is_visible_and_retains_native_emergency_exit(native):
    native.replies.append(ccxt.InvalidOrder('Not supported'))
    with pytest.raises(InvalidOrderException):
        create(native)
    assert native.exchange._read_protection()['attempts'][0]['status'] == 'rejected'
    assert native.exchange._protection_path.parent.joinpath('STOP').exists()


@pytest.mark.parametrize('patch', [{'amount': .009}, {'stopPrice': 2399}, {'side': 'wrong'},
    {'symbol': 'BTC/USDT'}, {'clientOrderId': 'wrong'}])
def test_order_proof_rejects_underprotection_or_wrong_identity(native, patch):
    order = create(native)
    attempt = native.exchange._read_protection()['attempts'][0]
    assert native.exchange._stop_proof(order, attempt)
    assert not native.exchange._stop_proof(order | patch, attempt)


def test_id_only_ack_is_enriched_by_read_without_another_create(native, monkeypatch):
    original = native.parent.create_stoploss
    def limited_ack(self, *args, **kwargs):
        order = original(self, *args, **kwargs)
        return {'id': order['id']}
    monkeypatch.setattr(native.parent, 'create_stoploss', limited_ack)
    assert create(native)['id'] == '9001'
    assert [row[2] for row in native.wire] == ['POST', 'GET']
    assert native.exchange._read_protection()['attempts'][0]['status'] == 'confirmed'


def test_missing_lookup_after_id_ack_remains_ambiguous(native, monkeypatch):
    monkeypatch.setattr(native.parent, 'create_stoploss', lambda *args, **kwargs: {'id': '9001'})
    def missing(*args, **kwargs):
        raise InvalidOrderException('Not found')
    monkeypatch.setattr(native.parent, 'fetch_stoploss_order', missing)
    with pytest.raises(TemporaryError, match='RECONCILIATION_REQUIRED'):
        create(native)
    assert native.exchange._read_protection()['attempts'][0]['status'] == 'unknown'


def test_native_order_telemetry_labels_reference_and_receipt_without_invented_quote(native, monkeypatch):
    order = {'id': 'entry-test', 'status': 'closed', 'filled': .01, 'average': 2400.3, 'cost': 24.003,
             'info': {'sensitive': 'not-for-telemetry'}}
    seen = []
    def fake_create(self, **kwargs):
        seen.append(kwargs)
        return order
    monkeypatch.setattr(native.parent, 'create_order', fake_create)
    result = native.exchange.create_order(pair=native.pair, ordertype='market', side='buy' if native.futures else 'sell',
                                          amount=.01, rate=2400, leverage=1, reduceOnly=native.futures, initial_order=False)
    assert result is order and len(seen) == 1
    path = native.exchange._protection_path.parent / 'native-orders.jsonl'
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [r['event'] for r in rows] == ['request', 'order_receipt']
    assert rows[1]['orderId'] == 'entry-test' and rows[1]['average'] == 2400.3
    assert rows[1]['referenceRate'] == 2400
    assert rows[1]['referenceRateSource'] == 'native_engine_order_reference'
    assert rows[1]['exchangePreOrderQuote'] is None
    assert 'not-for-telemetry' not in path.read_text()


def test_native_failed_order_telemetry_does_not_log_raw_error_or_retry(native, monkeypatch):
    calls = []
    def fail(self, **kwargs):
        calls.append(kwargs)
        raise TemporaryError('Sensitive request contents')
    monkeypatch.setattr(native.parent, 'create_order', fail)
    with pytest.raises(TemporaryError):
        native.exchange.create_order(pair=native.pair, ordertype='market', side='buy' if native.futures else 'sell',
                                     amount=.01, rate=2400, reduceOnly=native.futures, initial_order=False)
    path = native.exchange._protection_path.parent / 'native-orders.jsonl'
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert rows[-1]['event'] == 'request_failed_or_unknown'
    assert rows[-1]['errorClass'] == 'TemporaryError'
    assert 'Sensitive' not in path.read_text()
    assert len(calls) == 1


def test_capability_heartbeat_does_not_refresh_actual_order_observation(native):
    create(native)
    state = native.exchange._read_protection()
    observed = state['attempts'][0]['observedAt']
    requests = len(native.wire)
    native.exchange.demo_protection_capabilities()
    updated = native.exchange._read_protection()
    assert updated['attempts'][0]['observedAt'] == observed
    assert updated['activeStops'][0]['observedAt'] == observed
    assert len(native.wire) == requests  # No invented receipt and no additional HTTP query.


def test_native_cancel_wrapper_reads_terminal_status_when_cancel_receipt_still_says_open(native, monkeypatch):
    order = create(native)
    original = native.parent.cancel_stoploss_order
    def open_receipt(self, *args, **kwargs):
        canceled = original(self, *args, **kwargs)
        return canceled | {'status': 'open'}  # Actual Demo cancel receipt behavior.
    monkeypatch.setattr(native.parent, 'cancel_stoploss_order', open_receipt)
    result = native.exchange.cancel_stoploss_order_with_result(order['id'], native.pair, .01)
    assert result['status'] == 'canceled'
    assert [r[2] for r in native.wire] == ['POST', 'DELETE', 'GET']
    state = native.exchange._read_protection()
    assert state['activeStops'] == []
    assert state['attempts'][0]['orderStatus'] == 'canceled'


def test_missing_cancel_and_lookup_never_fabricate_canceled_state(native, monkeypatch):
    monkeypatch.setattr(protection, 'sleep', lambda _: None)
    order = create(native)
    def missing(*args, **kwargs):
        raise InvalidOrderException('Unknown order')
    monkeypatch.setattr(native.parent, 'cancel_stoploss_order', missing)
    monkeypatch.setattr(native.parent, 'fetch_stoploss_order', missing)
    with pytest.raises(TemporaryError, match='CANCEL_UNCONFIRMED'):
        native.exchange.cancel_stoploss_order_with_result(order['id'], native.pair, .01)
    state = native.exchange._read_protection()
    assert state['attempts'][0]['orderStatus'] == 'open'
    assert len(state['activeStops']) == 1


def test_cancel_reads_past_transient_open_and_timeout_without_resending(native, monkeypatch):
    order = create(native)
    original_cancel = native.parent.cancel_stoploss_order
    original_fetch = native.parent.fetch_stoploss_order
    waits, reads = [], []
    monkeypatch.setattr(protection, 'sleep', waits.append)
    def open_receipt(self, *args, **kwargs):
        return original_cancel(self, *args, **kwargs) | {'status': 'open'}
    def delayed_read(self, *args, **kwargs):
        reads.append(args)
        if len(reads) == 1:
            return original_fetch(self, *args, **kwargs) | {'status': 'open'}
        if len(reads) == 2:
            raise TemporaryError('transient read timeout')
        return original_fetch(self, *args, **kwargs)
    monkeypatch.setattr(native.parent, 'cancel_stoploss_order', open_receipt)
    monkeypatch.setattr(native.parent, 'fetch_stoploss_order', delayed_read)
    result = native.exchange.cancel_stoploss_order_with_result(order['id'], native.pair, .01)
    assert result['status'] == 'canceled' and len(reads) == 3
    assert waits == [.25, .5]
    assert [r[2] for r in native.wire].count('DELETE') == 1
    assert [r[2] for r in native.wire].count('POST') == 1  # Original stop only.
    assert not native.exchange._protection_path.parent.joinpath('STOP').exists()


def test_cancel_timeout_is_resolved_only_by_read_not_repeated_delete(native, monkeypatch):
    order = create(native)
    original = native.parent.cancel_stoploss_order
    def lost_ack(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise TemporaryError('lost cancellation response')
    monkeypatch.setattr(native.parent, 'cancel_stoploss_order', lost_ack)
    assert native.exchange.cancel_stoploss_order_with_result(order['id'], native.pair, .01)['status'] == 'canceled'
    assert [r[2] for r in native.wire] == ['POST', 'DELETE', 'GET']
    assert not native.exchange._protection_path.parent.joinpath('STOP').exists()


@pytest.mark.parametrize('bad', ['open', 'wrong_id', 'wrong_pair'])
def test_bounded_cancel_reads_never_accept_unresolved_or_wrong_identity(native, monkeypatch, bad):
    order = create(native)
    waits, calls = [], []
    monkeypatch.setattr(protection, 'sleep', waits.append)
    monkeypatch.setattr(native.parent, 'cancel_stoploss_order', lambda *args, **kwargs: order)
    def unverified(self, *args, **kwargs):
        calls.append(args)
        return order | {'status': 'open' if bad == 'open' else 'canceled',
                        'id': 'wrong' if bad == 'wrong_id' else order['id'],
                        'symbol': 'wrong' if bad == 'wrong_pair' else native.pair}
    monkeypatch.setattr(native.parent, 'fetch_stoploss_order', unverified)
    with pytest.raises(TemporaryError, match='CANCEL_UNCONFIRMED'):
        native.exchange.cancel_stoploss_order_with_result(order['id'], native.pair, .01)
    assert len(calls) == 5 and waits == [.25, .5, 1, 2]
    assert native.exchange._protection_path.parent.joinpath('STOP').read_text().strip() == 'DEMO_STOP_CANCEL_UNCONFIRMED'
    assert native.exchange._read_protection()['attempts'][0]['orderStatus'] == 'open'


def test_flat_restart_recovers_actual_canceled_order_by_read_without_mutation(native):
    create(native)
    native.accepted['algoStatus' if native.futures else 'status'] = 'CANCELED'
    native.exchange.refresh_demo_stop_observations()
    state = native.exchange._read_protection()
    assert state['activeStops'] == []
    assert state['attempts'][0]['orderStatus'] == 'canceled'
    assert [row[2] for row in native.wire] == ['POST', 'GET']


def test_flat_restart_read_failure_retains_old_active_observation(native, monkeypatch):
    create(native)
    before = native.exchange._read_protection()['attempts'][0]['observedAt']
    def missing(*args, **kwargs):
        raise InvalidOrderException('Not found')
    monkeypatch.setattr(native.parent, 'fetch_stoploss_order', missing)
    native.exchange.refresh_demo_stop_observations()
    state = native.exchange._read_protection()
    assert len(state['activeStops']) == 1
    assert state['attempts'][0]['observedAt'] == before
    assert state['lastObservationError'] == 'DEMO_STOP_READ_UNAVAILABLE'


def test_normal_fresh_native_stop_is_not_queried_twice_by_the_heartbeat(native):
    create(native)
    native.exchange._protection_observations_initialized = True
    before = len(native.wire)
    native.exchange.refresh_demo_stop_observations()
    assert len(native.wire) == before


@pytest.mark.parametrize('futures', [False, True])
def test_exit_profile_pins_native_order_type_and_removes_global_conflicts(futures):
    config = dict(minimal_roi={'0': .03}, trailing_stop=True,
                  order_types={'stoploss_on_exchange': False, 'stoploss': 'market'})
    protection.pin_demo_exit_config(config, futures)
    assert config['minimal_roi'] == {} and config['trailing_stop'] is False
    assert config['use_custom_stoploss'] is True
    assert config['order_types']['stoploss_on_exchange'] is True
    assert config['order_types']['stoploss'] == ('market' if futures else 'limit')
