"""Real JavaScript bridge plans through native callback/context/pre-wire validation.

No transport is instantiated: JavaScript injects all I/O and Python passes
synthetic exchanges to the real validators. All writes live in temporary roots.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import ccxt
import pytest

from demo_model_guard_support import guard, isolate, fake_exchange
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'freqtrade/strategies'))
from RuleExits import RuleExits, valid_plan

CASES = [('demo', False), ('demo-futures', False), ('demo-futures', True)]


@pytest.fixture(scope='module')
def bridge_plans():
    executable = os.environ.get('BINANCETRADE_NODE')
    if not executable:
        bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        executable = str(bundled) if bundled.is_file() else shutil.which('node')
    assert executable, 'Node is required for the real host/native integration test'
    source = """
import {mock} from 'node:test';
import {buildAiBridgePlan,AI_BRIDGE_TEST_NOW} from './test/bridge-ai-plan-fixture.mjs';
mock.timers.enable({apis:['Date'],now:AI_BRIDGE_TEST_NOW});
try {
 const plans=[];
 for (const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]])
  plans.push(await buildAiBridgePlan({mode,short,kev:'approve'}));
 console.log(JSON.stringify(plans));
} finally { mock.timers.reset(); }
"""
    result = subprocess.run([executable, '--input-type=module', '-e', source], cwd=ROOT,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return {(row['mode'], row['short']): row for row in json.loads(result.stdout)}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    clock = isolate(monkeypatch, tmp_path)
    def no_network(*_args, **_kwargs):
        raise AssertionError('Native contract fixture must not connect to a network')
    monkeypatch.setattr(socket.socket, 'connect', no_network)
    try:
        yield clock
    finally:
        guard.clear_entry_permit()


def setup(bridge_plans, case, clock):
    f = copy.deepcopy(bridge_plans[case])
    clock.update(wall=f['now'], mono=100000.0)
    return f, fake_exchange(f['mode'])


def authorize(f, exchange):
    return guard.authorize_entry(exchange, f['plan'], f['mode'], f['pair'],
                                 'short' if f['short'] else 'long', f['amount'], f['rate'], 'market')


def context(f, exchange):
    return guard.order_context(exchange, pair=f['pair'], side='sell' if f['short'] else 'buy',
                               amount=f['amount'], rate=f['rate'], leverage=1,
                               reduce_only=False, initial_order=True, order_type='market')


def wire(f, exchange):
    base = 'https://demo-api.binance.com/api/v3/order' if f['mode'] == 'demo' else 'https://demo-fapi.binance.com/fapi/v1/order'
    body = 'symbol=ETHUSDT&side=' + ('SELL' if f['short'] else 'BUY') + '&type=MARKET&quantity=0.1'
    guard.guard_order_wire(exchange, base, 'POST', body)


@pytest.mark.parametrize('case', CASES)
def test_actual_bridge_plan_reaches_callback_context_and_wire(bridge_plans, isolated, monkeypatch, case):
    f, exchange = setup(bridge_plans, case, isolated)
    plan = f['plan']
    assert f['snapshotCadence']['decisionIntervalMs'] == 60000
    assert not set(('decisionCadenceVersion', 'decisionIntervalMs', 'decisionBoundary', 'adaptiveParameters')) & plan.keys()
    assert plan['nativeEntryGuard']['modelDeadline'] == f['boundary'] + 60000
    assert plan['entryEvidence']['kevReview']['provider'] == 'codex-cli'
    assert plan['entryEvidence']['kevReview']['decision']['approved'] is True
    assert int(datetime.fromisoformat(plan['entryEvidence']['kevReview']['expiresAt'].replace('Z', '+00:00')).timestamp()*1000) == plan['nativeEntryGuard']['modelDeadline']
    assert plan['riskPolicy']['reserveFraction'] == ('0.005' if f['mode'] == 'demo' else '0')
    assert plan['riskBudgetUsdt'] == 1 and plan['stopFraction'] == .02
    assert plan['entryConfirmation']['priceConfirmation']['eligible'] is False
    assert valid_plan(plan, f['pair'], f['short'], plan['tag']) is plan
    # Count the unchanged shared validator at actual public call boundaries.
    calls = []
    original = guard._validate
    def observed(permit, now, mono):
        calls.append(permit['plan']['snapshotId'])
        return original(permit, now, mono)
    monkeypatch.setattr(guard, '_validate', observed)
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot' if f['mode'] == 'demo' else 'futures'}
    strategy.dp = SimpleNamespace(_exchange=exchange)
    strategy._entry_plan = lambda *_args: plan
    assert strategy.entry_risk_allowed(pair=f['pair'], order_type='market', amount=f['amount'],
        rate=f['rate'], time_in_force='GTC', current_time=datetime.fromtimestamp(f['now']/1000, timezone.utc),
        entry_tag=plan['tag'], side='short' if f['short'] else 'long')
    assert len(calls) == 1
    with context(f, exchange) as state:
        assert len(calls) == 2
        wire(f, exchange)
        assert len(calls) == 3 and state['wireSent'] is True
        with pytest.raises(ccxt.PermissionDenied, match='WIRE_CONTEXT_REQUIRED'):
            wire(f, exchange)
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
        with context(f, exchange):
            pytest.fail('consumed callback grant cannot be reused')


def fault(plan, clock, f, name):
    if name == 'deadline':
        elapsed = f['boundary'] + 60000 - clock['wall']
        clock['wall'] += elapsed
        clock['mono'] += elapsed
    elif name == 'model_pin':
        plan['model']['modelFingerprint'] = 'f' * 64
    elif name == 'forecast_cost':
        target = '99.99' if f['short'] else '100.02'
        for proof in (plan['nativeEntryGuard'], plan['entryConfirmation']):
            proof['forecastClose'] = target
            proof['forecastCloses'] = [target] * 3
    elif name == 'risk':
        plan['riskBudgetUsdt'] = 2
    elif name == 'source':
        plan['nativeEntryGuard']['clock']['source'] = 'https://api.binance.com/api/v3/time'
    elif name == 'cadence':
        plan.update(f['snapshotCadence'])
    elif name == 'mode_stop':
        target = guard.ROOT / 'local' / f['mode'] / 'STOP'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('offline fixture', encoding='utf-8')
    else:
        raise AssertionError(name)


FAULTS = [('deadline', 'DEADLINE'), ('model_pin', 'GUARD_IDENTITY'),
          ('forecast_cost', 'FORECAST_COST_SHORTFALL'), ('risk', 'RISK_BUDGET'),
          ('source', 'CLOCK_INVALID'), ('cadence', 'GUARD_IDENTITY'), ('mode_stop', 'STOPPED')]


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('stage', ['callback', 'context', 'wire'])
@pytest.mark.parametrize('name,reason', FAULTS)
def test_real_bridge_plan_still_rejects_at_every_native_boundary(
        bridge_plans, isolated, case, stage, name, reason):
    f, exchange = setup(bridge_plans, case, isolated)
    if stage == 'callback':
        fault(f['plan'], isolated, f, name)
        with pytest.raises(ccxt.PermissionDenied, match=reason):
            authorize(f, exchange)
        assert guard._pending.get() is None
        return
    assert authorize(f, exchange)
    if stage == 'context':
        fault(guard._pending.get()['plan'], isolated, f, name)
        with pytest.raises(ccxt.PermissionDenied, match=reason):
            with context(f, exchange):
                pytest.fail('invalid context reached wire stage')
        assert guard._pending.get() is None
        return
    with context(f, exchange) as state:
        fault(state['plan'], isolated, f, name)
        with pytest.raises(ccxt.PermissionDenied, match=reason):
            wire(f, exchange)
        assert state['wireSent'] is False
