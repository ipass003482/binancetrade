"""New adaptive risk reacts to closed recent volatility while preserving exits."""
import copy
from decimal import Decimal

import ccxt
import pytest
from demo_model_guard_support import guard, isolate, fake_exchange, BOUNDARY
from test_demo_model_guard import authorize, advance
from test_demo_minute_adaptive import minute_plan, refresh_profile, volatility_proof, kwargs, wire
from demo_order_flow import derive_adaptive_parameters, FlowValidationError


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    return isolate(monkeypatch, tmp_path)


def profile(proof, plan=None):
    plan = plan or minute_plan()
    c = plan['entryConfirmation']
    return derive_adaptive_parameters(c['orderFlow'], 'demo', plan['pair'], 'long',
        c['atr15'], c['quotePrice'], '20', proof)


@pytest.mark.parametrize('early,recent,ratio,multiplier', [
    ('1', '3', '1.500000000000', '0.666666666666'),
    ('3', '1', '0.500000000000', '1.000000000000'),
    ('0', '0', '1.000000000000', '1.000000000000'),
    ('1', '0', '0.000000000000', '1.000000000000'),
])
def test_closed_recent_volatility_reduces_only_new_risk(early, recent, ratio, multiplier):
    old = minute_plan(legacy=True)
    value = profile(volatility_proof(early_range=early, recent_range=recent), old)
    assert value['version'] == 'live-flow-adaptive-v2'
    evidence = value['evidence']['volatility']
    assert evidence['ratio'] == ratio
    assert evidence['riskMultiplier'] == multiplier
    assert evidence['lastClosedAt'] == BOUNDARY - 1
    assert Decimal('.25') <= Decimal(value['riskBudgetUsdt']) <= Decimal(old['adaptiveParameters']['riskBudgetUsdt'])
    assert value['minTakerShare'] == old['adaptiveParameters']['minTakerShare']
    assert value['costBufferBps'] == old['adaptiveParameters']['costBufferBps']
    # Multiplication uses full precision, not previously truncated output strings.
    if recent == '3':
        expected = Decimal(value['evidence']['baseRiskScale']) * Decimal(2) / 3
        assert abs(Decimal(value['riskScale']) - expected) < Decimal('1e-12')


def test_volatility_floor_is_applied_after_full_precision_multiplication():
    plan = minute_plan()
    for book in plan['entryConfirmation']['orderFlow']['books']:
        for price_quantity in book['asks']:
            price_quantity[1] = '.000001'
    c = plan['entryConfirmation']
    value = derive_adaptive_parameters(c['orderFlow'], 'demo', plan['pair'], 'long',
        c['atr15'], c['quotePrice'], '999999', volatility_proof(early_range='0', recent_range='3'))
    assert value['riskScale'] == value['riskBudgetUsdt'] == '0.250000000000'


@pytest.mark.parametrize('fault', ['missing', 'extra', 'short', 'gap', 'partial', 'future', 'fractional',
    'nan', 'numeric', 'negative', 'inverted', 'outside', 'duplicate', 'row_extra', 'boundary_unaligned'])
def test_volatility_raw_rows_reject_incomplete_or_malformed_inputs(fault):
    proof = volatility_proof()
    if fault == 'missing':
        del proof['version']
    elif fault == 'extra':
        proof['forged'] = True
    elif fault == 'short':
        proof['candles'].pop(0)
    elif fault == 'gap':
        proof['candles'][7]['openTime'] -= 300000
    elif fault == 'partial':
        proof['candles'][-1]['closeTime'] += 1
    elif fault == 'future':
        proof['candles'][-1]['openTime'] += 300000
    elif fault == 'fractional':
        proof['candles'][0]['openTime'] = float(proof['candles'][0]['openTime'])
    elif fault == 'nan':
        proof['candles'][0]['high'] = 'NaN'
    elif fault == 'numeric':
        proof['candles'][0]['high'] = 101
    elif fault == 'negative':
        proof['candles'][0]['low'] = '-1'
    elif fault == 'inverted':
        proof['candles'][0]['high'] = '99'
    elif fault == 'outside':
        proof['candles'][0]['close'] = '999'
    elif fault == 'duplicate':
        proof['candles'][1] = copy.deepcopy(proof['candles'][0])
    elif fault == 'row_extra':
        proof['candles'][0]['volume'] = '1'
    else:
        proof['candleBoundary'] += 1
    with pytest.raises(FlowValidationError):
        profile(proof)


@pytest.mark.parametrize('legacy', [False, True])
def test_both_current_and_retained_minute_contracts_authorize(frozen, legacy):
    plan = minute_plan(legacy=legacy)
    advance(frozen, 120000)
    exchange = fake_exchange()
    assert authorize(exchange, plan)
    with guard.order_context(exchange, **kwargs(plan)):
        wire(exchange, plan)


@pytest.mark.parametrize('fault', ['missing', 'legacy_under_current', 'current_under_legacy', 'wrong_boundary', 'forged_base', 'forged_multiplier'])
def test_native_v12_binds_new_profile_and_recomputes_closed_evidence(frozen, fault):
    plan = minute_plan()
    advance(frozen, 120000)
    if fault == 'missing':
        del plan['adaptiveParameters']['inputs']['volatility']
    elif fault == 'legacy_under_current':
        old = minute_plan(legacy=True)
        plan['adaptiveParameters'] = old['adaptiveParameters']
    elif fault == 'current_under_legacy':
        plan['nativeEntryGuard']['version'] = guard.MINUTE_LEGACY_VERSION
    elif fault == 'wrong_boundary':
        plan['adaptiveParameters']['inputs']['volatility'] = volatility_proof(BOUNDARY - 300000)
        refresh_profile(plan)
    elif fault == 'forged_base':
        plan['adaptiveParameters']['evidence']['baseRiskScale'] = '1.000000000000'
    else:
        plan['adaptiveParameters']['evidence']['volatility']['riskMultiplier'] = '0.999999999999'
    with pytest.raises(ccxt.PermissionDenied, match='ADAPTIVE_IDENTITY'):
        authorize(fake_exchange(), plan)


@pytest.mark.parametrize('stage', ['context', 'wire'])
def test_volatility_is_rederived_at_later_native_boundaries(frozen, stage):
    plan = minute_plan()
    advance(frozen, 120000)
    exchange = fake_exchange()
    assert authorize(exchange, plan)
    if stage == 'context':
        guard._pending.get()['plan']['adaptiveParameters']['inputs']['volatility']['candles'][-1]['high'] = '110'
        with pytest.raises(ccxt.PermissionDenied, match='ADAPTIVE_IDENTITY'):
            with guard.order_context(exchange, **kwargs(plan)):
                pytest.fail('Forged volatility reached context')
    else:
        with guard.order_context(exchange, **kwargs(plan)):
            guard._active.get()['plan']['adaptiveParameters']['inputs']['volatility']['candles'][-1]['high'] = '110'
            with pytest.raises(ccxt.PermissionDenied, match='ADAPTIVE_IDENTITY'):
                wire(exchange, plan)
