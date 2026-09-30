"""Prospective fee-aware exits and three native entry gates, entirely offline."""
import copy
import json
import socket
import subprocess
import sys
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import ccxt
import pytest
from freqtrade.enums import TradingMode

from demo_model_guard_support import guard, isolate, fake_exchange
from test_kev_order_flow_native import plan as entry_plan, authorize, context, wire, write_json
from test_rule_exit_profiles import fixture
from RuleExits import ENTRY_RULE_VERSION, TRAILING_KEY, valid_plan

POLICY = dict(guard.KEV_NET_HARVEST_POLICY)
CASES = [(False, False), (True, False), (True, True)]


def harvest_fixture(futures=False, short=False, policy=True):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, futures)
    trade.is_short = plan['isShort'] = short
    trade.funding_fees = 0 if futures else None
    trade.fee_open, trade.fee_close = .001, .001
    trade.recalc_open_trade_value()
    plan.pop('atrTimeframe', None)
    plan.update(ruleVersion='kev-order-flow-v1', entryPolicyVersion='kev-order-flow-v1', entrySignalEngine='kev_order_flow',
                purpose='strategy', timeframe='order-flow', stopFraction=.005, targetFraction=.015,
                maxHoldingSeconds=900, maxHoldingBars=0)
    if policy:
        plan['exitPolicy'] = dict(POLICY)
    assert valid_plan(plan, trade.pair, short, trade.enter_tag) is plan
    return strategy, trade, plan, now


def quote_for_reserved_net(trade, target):
    # Solve the actual installed engine's accounting, as independent trail
    # tests do, and then reverse only the future exit slippage reserve.
    intercept = trade.calc_close_trade_value(0)
    slope = trade.amount * (1 + trade.fee_close if trade.is_short else 1 - trade.fee_close)
    rate = (trade.open_trade_value - intercept + (-target if trade.is_short else target)) / slope
    return rate / (1.0005 if trade.is_short else .9995)


@pytest.mark.parametrize('futures,short', CASES)
@pytest.mark.parametrize('age,target,expected', [
    (299.999, 1.00001, None), (300, 1.00001, 'rules_net_harvest_1usdt'),
    (599.999, 1.00001, 'rules_net_harvest_1usdt'), (599.999, .10001, None),
    (600, .10001, 'rules_net_harvest_10bps'), (899.999, .10001, 'rules_net_harvest_10bps'),
    (900, -.1, 'rules_time')])
def test_exact_time_windows_use_engine_net_after_one_adverse_exit_leg(futures, short, age, target, expected):
    strategy, trade, plan, now = harvest_fixture(futures, short)
    before = copy.deepcopy(plan)
    rate = quote_for_reserved_net(trade, target)
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=age), rate, 99) == expected
    assert plan == before


@pytest.mark.parametrize('futures,short', CASES)
def test_fees_funding_and_slippage_are_not_charged_twice_and_stake_is_not_the_basis(futures, short):
    strategy, trade, plan, now = harvest_fixture(futures, short)
    trade.amount, trade.fee_open, trade.fee_close = 1.37, .0003, .0007
    trade.funding_fees = -.11 if futures else None
    trade.stake_amount, trade.leverage = 13.7, 10
    trade.recalc_open_trade_value()
    target = trade.amount * trade.open_rate * .001
    low = quote_for_reserved_net(trade, target-.00001)
    high = quote_for_reserved_net(trade, target+.00001)
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), low, 99) is None
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), high, -99) == 'rules_net_harvest_10bps'
    # A quote that barely crosses the unreserved hurdle still waits.
    unreserved = high * (1.0005 if short else .9995)
    assert trade.calculate_profit(unreserved).profit_abs > target
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), unreserved, 99) is None


@pytest.mark.parametrize('futures,short', CASES)
def test_gross_target_never_becomes_harder_and_old_plans_keep_original_behavior(futures, short):
    strategy, trade, plan, now = harvest_fixture(futures, short)
    trade.amount = .5
    trade.recalc_open_trade_value()
    rate = 98.49 if short else 101.51
    assert trade.calculate_profit(rate).profit_abs < 1
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=400), rate, 0) == 'rules_target'
    # Preserve the original reason precedence when target and cap coincide.
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), rate, 0) == 'rules_target'
    plan.pop('exitPolicy')
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), rate, 0) == 'rules_target'
    rate = quote_for_reserved_net(trade, .06001)
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), rate, 99) is None


@pytest.mark.parametrize('futures,short', CASES)
def test_stop_and_persisted_trail_keep_priority_over_harvest_and_cap(futures, short):
    strategy, trade, plan, now = harvest_fixture(futures, short)
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), 101 if short else 99, 0) == 'rules_stop'
    peak_rate = quote_for_reserved_net(trade, .7)
    strategy._trailing_stop(trade, now+timedelta(seconds=600), peak_rate)
    saved = copy.deepcopy(trade.get_custom_data(TRAILING_KEY))
    assert saved['peakNetUsdt'] == pytest.approx(trade.calculate_profit(peak_rate).profit_abs)
    assert saved['protectedNetUsdt'] == pytest.approx(saved['peakNetUsdt']-.25)
    trade.stop_loss = saved['stopPrice']
    strategy._trailing_stop(trade, now+timedelta(seconds=605), peak_rate)
    assert trade.get_custom_data(TRAILING_KEY) == saved
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), saved['stopPrice'], 0) == 'rules_profit_trail'


@pytest.mark.parametrize('field,value', [('fee_close', None), ('fee_open', float('nan')), ('amount', 0),
    ('funding_fees', None), ('funding_fees', float('nan')), ('open_trade_value', 0)])
def test_unknown_accounting_never_becomes_zero_or_disables_stop_and_cap(field, value):
    strategy, trade, plan, now = harvest_fixture(True, False)
    paused = []
    strategy.dp._exchange._pause_entries = paused.append
    setattr(trade, field, value)
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), 100.5, 99) is None
    assert paused == ['KEV_NET_HARVEST_ACCOUNTING_INVALID']
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), 100, 99) == 'rules_time'
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), 99, 99) == 'rules_stop'


@pytest.mark.parametrize('policy', [None, {}, {'version':'unknown'}, {**POLICY,'lateNetBps':'0'},
    {**POLICY,'exitSlippageBps':5}, {**POLICY,'keepFixedGrossTarget':1}, {**POLICY,'extra':True}])
def test_corrupt_optional_persisted_policy_pauses_entries_without_disabling_core_exits(policy):
    strategy, trade, plan, now = harvest_fixture()
    plan['exitPolicy'] = policy
    paused = []
    strategy.dp._exchange._pause_entries = paused.append
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=600), 100.5, 99) is None
    assert paused == ['KEV_NET_HARVEST_POLICY_INVALID']
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), 100, 99) == 'rules_time'
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), 99, 99) == 'rules_stop'


@pytest.mark.parametrize('rate,expected', [(100, 'rules_time'), (102, 'rules_target')])
def test_failure_to_write_pause_marker_does_not_suppress_the_original_exit(caplog, rate, expected):
    strategy, trade, plan, now = harvest_fixture()
    plan['exitPolicy'] = None
    def fail_pause(_reason):
        raise OSError('synthetic STOP write failure')
    strategy.dp._exchange._pause_entries = fail_pause
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(seconds=900), rate, 99) == expected
    assert 'KEV_NET_HARVEST_PAUSE_FAILED' in caplog.text


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    clock = isolate(monkeypatch, tmp_path)
    monkeypatch.setattr(socket.socket, 'connect', lambda *_a, **_kw: pytest.fail('No network permitted'))
    yield clock
    guard.clear_entry_permit()


def approved_harvest_plan(root, short=False):
    value = entry_plan(root, short)
    value['exitPolicy'] = dict(POLICY)
    path = root / 'local' / value['nativeEntryGuard']['mode'] / 'runs' / (value['snapshotId']+'.kev-review.json')
    review = json.loads(path.read_text())
    state = review['request']['state']
    state.update(requestVersion='kev-flow-request-v4', exitPolicy=dict(POLICY))
    state['candidates'][0]['exitPolicyVersion'] = POLICY['version']
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(path, review)
    return value, path


@pytest.mark.parametrize('short', [False, True])
def test_exact_policy_passes_native_callback_context_wire(isolated, tmp_path, short):
    value, _ = approved_harvest_plan(tmp_path, short)
    exchange = fake_exchange(value['nativeEntryGuard']['mode'])
    assert authorize(exchange, value)
    with context(exchange, value):
        wire(exchange, value)


@pytest.mark.parametrize('phase', ['callback', 'context', 'wire'])
@pytest.mark.parametrize('damage', ['plan', 'state', 'candidate', 'missing_state', 'missing_candidate', 'v3', 'slippage_config'])
def test_policy_binding_rechecked_at_every_native_boundary(isolated, tmp_path, phase, damage):
    value, path = approved_harvest_plan(tmp_path)
    exchange = fake_exchange()
    def mutate(active_plan):
        if damage == 'plan':
            active_plan['exitPolicy']['lateNetBps'] = '0'
        elif damage == 'slippage_config':
            cost = json.loads((tmp_path/'config/costs.json').read_text())
            cost['slippageBpsPerSide'] = 10
            write_json(tmp_path/'config/costs.json', cost)
        else:
            review = json.loads(path.read_text())
            state = review['request']['state']
            if damage == 'state': state['exitPolicy']['middleNetUsdt'] = '2'
            elif damage == 'candidate': state['candidates'][0]['exitPolicyVersion'] = 'other'
            elif damage == 'missing_state': del state['exitPolicy']
            elif damage == 'missing_candidate': del state['candidates'][0]['exitPolicyVersion']
            else: state['requestVersion'] = 'kev-flow-request-v3'
            # Rebind raw bytes so this tests semantic policy identity, not just
            # the already-covered immutable review checksum rejection.
            active_plan['nativeEntryGuard']['kevReviewSha256'] = write_json(path, review)
    if phase == 'callback':
        mutate(value)
        with pytest.raises(ccxt.PermissionDenied, match='KEV_EXIT_'): authorize(exchange, value)
    else:
        assert authorize(exchange, value)
        if phase == 'context':
            mutate(guard._pending.get()['plan'])
            with pytest.raises(ccxt.PermissionDenied, match='KEV_EXIT_'):
                with context(exchange, value): pass
        else:
            with context(exchange, value):
                mutate(guard._active.get()['plan'])
                with pytest.raises(ccxt.PermissionDenied, match='KEV_EXIT_'): wire(exchange, value)


@pytest.mark.parametrize('damage', ['state_null', 'candidate_null', 'v4_missing_policy'])
def test_absent_legacy_policy_is_not_equivalent_to_null_or_unbound_new_request(isolated, tmp_path, damage):
    value = entry_plan(tmp_path)
    path = tmp_path/'local/demo/runs'/(value['snapshotId']+'.kev-review.json')
    review = json.loads(path.read_text()); state = review['request']['state']
    if damage == 'state_null': state['exitPolicy'] = None
    elif damage == 'candidate_null': state['candidates'][0]['exitPolicyVersion'] = None
    else: state['requestVersion'] = 'kev-flow-request-v4'
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(path, review)
    with pytest.raises(ccxt.PermissionDenied, match='KEV_EXIT_POLICY_REVIEW'): authorize(fake_exchange(), value)


def test_immutable_new_policy_and_legacy_absence_survive_real_sqlite_reload(tmp_path):
    code = '''
import sys
from datetime import timedelta
sys.path.insert(0,'test')
from test_kev_net_harvest import harvest_fixture, quote_for_reserved_net
from freqtrade.persistence import Trade, init_db
db='sqlite:///'+sys.argv[1]
init_db(db)
for enabled in (False,True):
 s,t,p,now=harvest_fixture(policy=enabled)
 del t.get_custom_data; del t.set_custom_data
 Trade.session.add(t); Trade.commit()
 t.set_custom_data(key='rule_plan',value=p); Trade.commit(); key=t.id
 Trade.session.remove(); init_db(db)
 restored=Trade.session.get(Trade,key)
 s2,_,_,_=harvest_fixture(policy=not enabled)
 rate=quote_for_reserved_net(restored,.10001)
 result=s2.custom_exit(restored.pair,restored,now+timedelta(seconds=600),rate,99)
 assert result==('rules_net_harvest_10bps' if enabled else None)
 assert restored.get_custom_data(key='rule_plan')==p
 Trade.session.remove()
print('persisted')
'''
    result = subprocess.run([sys.executable,'-c',code,str(tmp_path/'harvest.sqlite')], capture_output=True,
        text=True, timeout=30, creationflags=0x08000000 if sys.platform=='win32' else 0)
    assert result.returncode == 0, result.stderr
    assert 'persisted' in result.stdout
