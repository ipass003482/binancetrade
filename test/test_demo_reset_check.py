import asyncio
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('demo_reset_check_test', ROOT / 'scripts/demo-reset-check.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def account(futures=True):
    return ({'canTrade': True, 'multiAssetsMargin': False, 'positions': [], 'totalWalletBalance': '2000'} if futures
            else {'accountType': 'SPOT', 'canTrade': True, 'balances': [{'asset': 'USDT', 'free': '2000', 'locked': '0'}]})


def fake_api(data=None):
    values = {'account': account(), 'positions': [], 'openOrders': [], 'algoOpenOrders': []}
    values.update(data or {})
    calls = []
    def request(name):
        def read(params):
            calls.append((name, params))
            value = values[name]
            if isinstance(value, Exception):
                raise value
            return copy.deepcopy(value)
        return read
    return SimpleNamespace(fapiPrivateV2GetAccount=request('account'),
        fapiPrivateV3GetPositionRisk=request('positions'), fapiPrivateGetOpenOrders=request('openOrders'),
        fapiPrivateGetOpenAlgoOrders=request('algoOpenOrders'), private_get_account=request('account'),
        private_get_openorders=request('openOrders')), calls


def report(data=None, mode='demo-futures'):
    api, calls = fake_api(data)
    result = check.check_api(mode, api, lambda: '2026-09-16T02:00:00+00:00')
    return result, calls


def position(amount='1', side='BOTH'):
    return {'symbol': 'XRPUSDT', 'positionSide': side, 'positionAmt': amount, 'markPrice': '1.2'}


def order(algo=False):
    return {'symbol': 'DOGEUSDT', 'side': 'SELL', ('algoId' if algo else 'orderId'): 99,
        ('algoStatus' if algo else 'status'): 'NEW', ('orderType' if algo else 'type'): 'STOP_MARKET',
        ('quantity' if algo else 'origQty'): '2'}


def test_complete_empty_futures_requires_all_unfiltered_reads():
    result, calls = report()
    assert result['flat'] is True and result['complete'] is True and result['noOpenOrders'] is True
    assert result['readOnly'] and 'readonly' not in result
    assert result['source'] == 'https://demo-fapi.binance.com'
    assert calls == [(k, {}) for k in ('account', 'positions', 'openOrders', 'algoOpenOrders')]


@pytest.mark.parametrize('field', ['positions', 'openOrders', 'algoOpenOrders'])
@pytest.mark.parametrize('bad', [None, {}, {'code': -1}, '[]', [None], [True], [dict()], float('nan'), RuntimeError('secret-do-not-echo')])
def test_missing_malformed_or_failed_class_never_claims_flat(field, bad):
    result, calls = report({field: bad})
    assert result['flat'] is None and not result['complete']
    assert result['checks'][field]['status'] == 'unavailable'
    assert len(calls) == 4
    assert 'secret-do-not-echo' not in json.dumps(result, allow_nan=False)


@pytest.mark.parametrize('amount', ['NaN', 'Infinity', '-Infinity', True, None, '', '1e1000'])
def test_nan_or_unbounded_position_amount_never_flat(amount):
    result, _ = report({'positions': [position(amount)]})
    assert result['flat'] is None and not result['complete']


@pytest.mark.parametrize('amount', ['1', '-1', '0.00000001'])
def test_any_nonzero_full_account_position_blocks_flat_even_outside_bot_pairs(amount):
    p = position(amount)
    result, _ = report({'account': {**account(), 'positions': [p]}, 'positions': [p]})
    assert result['complete'] and result['flat'] is False
    assert result['positions']['nonzeroPositions'][0]['symbol'] == 'XRPUSDT'


def test_hedged_long_short_never_net_to_zero_and_mismatched_account_never_flat():
    positions = [position('1', 'LONG'), position('-1', 'SHORT')]
    result, _ = report({'account': {**account(), 'positions': positions}, 'positions': positions})
    assert result['complete'] and result['flat'] is False
    mismatch, _ = report({'account': {**account(), 'positions': positions}})
    assert not mismatch['complete'] and mismatch['flat'] is None
    assert mismatch['checks']['crossCheck']['reason'] == 'ACCOUNT_POSITION_MISMATCH'


@pytest.mark.parametrize('algo', [False, True])
def test_any_general_or_algo_order_blocks_flat_and_nan_quantity_fails(algo):
    field = 'algoOpenOrders' if algo else 'openOrders'
    result, _ = report({field: [order(algo)]})
    assert result['complete'] and result['flat'] is False and result['noOpenOrders'] is False
    bad = order(algo)
    bad['quantity' if algo else 'origQty'] = 'NaN'
    result, _ = report({field: [bad]})
    assert not result['complete'] and result['flat'] is None


def test_spot_all_assets_and_locked_balances_visible_dust_is_not_silently_flat():
    cash, calls = report({'account': account(False)}, mode='demo')
    assert cash['flat'] is True and calls == [('account', {}), ('openOrders', {})]
    raw = account(False)
    raw['balances'].append({'asset': 'BTC', 'free': '0.00000001', 'locked': '0'})
    dust, _ = report({'account': raw}, mode='demo')
    assert dust['complete'] and dust['flat'] is False and dust['noOpenOrders'] is True
    assert dust['residualAssets'][0]['asset'] == 'BTC'
    raw['balances'][0]['locked'] = '1'
    locked, _ = report({'account': raw}, mode='demo')
    assert locked['lockedAssets'][0]['asset'] == 'USDT'
    raw['balances'][1]['free'] = 'NaN'
    invalid, _ = report({'account': raw}, mode='demo')
    assert not invalid['complete'] and invalid['flat'] is None


@pytest.mark.parametrize('mode,url,method', [
    ('demo', 'https://api.binance.com/api/v3/account', 'GET'),
    ('demo', 'https://demo-api.binance.com/api/v3/order', 'POST'),
    ('demo', 'https://demo-api.binance.com/api/v3/openOrders', 'DELETE'),
    ('demo', 'https://demo-api.binance.com/api/v3/order', 'GET'),
    ('demo-futures', 'https://demo-fapi.binance.com/fapi/v1/order', 'POST'),
    ('demo-futures', 'https://demo-fapi.binance.com/fapi/v1/marginType', 'POST'),
    ('demo-futures', 'https://fapi.binance.com/fapi/v3/positionRisk', 'GET'),
    ('demo-futures', 'https://user:password@demo-fapi.binance.com/fapi/v3/positionRisk', 'GET'),
])
def test_read_only_exact_demo_destination_guard(mode, url, method):
    with pytest.raises(ValueError):
        check.read_only_url(mode, url, method)


def test_transport_get_only_no_redirects_before_adapter_constructor(monkeypatch):
    import requests
    import aiohttp
    seen = []
    monkeypatch.setattr(requests.Session, 'send', lambda self, request, **kwargs: seen.append(kwargs))
    async def original(self, method, url, **kwargs):
        seen.append(kwargs)
    monkeypatch.setattr(aiohttp.ClientSession, '_request', original)
    adapter_calls = []
    check.install_read_only_transports(SimpleNamespace(protect_transports=lambda: adapter_calls.append('original-demo-guard')), 'demo-futures')
    assert adapter_calls == ['original-demo-guard']
    url = 'https://demo-fapi.binance.com/fapi/v1/openAlgoOrders'
    requests.Session().send(requests.Request('GET', url).prepare())
    asyncio.run(aiohttp.ClientSession._request(None, 'GET', url))
    assert len(seen) == 2 and all(k['allow_redirects'] is False for k in seen)
    for method in ['POST', 'PUT', 'DELETE']:
        with pytest.raises(ValueError):
            requests.Session().send(requests.Request(method, url).prepare())
    assert len(seen) == 2


def test_invalid_mode_fails_before_reading_credentials(monkeypatch):
    monkeypatch.setattr(check, 'load_adapter', lambda mode: pytest.fail('must not load adapter'))
    with pytest.raises(ValueError):
        check.read_check('live')


@pytest.mark.parametrize('mode', ['demo', 'demo-futures'])
def test_runtime_reuses_original_credentials_and_installs_guard_before_constructor(monkeypatch, mode):
    api, calls = fake_api({'account': account(mode == 'demo-futures')})
    events = []
    api.options = {'enableDemoTrading': True}
    api.load_time_difference = lambda: events.append('time-read')
    def constructor(config, validate):
        assert events == ['guard', 'credential-read']
        assert validate is False and config['exchange']['demo_trading'] is True
        assert config['exchange']['key'] == 'fake-private-key-never-returned'
        assert config['exchange']['secret'] == 'fake-private-secret-never-returned'
        events.append('construct')
        return SimpleNamespace(_api=api, close=lambda: events.append('close'))
    def credentials():
        events.append('credential-read')
        return {'key': 'fake-private-key-never-returned', 'secret': 'fake-private-secret-never-returned'}
    adapter = SimpleNamespace(read_credentials=credentials, DemoBinance=constructor, DemoFuturesBinance=constructor)
    monkeypatch.setattr(check, 'load_adapter', lambda requested: adapter)
    monkeypatch.setattr(check, 'install_read_only_transports', lambda loaded, requested: events.append('guard'))
    monkeypatch.setattr(check.logging, 'disable', lambda level: None)
    result = check.read_check(mode)
    assert result['complete'] and result['flat'] is True
    assert events == ['guard', 'credential-read', 'construct', 'time-read', 'close']
    assert 'fake-private' not in json.dumps(result)
    assert all(params == {} for _, params in calls)


def test_wrong_account_identity_duplicate_positions_and_nonfinite_optional_fields_fail():
    for raw in [None, {}, {**account(), 'canTrade': False}, {**account(), 'multiAssetsMargin': True},
                {**account(), 'positions': None}, {**account(), 'totalWalletBalance': 'NaN'},
                {**account(), 'accountType': {'untrusted': 'not-an-account-type'}}]:
        result, _ = report({'account': raw})
        assert not result['complete'] and result['flat'] is None


def test_full_account_unicode_assets_are_valid_and_nonzero_residuals_remain_visible():
    raw = account(False)
    raw['balances'].extend([{'asset': '币安人生', 'free': '0', 'locked': '0'}, {'asset': '牛来', 'free': '0', 'locked': '0'}])
    result, _ = report({'account': raw}, mode='demo')
    assert result['complete'] and result['flat'] is True and result['account']['checkedBalanceCount'] == 3
    raw['balances'][-1]['free'] = '0.00000001'
    result, _ = report({'account': raw}, mode='demo')
    assert result['complete'] and result['flat'] is False
    assert result['residualAssets'][0]['asset'] == '牛来'
    p = {**position('1'), 'symbol': '币安人生USDT'}
    futures, _ = report({'account': {**account(), 'positions': [p]}, 'positions': [p]})
    assert futures['complete'] and futures['flat'] is False


@pytest.mark.parametrize('bad', ['BTC/USDT', 'A B', 'A\nB', 'A\u200bB', 'A\u202eB', '', '---', 'A' * 81])
def test_asset_identifiers_reject_controls_separators_and_unbounded_values(bad):
    with pytest.raises(ValueError, match='INVALID_SYMBOL'):
        check.symbol(bad)


def test_report_keys_are_case_insensitively_unique_for_powershell_and_errors_are_sanitized():
    result, _ = report({'positions': RuntimeError('secret?signature=do-not-print')})
    def visit(value):
        if isinstance(value, dict):
            assert len(value) == len({key.casefold() for key in value})
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(result)
    assert result['checks']['positions']['phase'] == 'request'
    assert 'signature' not in json.dumps(result)
    for positions in [[position('0'), position('0')], [{**position('0'), 'markPrice': 'NaN'}]]:
        result, _ = report({'positions': positions})
        assert not result['complete'] and result['flat'] is None
