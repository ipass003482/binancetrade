"""Fee-aware v7 behavior through the installed Freqtrade Trade/strategy model."""
import json
import subprocess
import sys
from datetime import timedelta

import pytest
from freqtrade.enums import TradingMode
from RuleExits import ENTRY_RULE_VERSION, BREAKEVEN_KEY, valid_plan
from test_rule_exit_profiles import fixture


def adjust(strategy, trade, now, rate, **kwargs):
    strategy.ft_stoploss_adjust(rate, trade, now, trade.calc_profit_ratio(rate), 0, **kwargs)


@pytest.mark.parametrize('short', [False, True])
def test_v7_open_trade_keeps_its_breakeven_state_and_version_after_v8_upgrade(short):
    strategy, trade, plan, now = fixture('atr15m-forward-v7', short)
    assert valid_plan(plan, trade.pair, trade.is_short, trade.enter_tag) is plan
    adjust(strategy, trade, now, 98 if short else 102)
    state = dict(trade.get_custom_data(BREAKEVEN_KEY))
    assert state['ruleVersion'] == 'atr15m-forward-v7'
    saved_stop = trade.stop_loss
    adjust(strategy, trade, now + timedelta(seconds=5), 99.7 if short else 100.3, after_fill=True)
    assert trade.stop_loss == saved_stop
    assert trade.get_custom_data(BREAKEVEN_KEY) == state
    assert strategy.custom_roi(trade.pair, trade, now, 400, trade.enter_tag, 'short' if short else 'long') is None
    assert strategy.custom_exit(trade.pair, trade, now, 100, 0) == 'rules_breakeven'


@pytest.mark.parametrize('futures,short', [(False, False), (True, False), (True, True)])
@pytest.mark.parametrize('leverage', [1, 3])
def test_trigger_uses_net_dollars_not_gross_or_leveraged_percentage(futures, short, leverage):
    strategy, trade, plan, now = fixture('atr15m-forward-v9', futures)
    trade.is_short = plan['isShort'] = short
    trade.leverage = leverage
    trade.stake_amount = 100 / leverage
    trade.recalc_open_trade_value()
    # 0.5 gross is below 0.5 net after the two fees.
    adjust(strategy, trade, now, 99.5 if short else 100.5)
    assert trade.get_custom_data(BREAKEVEN_KEY) is None
    original = trade.stop_loss
    adjust(strategy, trade, now + timedelta(seconds=5), 99.29 if short else 100.71)
    state = trade.get_custom_data(BREAKEVEN_KEY)
    assert state['observedNetUsdt'] >= .5
    assert state['stopPrice'] == trade.stop_loss == pytest.approx(99.8 if short else 100.21)
    assert trade.calculate_profit(state['stopPrice']).profit_abs >= 0
    assert trade.stop_loss < original if short else trade.stop_loss > original
    # A retrace below the activation profit never disarms or loosens protection.
    adjust(strategy, trade, now + timedelta(seconds=10), 99.7 if short else 100.3, after_fill=True)
    assert trade.stop_loss == state['stopPrice']
    assert trade.get_custom_data(BREAKEVEN_KEY)['activatedAt'] == state['activatedAt']


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('funding', [-.15, .15])
def test_funding_fee_and_actual_quantity_are_in_breakeven(short, funding):
    strategy, trade, plan, now = fixture('atr15m-forward-v9', True)
    trade.is_short = plan['isShort'] = short
    trade.fee_open, trade.fee_close = .0003, .0004
    trade.amount, trade.funding_fees = 1.37, funding
    trade.recalc_open_trade_value()
    adjust(strategy, trade, now, 98 if short else 102)
    protected = trade.stop_loss
    assert trade.calculate_profit(protected).profit_abs >= 0
    # The adjacent tick in the losing direction would no longer cover all fees.
    worse = protected + .01 if short else protected - .01
    assert trade.calculate_profit(worse).profit_abs < 0
    # Additional funding paid after activation tightens; a credit cannot loosen.
    trade.funding_fees -= .2
    adjust(strategy, trade, now + timedelta(seconds=5), 98 if short else 102)
    tightened = trade.stop_loss
    assert tightened < protected if short else tightened > protected
    assert trade.calculate_profit(tightened).profit_abs >= 0
    trade.funding_fees += .4
    adjust(strategy, trade, now + timedelta(seconds=10), 98 if short else 102, after_fill=True)
    assert trade.stop_loss == tightened


def test_spot_fee_adjusted_amount_is_used_without_double_subtracting_fees():
    strategy, trade, plan, now = fixture('atr15m-forward-v9')
    trade.amount = .999  # Engine's reconciled post-fill quantity.
    trade.recalc_open_trade_value()
    adjust(strategy, trade, now, 102)
    state = trade.get_custom_data(BREAKEVEN_KEY)
    assert state['accounting']['amount'] == .999
    assert state['stopPrice'] == pytest.approx(100.21)
    assert trade.calculate_profit(state['stopPrice']).profit_abs >= 0


@pytest.mark.parametrize('short', [False, True])
def test_gap_through_activated_stop_has_native_custom_exit_fallback(short):
    strategy, trade, plan, now = fixture('atr15m-forward-v9', short)
    adjust(strategy, trade, now, 98 if short else 102)
    # Simulate restarting with state persisted but a stale native stop.
    trade.stop_loss = 101 if short else 99
    exits = strategy.should_exit(trade, 100, now + timedelta(seconds=5), enter=False, exit_=False)
    assert exits[0].exit_reason == 'rules_breakeven'


@pytest.mark.parametrize('field,value', [('fee_close', None), ('fee_open', float('nan')),
    ('amount', 0), ('funding_fees', float('nan')), ('price_precision', None),
    ('precision_mode_price', 99), ('trading_mode', TradingMode.MARGIN)])
def test_bad_accounting_preserves_existing_stop_and_pauses_new_entries(field, value):
    strategy, trade, plan, now = fixture('atr15m-forward-v9')
    adjust(strategy, trade, now, 100)
    prior = trade.stop_loss
    setattr(trade, field, value)
    pauses = []
    strategy.dp._exchange._pause_entries = pauses.append
    result = strategy.custom_stoploss(trade.pair, trade, now, 102, .02)
    assert result is None  # Freqtrade keeps its existing stop, including after_fill.
    assert trade.stop_loss == prior
    assert trade.get_custom_data(BREAKEVEN_KEY) is None
    assert pauses == ['BREAKEVEN_EVIDENCE_INVALID']


def test_corrupt_cross_trade_state_is_not_adopted():
    strategy, trade, plan, now = fixture('atr15m-forward-v9')
    adjust(strategy, trade, now, 102)
    state = dict(trade.get_custom_data(BREAKEVEN_KEY), tag='codex-' + '0' * 32)
    trade.set_custom_data(BREAKEVEN_KEY, state)
    pauses = []
    strategy.dp._exchange._pause_entries = pauses.append
    with pytest.raises(ValueError, match='BREAKEVEN_EVIDENCE_INVALID'):
        strategy._breakeven_stop(trade, now, 102)
    assert pauses == ['BREAKEVEN_EVIDENCE_INVALID']


@pytest.mark.parametrize('short', [False, True])
def test_accounting_fault_after_activation_and_fill_does_not_loosen_native_stop(short):
    strategy, trade, plan, now = fixture('atr15m-forward-v9', short)
    rate = 98 if short else 102
    adjust(strategy, trade, now, rate)
    protected = trade.stop_loss
    state = dict(trade.get_custom_data(BREAKEVEN_KEY))
    trade.fee_close = None
    pauses = []
    strategy.dp._exchange._pause_entries = pauses.append
    strategy.ft_stoploss_adjust(rate, trade, now, .01, 0, after_fill=True)
    assert trade.stop_loss == protected
    assert trade.get_custom_data(BREAKEVEN_KEY) == state
    assert pauses == ['BREAKEVEN_EVIDENCE_INVALID']


@pytest.mark.parametrize('protection', [None, {}, {'version': 'fee-breakeven-v1', 'triggerNetUsdt': 0, 'riskMultiple': .5},
    {'version': 'fee-breakeven-v1', 'triggerNetUsdt': .5, 'riskMultiple': True}])
def test_new_entry_plan_requires_exact_approved_exit_policy(protection):
    _, trade, plan, _ = fixture('atr15m-forward-v9')
    plan['profitProtection'] = protection
    assert valid_plan(plan, trade.pair, trade.is_short, trade.enter_tag) is None


@pytest.mark.parametrize('futures', [False, True])
def test_v6_old_plan_never_acquires_v7_policy_or_legacy_roi(futures):
    strategy, trade, plan, now = fixture('atr15m-forward-v6', futures)
    original = json.dumps(plan, sort_keys=True)
    adjust(strategy, trade, now, 98 if futures else 102)
    assert trade.stop_loss == pytest.approx(101 if futures else 99)
    assert trade.get_custom_data(BREAKEVEN_KEY) is None
    assert strategy.custom_roi(trade.pair, trade, now, 400, trade.enter_tag, 'short' if futures else 'long') is None
    assert json.dumps(plan, sort_keys=True) == original


def test_activation_survives_real_sqlite_close_and_reopen(tmp_path):
    # Isolate installed ORM globals from other unit tests. This is an offline
    # native persistence test and never connects to a broker or Demo database.
    code = '''
import sys
sys.path.insert(0, 'test')
from test_rule_exit_profiles import fixture
from RuleExits import ENTRY_RULE_VERSION, BREAKEVEN_KEY
from freqtrade.persistence import Trade, init_db
db = 'sqlite:///' + sys.argv[1]
init_db(db)
s,t,p,now = fixture('atr15m-forward-v9')
del t.get_custom_data
del t.set_custom_data
Trade.session.add(t)
Trade.commit()
t.set_custom_data(key='rule_plan',value=p)
s.ft_stoploss_adjust(102,t,now,t.calc_profit_ratio(102),0)
Trade.commit()
key=t.id
before=t.get_custom_data(key=BREAKEVEN_KEY)
Trade.session.remove()
init_db(db)
restored=Trade.session.get(Trade,key)
s2,_,_,_=fixture('atr15m-forward-v9')
s2.ft_stoploss_adjust(100.3,restored,now,restored.calc_profit_ratio(100.3),0,after_fill=True)
assert restored.get_custom_data(key=BREAKEVEN_KEY)==before
assert restored.stop_loss==before['stopPrice']
assert restored.get_custom_data(key='rule_plan')==p
Trade.session.remove()
print('persisted')
'''
    result = subprocess.run([sys.executable, '-c', code, str(tmp_path / 'breakeven.sqlite')],
                            capture_output=True, text=True, timeout=30, creationflags=0x08000000 if sys.platform == 'win32' else 0)
    assert result.returncode == 0, result.stderr
    assert 'persisted' in result.stdout
