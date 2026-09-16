"""v10/v11 monetary trail through installed Freqtrade accounting, rounding and ORM."""
import json
import subprocess
import sys
from datetime import timedelta

import pytest
from RuleExits import ENTRY_RULE_VERSION, TRAILING_RULE_VERSIONS, TRAILING_KEY, TRAILING_POLICY, BREAKEVEN_KEY, valid_plan
from test_rule_exit_profiles import fixture
from test_breakeven import adjust


@pytest.mark.parametrize('futures,short', [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize('leverage', [1, 3])
@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_trail_uses_actual_net_peak_and_retains_floor_on_retrace(futures, short, leverage, version):
    strategy, trade, plan, now = fixture(version, futures)
    trade.is_short = plan['isShort'] = short
    trade.leverage, trade.stake_amount = leverage, 100 / leverage
    trade.recalc_open_trade_value()
    adjust(strategy, trade, now, 99.5 if short else 100.5)
    assert trade.get_custom_data(TRAILING_KEY) is None  # gross .5 is not net .5
    for seconds, rate in [(5, 99.29 if short else 100.71), (10, 98.8 if short else 101.2)]:
        adjust(strategy, trade, now + timedelta(seconds=seconds), rate)
        state = trade.get_custom_data(TRAILING_KEY)
        assert state['ruleVersion'] == version
        assert state['peakNetUsdt'] == pytest.approx(trade.calculate_profit(rate).profit_abs)
        assert state['protectedNetUsdt'] == pytest.approx(state['peakNetUsdt'] - .25)
        assert trade.stop_loss == pytest.approx(state['stopPrice'])
        assert trade.calculate_profit(trade.stop_loss).profit_abs >= state['protectedNetUsdt'] - 1e-8
        worse = trade.stop_loss + .01 if short else trade.stop_loss - .01
        assert trade.calculate_profit(worse).profit_abs < state['protectedNetUsdt']
    saved = dict(state)
    adjust(strategy, trade, now + timedelta(seconds=15), 99.7 if short else 100.3, after_fill=True)
    assert trade.get_custom_data(TRAILING_KEY) == saved
    assert trade.stop_loss == saved['stopPrice']
    assert trade.get_custom_data(BREAKEVEN_KEY) is None
    assert strategy.custom_exit(trade.pair, trade, now, 100, 0) == 'rules_profit_trail'


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('funding', [-.15, .15])
def test_trail_solves_fee_and_funding_adjusted_floor_without_loosening(short, funding):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, True)
    trade.is_short = plan['isShort'] = short
    trade.amount, trade.fee_open, trade.fee_close, trade.funding_fees = 1.37, .0003, .0004, funding
    trade.recalc_open_trade_value()
    rate = 99 if short else 101
    adjust(strategy, trade, now, rate)
    initial = trade.stop_loss
    target = trade.get_custom_data(TRAILING_KEY)['protectedNetUsdt']
    trade.funding_fees -= .2
    adjust(strategy, trade, now + timedelta(seconds=5), rate)
    assert trade.calculate_profit(trade.stop_loss).profit_abs >= target - 1e-8
    assert trade.stop_loss < initial if short else trade.stop_loss > initial
    tightened = trade.stop_loss
    trade.funding_fees += .4
    adjust(strategy, trade, now + timedelta(seconds=10), rate, after_fill=True)
    assert trade.stop_loss <= tightened if short else trade.stop_loss >= tightened


@pytest.mark.parametrize('short', [False, True])
def test_same_quote_does_not_move_one_tick_per_loop_and_new_peak_is_persisted(short):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, short)
    trade.amount = .999
    trade.recalc_open_trade_value()
    rate = 99 if short else 101
    adjust(strategy, trade, now, rate)
    original = trade.stop_loss
    for i in range(1, 21):
        adjust(strategy, trade, now + timedelta(seconds=i * 5), rate, after_fill=True)
        assert trade.stop_loss == original
    peak = trade.get_custom_data(TRAILING_KEY)['peakNetUsdt']
    adjust(strategy, trade, now + timedelta(seconds=110), rate + (-.000001 if short else .000001))
    assert trade.get_custom_data(TRAILING_KEY)['peakNetUsdt'] > peak


@pytest.mark.parametrize('field,value', [('fee_close', None), ('amount', 0), ('funding_fees', float('nan')),
                                      ('price_precision', None), ('precision_mode_price', 99)])
def test_accounting_failure_keeps_native_stop_and_pauses(field, value):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION)
    adjust(strategy, trade, now, 101)
    saved, stop = dict(trade.get_custom_data(TRAILING_KEY)), trade.stop_loss
    setattr(trade, field, value)
    paused = []
    strategy.dp._exchange._pause_entries = paused.append
    assert strategy.custom_stoploss(trade.pair, trade, now, 101, .01, after_fill=True) is None
    assert trade.stop_loss == stop and trade.get_custom_data(TRAILING_KEY) == saved
    assert paused == ['PROFIT_TRAIL_EVIDENCE_INVALID']


@pytest.mark.parametrize('change', [{'tag': 'codex-' + '0' * 32}, {'peakNetUsdt': float('nan')},
    {'peakNetUsdt': .4}, {'protectedNetUsdt': -.1}, {'stopPrice': 0}, {'activatedAt': 'bad'}])
def test_corrupt_persisted_state_is_rejected(change):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION)
    adjust(strategy, trade, now, 101)
    trade.set_custom_data(TRAILING_KEY, dict(trade.get_custom_data(TRAILING_KEY), **change))
    paused = []
    strategy.dp._exchange._pause_entries = paused.append
    assert strategy.custom_stoploss(trade.pair, trade, now, 102, .02) is None
    assert paused == ['PROFIT_TRAIL_EVIDENCE_INVALID']


@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_trail_state_cannot_be_relabelled_between_old_and_model_strategy(version):
    strategy, trade, plan, now = fixture(version)
    adjust(strategy, trade, now, 101)
    original = dict(trade.get_custom_data(TRAILING_KEY))
    other_version = next(value for value in TRAILING_RULE_VERSIONS if value != version)
    trade.set_custom_data(TRAILING_KEY, dict(original, ruleVersion=other_version))
    stop = trade.stop_loss
    paused = []
    strategy.dp._exchange._pause_entries = paused.append
    assert strategy.custom_stoploss(trade.pair, trade, now, 102, .02, after_fill=True) is None
    assert trade.stop_loss == stop
    assert paused == ['PROFIT_TRAIL_EVIDENCE_INVALID']


def test_backwards_time_cannot_corrupt_a_persisted_peak():
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION)
    adjust(strategy, trade, now, 101)
    state = dict(trade.get_custom_data(TRAILING_KEY))
    assert strategy.custom_stoploss(trade.pair, trade, now - timedelta(seconds=1), 102, .02) is None
    assert trade.get_custom_data(TRAILING_KEY) == state


@pytest.mark.parametrize('policy', [None, {}, {'version': 'fee-breakeven-v1', 'triggerNetUsdt': .5, 'riskMultiple': .5},
    dict(TRAILING_POLICY, givebackNetUsdt=True), dict(TRAILING_POLICY, givebackNetUsdt=.5)])
@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_trailing_plan_requires_exact_trail_policy(policy, version):
    _, trade, plan, _ = fixture(version)
    plan['profitProtection'] = policy
    assert valid_plan(plan, trade.pair, trade.is_short, trade.enter_tag) is None


@pytest.mark.parametrize('version', ['atr15m-forward-v7', 'atr15m-forward-v8', 'atr15m-forward-v9'])
@pytest.mark.parametrize('short', [False, True])
def test_old_trade_preserves_breakeven_instead_of_inheriting_v10(version, short):
    strategy, trade, plan, now = fixture(version, short)
    before = json.dumps(plan, sort_keys=True)
    adjust(strategy, trade, now, 99 if short else 101)
    stop = trade.stop_loss
    adjust(strategy, trade, now + timedelta(seconds=5), 98 if short else 102)
    assert trade.stop_loss == stop
    assert trade.get_custom_data(TRAILING_KEY) is None
    assert trade.get_custom_data(BREAKEVEN_KEY)['ruleVersion'] == version
    assert json.dumps(plan, sort_keys=True) == before


@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_peak_and_stop_survive_real_sqlite_restart(tmp_path, version):
    code = '''
import sys
from datetime import timedelta
sys.path.insert(0, 'test')
from test_rule_exit_profiles import fixture
from RuleExits import TRAILING_KEY
from freqtrade.persistence import Trade, init_db
db='sqlite:///'+sys.argv[1]
init_db(db)
s,t,p,now=fixture(sys.argv[2])
del t.get_custom_data
del t.set_custom_data
Trade.session.add(t)
Trade.commit()
t.set_custom_data(key='rule_plan',value=p)
s.ft_stoploss_adjust(101,t,now,t.calc_profit_ratio(101),0)
Trade.commit()
key=t.id
before=t.get_custom_data(key=TRAILING_KEY)
Trade.session.remove()
init_db(db)
restored=Trade.session.get(Trade,key)
s2,_,_,_=fixture(sys.argv[2])
s2.ft_stoploss_adjust(100.3,restored,now+timedelta(seconds=5),restored.calc_profit_ratio(100.3),0,after_fill=True)
assert restored.get_custom_data(key=TRAILING_KEY)==before
assert restored.stop_loss==before['stopPrice']
assert restored.get_custom_data(key='rule_plan')==p
Trade.session.remove()
print('persisted')
'''
    result = subprocess.run([sys.executable, '-c', code, str(tmp_path / 'trail.sqlite'), version], capture_output=True,
                            text=True, timeout=30, creationflags=0x08000000 if sys.platform == 'win32' else 0)
    assert result.returncode == 0, result.stderr
    assert 'persisted' in result.stdout


@pytest.mark.parametrize('futures,short', [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize('leverage', [1, 3])
@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_unarmed_atr_stop_is_stable_across_quote_changes_and_after_fill(futures, short, leverage, version):
    strategy, trade, plan, now = fixture(version, futures)
    trade.is_short = plan['isShort'] = short
    trade.open_rate, trade.amount, trade.leverage = 101.7, 1.47, leverage
    trade.fee_open = trade.fee_close = .0004
    plan['stopFraction'] = .0034612036282961924
    trade.recalc_open_trade_value()
    adjust(strategy, trade, now, 101.7)
    initial = trade.stop_loss
    for i in range(1, 401):
        rate = 101.7 + ((i * 7) % 31 - 15) * .01
        assert trade.calculate_profit(rate).profit_abs < .5
        adjust(strategy, trade, now + timedelta(seconds=i*5), rate, after_fill=i%37==0)
        assert trade.get_custom_data(TRAILING_KEY) is None
        assert trade.stop_loss == initial, 'unarmed stop must not ratchet due to float round trips'


@pytest.mark.parametrize('short', [False, True])
def test_existing_tighter_unarmed_stop_is_retained_without_drift_or_loosening(short):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, short)
    trade.stop_loss = 100.1 if short else 99.9
    saved = trade.stop_loss
    for i in range(20):
        adjust(strategy, trade, now + timedelta(seconds=i*5), 100, after_fill=True)
        assert trade.stop_loss == saved
        assert trade.get_custom_data(TRAILING_KEY) is None
