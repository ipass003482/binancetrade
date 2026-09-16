"""Offline minute deadlines and deterministic adaptive native entry enforcement."""
import copy
import json
import subprocess
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import ccxt
import pytest
from demo_model_guard_support import guard, isolate, fake_exchange, MS, BOUNDARY
from test_demo_model_guard import flow_only_plan, authorize, advance
from demo_order_flow import derive_adaptive_parameters, validate_flow, FlowValidationError
from RuleExits import RuleExits, valid_plan

ROOT = Path(__file__).resolve().parents[1]
NODE = Path('C:/Users/wuyaote/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    return isolate(monkeypatch, tmp_path)


def volatility_proof(boundary=BOUNDARY, early_range='1', recent_range='1'):
    rows = []
    for i in range(15):
        half = Decimal(recent_range if i >= 8 else early_range) / 2
        opened = boundary - (15 - i) * 300000
        rows.append(dict(openTime=opened, closeTime=opened+299999,
                         high=str(Decimal(100)+half), low=str(Decimal(100)-half), close='100'))
    return dict(version='closed5m-volatility-v1', candleBoundary=boundary, candles=rows)


def refresh_profile(plan):
    confirmation = plan['entryConfirmation']
    proof = confirmation['orderFlow']
    plan['entryEvidence']['proofSha256'] = sha256(json.dumps(proof, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    volatility = None
    if plan['nativeEntryGuard']['version'] == guard.VERSION:
        volatility = plan.get('adaptiveParameters', {}).get('inputs', {}).get('volatility') or volatility_proof()
    profile = derive_adaptive_parameters(proof, 'demo-futures' if plan['isShort'] else 'demo', plan['pair'],
        'short' if plan['isShort'] else 'long', confirmation['atr15'], confirmation['quotePrice'],
        str(Decimal(str(plan['riskCostFraction'])) * 10000), volatility)
    plan['adaptiveParameters'] = profile
    plan['riskBudgetUsdt'] = float(profile['riskBudgetUsdt'])
    return profile


def minute_plan(short=False, minute=2, legacy=False):
    plan = flow_only_plan(short)
    shift = minute * 60000
    now = MS + shift
    guard_value = plan['nativeEntryGuard']
    fields = dict(decisionCadenceVersion='flow-minute-v1', decisionIntervalMs=60000, decisionBoundary=BOUNDARY+shift)
    plan.update(fields)
    guard_value.update(fields)
    guard_value.update(version=guard.MINUTE_LEGACY_VERSION if legacy else guard.VERSION, entryDeadline=BOUNDARY+shift+60000)
    snapshot = f'11111111-1111-4111-8111-{minute+1:012d}'
    plan['snapshotId'] = guard_value['snapshotId'] = plan['entryEvidence']['snapshotId'] = snapshot
    plan['tag'] = 'codex-' + sha256(snapshot.encode()).hexdigest()[:32]
    plan['createdAt'] = guard_value['quoteFetchedAt'] = datetime.fromtimestamp(now/1000, timezone.utc).isoformat()
    for key in ('serverTime', 'requestStartedAt', 'receivedAt'):
        guard_value['clock'][key] += shift
    proof = plan['entryConfirmation']['orderFlow']
    for book in proof['books']:
        book['at'] += shift
    for trade in proof['trades']:
        trade['T'] += shift
    proof['startTime'] += shift
    proof['endTime'] += shift
    refresh_profile(plan)
    return plan


def kwargs(plan):
    return dict(pair=plan['pair'], side='sell' if plan['isShort'] else 'buy', amount=.25, rate=100,
                leverage=1, reduce_only=False, initial_order=True, order_type='market')


def wire(exchange, plan):
    host = 'https://demo-fapi.binance.com/fapi/v1/order' if plan['isShort'] else 'https://demo-api.binance.com/api/v3/order'
    guard.guard_order_wire(exchange, host, 'POST', 'symbol=ETHUSDT&side='+('SELL' if plan['isShort'] else 'BUY')+'&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('minute', [1, 2, 4])
def test_fresh_decision_minutes_reuse_completed_five_minute_candle_with_new_native_permit(frozen, short, minute):
    plan = minute_plan(short, minute)
    advance(frozen, minute*60000)
    exchange = fake_exchange('demo-futures' if short else 'demo')
    assert plan['nativeEntryGuard']['candleBoundary'] == BOUNDARY
    assert plan['entryConfirmation']['confirmationAt'] == BOUNDARY
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'futures' if short else 'spot', 'dry_run': False}
    strategy.dp = SimpleNamespace(_exchange=exchange)
    strategy._entry_plan = lambda *args: copy.deepcopy(plan)
    assert strategy.entry_risk_allowed(pair=plan['pair'], order_type='market', amount=.25, rate=100,
        time_in_force='GTC', current_time=datetime.fromtimestamp(frozen['wall']/1000, timezone.utc),
        entry_tag=plan['tag'], side='short' if short else 'long')
    with guard.order_context(exchange, **kwargs(plan)):
        wire(exchange, plan)
    # A persisted adaptive exit keeps its entry-time budget after the minute.
    advance(frozen, 60000)
    persisted = copy.deepcopy(plan)
    persisted.pop('nativeEntryGuard')
    assert valid_plan(persisted, plan['pair'], short, plan['tag']) is persisted


@pytest.mark.parametrize('stage', ['callback', 'context', 'wire'])
def test_decision_minute_deadline_is_exclusive_at_all_three_boundaries(frozen, stage):
    plan = minute_plan()
    advance(frozen, 120000)
    exchange = fake_exchange()
    if stage == 'callback':
        advance(frozen, 39995)  # Upper exchange-clock offset is +10ms.
        with pytest.raises(ccxt.PermissionDenied, match='DEADLINE'):
            authorize(exchange, plan)
    elif stage == 'context':
        assert authorize(exchange, plan)
        advance(frozen, 39995)
        with pytest.raises(ccxt.PermissionDenied, match='DEADLINE'):
            with guard.order_context(exchange, **kwargs(plan)):
                pytest.fail('Expired permit reached context')
    else:
        assert authorize(exchange, plan)
        with guard.order_context(exchange, **kwargs(plan)):
            advance(frozen, 39995)
            with pytest.raises(ccxt.PermissionDenied, match='DEADLINE'):
                wire(exchange, plan)


@pytest.mark.parametrize('fault', ['missing_profile', 'missing_guard_minute', 'missing_plan_minute', 'wrong_interval',
    'future_candle', 'old_confirmation', 'clock_from_prior_minute', 'created_before_minute', 'fractional_plan_minute'])
def test_minute_and_completed_candle_identity_cannot_be_forged(frozen, fault):
    plan = minute_plan()
    advance(frozen, 120000)
    if fault == 'missing_profile':
        del plan['adaptiveParameters']
    elif fault == 'missing_guard_minute':
        del plan['nativeEntryGuard']['decisionBoundary']
    elif fault == 'missing_plan_minute':
        del plan['decisionBoundary']
    elif fault == 'wrong_interval':
        plan['decisionIntervalMs'] = plan['nativeEntryGuard']['decisionIntervalMs'] = 300000
    elif fault == 'future_candle':
        plan['nativeEntryGuard']['candleBoundary'] += 300000
    elif fault == 'old_confirmation':
        plan['entryConfirmation']['confirmationAt'] -= 300000
    elif fault == 'clock_from_prior_minute':
        for key in ('serverTime', 'requestStartedAt', 'receivedAt'):
            plan['nativeEntryGuard']['clock'][key] -= 30000
    elif fault == 'created_before_minute':
        plan['createdAt'] = datetime.fromtimestamp((plan['decisionBoundary']-1)/1000, timezone.utc).isoformat()
    else:
        plan['decisionBoundary'] = float(plan['decisionBoundary'])
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), plan)


@pytest.mark.parametrize('field', ['adaptiveParameters', 'decisionCadenceVersion', 'decisionIntervalMs', 'decisionBoundary'])
def test_legacy_version_cannot_carry_partial_new_contract(frozen, field):
    legacy = flow_only_plan()
    legacy[field] = minute_plan()[field]
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), legacy)


def test_scaled_native_stress_budget_rejects_order_that_old_one_usdt_budget_would_allow(frozen):
    plan = minute_plan()
    advance(frozen, 120000)
    plan['maxEntryNotionalUsdt'] = 100
    assert Decimal(plan['adaptiveParameters']['riskBudgetUsdt']) < Decimal('.85') < 1
    with pytest.raises(ccxt.PermissionDenied, match='RISK_BUDGET'):
        authorize(fake_exchange(), plan, amount=.5)


@pytest.mark.parametrize('stage', ['context', 'wire'])
def test_adaptive_profile_rederived_after_callback_and_cannot_raise_budget(frozen, stage):
    plan = minute_plan()
    advance(frozen, 120000)
    exchange = fake_exchange()
    assert authorize(exchange, plan)
    if stage == 'context':
        guard._pending.get()['plan']['riskBudgetUsdt'] = 1
        with pytest.raises(ccxt.PermissionDenied, match='ADAPTIVE_IDENTITY'):
            with guard.order_context(exchange, **kwargs(plan)):
                pytest.fail('Mutated budget reached context')
    else:
        with guard.order_context(exchange, **kwargs(plan)):
            guard._active.get()['plan']['adaptiveParameters']['evidence']['spreadPressure'] = '0.000000000000'
            with pytest.raises(ccxt.PermissionDenied, match='ADAPTIVE_IDENTITY'):
                wire(exchange, plan)


def test_adaptive_share_and_buffer_can_only_tighten_original_floor(frozen):
    plan = minute_plan()
    advance(frozen, 120000)
    profile = plan['adaptiveParameters']
    assert Decimal(profile['minTakerShare']) > Decimal('.55')
    assert Decimal(profile['costBufferBps']) > 30
    plan['nativeEntryGuard']['requiredPriceSpaceBps'] = '50'
    with pytest.raises(ccxt.PermissionDenied, match='COST_BUFFER_IDENTITY'):
        authorize(fake_exchange(), plan)
    plan = minute_plan()
    tape = plan['entryConfirmation']['orderFlow']['trades']
    for trade, quantity, maker in zip(tape, ['.275', '.275', '.45'], [False, False, True]):
        trade['q'], trade['m'] = quantity, maker
    refresh_profile(plan)
    assert validate_flow(plan['entryConfirmation']['orderFlow'], 'demo', plan['pair'], 'long', frozen['wall'])
    with pytest.raises(ccxt.PermissionDenied, match='FLOW_EVIDENCE'):
        authorize(fake_exchange(), plan)
    with pytest.raises(FlowValidationError):
        validate_flow(plan['entryConfirmation']['orderFlow'], 'demo', plan['pair'], 'long', frozen['wall'], '.549')


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('cost', ['20', '19.31776925979623'])
@pytest.mark.parametrize('legacy', [False, True])
def test_host_native_adaptive_profile_exact_decimal_parity(short, cost, legacy):
    if not NODE.is_file():
        pytest.skip('Bundled Node runtime unavailable')
    plan = minute_plan(short, legacy=legacy)
    c = plan['entryConfirmation']
    args = dict(mode='demo-futures' if short else 'demo', long=not short, proof=c['orderFlow'], atr15=c['atr15'],
                quotePrice=c['quotePrice'], estimatedRoundTripCostBps=cost)
    volatility = None if legacy else volatility_proof()
    if volatility is not None:
        args['volatility'] = volatility
    source = "import {deriveAdaptiveParameters} from './src/adaptive-parameters.mjs';let s='';for await(const x of process.stdin)s+=x;process.stdout.write(JSON.stringify(deriveAdaptiveParameters(JSON.parse(s))));"
    result = subprocess.run([str(NODE), '--input-type=module', '-e', source], input=json.dumps(args), cwd=ROOT,
                            capture_output=True, text=True, timeout=15, check=True)
    profile = json.loads(result.stdout)
    assert profile == derive_adaptive_parameters(c['orderFlow'], args['mode'], plan['pair'],
        'short' if short else 'long', c['atr15'], c['quotePrice'], cost, volatility)
    plan['riskCostFraction'] = float(Decimal(cost) / 10000)
    plan['adaptiveParameters'] = profile
    plan['riskBudgetUsdt'] = float(profile['riskBudgetUsdt'])
    assert guard._adaptive(plan, c, args['mode'], plan['pair'], 'short' if short else 'long') == profile
