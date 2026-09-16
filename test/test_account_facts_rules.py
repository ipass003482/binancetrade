import importlib.util
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
import pytest
from demo_model_guard_support import isolate, add_guard, NOW, TAG, fake_exchange

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('facts_test', ROOT / 'scripts/demo-account-facts.py')
facts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(facts)
sys.path.insert(0, str(ROOT / 'freqtrade/strategies'))
from RuleExits import RuleExits, valid_plan


@pytest.fixture(autouse=True)
def isolate_native_guard_clock(tmp_path, monkeypatch):
    isolate(monkeypatch, tmp_path)


def test_signed_fee_components_and_discounts_are_not_silently_lost():
    part = {'taker': '0.001', 'buyer': '0.0001', 'seller': '0.0002'}
    result = facts.commission({name: part for name in ('standardCommission', 'taxCommission', 'specialCommission')})
    assert float(result['buyRate']) == pytest.approx(.0033)
    assert float(result['sellRate']) == pytest.approx(.0036)
    with pytest.raises(KeyError):
        facts.commission({'standardCommission': part})
    with pytest.raises(ValueError):
        facts.commission({'takerCommissionRate': '-0.1'}, True)


def test_equity_prices_all_holdings_and_does_not_assume_usdc_equals_usdt():
    account = {'balances': [{'asset': 'USDT', 'free': '100', 'locked': '10'}, {'asset': 'USDC', 'free': '50', 'locked': '0'}]}
    assert facts.spot_equity(account, [])['equityUsdt'] is None
    value = facts.spot_equity(account, [{'symbol': 'USDCUSDT', 'bidPrice': '.99', 'askPrice': '1.01'}])
    assert float(value['equityUsdt']) == 159.5


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('version', ['confirmed-breakout-atr-v1', 'buffered-breakout-atr-v2', 'buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5', 'atr15m-forward-v6'])
def test_structured_exits_target_stop_time_and_persisted_plan(short, version):
    strategy = RuleExits()
    tag = 'codex-' + 'a' * 32
    plan = {'ruleVersion': version, 'tag': tag, 'pair': 'BTC/USDT:USDT', 'isShort': short,
            'stopFraction': .01, 'targetFraction': .02, 'maxHoldingBars': 16}
    if version in ('buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5', 'atr15m-forward-v6'):
        plan.update(timeframe='5m', atrTimeframe='15m', maxHoldingBars=48, maxHoldingSeconds=14400)
    now = datetime.now(timezone.utc)
    trade = SimpleNamespace(enter_tag=tag, pair=plan['pair'], is_short=short, open_rate=100, leverage=1,
                            open_date_utc=now, get_custom_data=lambda **kwargs: plan)
    assert strategy.custom_exit(trade.pair, trade, now, 97 if short else 103, 0) == 'rules_target'
    assert strategy.custom_exit(trade.pair, trade, now, 102 if short else 98, 0) == 'rules_stop'
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(minutes=80), 100, 0) is None
    assert strategy.custom_exit(trade.pair, trade, now+timedelta(hours=4), 100, 0) == 'rules_time'
    assert strategy.custom_stoploss(trade.pair, trade, now, 100, 0) == pytest.approx(.01)
    assert valid_plan({**plan, 'pair': 'ETH/USDT:USDT'}, trade.pair, short, tag) is None
    assert valid_plan({**plan, 'stopFraction': .1}, trade.pair, short, tag) is None
    assert valid_plan({**plan, 'ruleVersion': 'unknown'}, trade.pair, short, tag) is None


def test_native_entry_risk_rejects_missing_stale_or_engine_increased_order(tmp_path, monkeypatch):
    import json
    import RuleExits as module
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot'}
    strategy.dp = SimpleNamespace(_exchange=fake_exchange())
    now = NOW
    tag = TAG
    args = dict(pair='BTC/USDT', order_type='market', amount=.5, rate=100,
                time_in_force='GTC', current_time=now, entry_tag=tag, side='long')
    assert not strategy.entry_risk_allowed(**args)
    plan = add_guard(dict(ruleVersion='kronos-direction-v12', profitProtection={'version': 'net-profit-trail-v1', 'triggerNetUsdt': .5, 'givebackNetUsdt': .25, 'riskMultiple': .5}, timeframe='5m', atrTimeframe='15m',
                pair=args['pair'], tag=tag, isShort=False, stopFraction=.01, targetFraction=.02,
                maxHoldingBars=48, maxHoldingSeconds=14400, riskBudgetUsdt=1,
                riskCostFraction=.003, maxEntryNotionalUsdt=60, createdAt=now.isoformat()))
    path = tmp_path / 'local/demo/entry-plans' / (tag + '.json')
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(plan))
    assert strategy.entry_risk_allowed(**args)
    # Preserved legacy exits do not authorize a fresh order from an old bridge.
    for old_version in ('atr15m-forward-v7', 'atr15m-forward-v8', 'atr15m-forward-v9', 'atr15m-forward-v10', 'kronos-forward-v11'):
        old = dict(plan, ruleVersion=old_version)
        if old_version not in ('atr15m-forward-v10', 'kronos-forward-v11'):
            old['profitProtection'] = dict(version='fee-breakeven-v1', triggerNetUsdt=.5, riskMultiple=.5)
        path.write_text(json.dumps(old))
        assert not strategy.entry_risk_allowed(**args)
    path.write_text(json.dumps(plan))
    assert not strategy.entry_risk_allowed(**(args | {'amount': .61}))
    assert not strategy.entry_risk_allowed(**(args | {'current_time': now + timedelta(seconds=121)}))
    plan['maxEntryNotionalUsdt'] = 100
    path.write_text(json.dumps(plan))
    assert not strategy.entry_risk_allowed(**(args | {'amount': .8}))
    assert not strategy.entry_risk_allowed(**(args | {'side': 'short'}))


def probe_plan(now, short=False):
    return dict(ruleVersion='demo-execution-probe-v1', purpose='execution_probe', timeframe='5m',
                pair='ETH/USDT:USDT' if short else 'ETH/USDT', tag='codex-' + 'c' * 32,
                isShort=short, stopFraction=.005, targetFraction=.005,
                maxHoldingBars=1, maxHoldingSeconds=90, riskBudgetUsdt=1,
                riskCostFraction=.003, maxEntryNotionalUsdt=25, createdAt=now.isoformat())


@pytest.mark.parametrize('short', [False, True])
def test_probe_persists_actual_fill_plan_and_exits_at_90_seconds(tmp_path, monkeypatch, short):
    import json
    import RuleExits as module
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    strategy = RuleExits()
    mode = 'demo-futures' if short else 'demo'
    strategy.config = {'trading_mode': 'futures' if short else 'spot'}
    strategy.dp = SimpleNamespace(_exchange=fake_exchange(mode))
    now = NOW
    plan = probe_plan(now, short)
    path = tmp_path / 'local' / mode / 'entry-plans' / (plan['tag'] + '.json')
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(plan))
    args = dict(pair=plan['pair'], order_type='market', amount=.25, rate=100,
                time_in_force='GTC', current_time=now, entry_tag=plan['tag'], side='short' if short else 'long')
    assert strategy.entry_risk_allowed(**args)
    assert not strategy.entry_risk_allowed(**(args | {'amount': .2501}))
    persisted = {}
    trade = SimpleNamespace(enter_tag=plan['tag'], pair=plan['pair'], is_short=short,
                            open_rate=100, leverage=1, open_date_utc=now,
                            get_custom_data=lambda key, default: persisted.get(key, default),
                            set_custom_data=lambda key, value: persisted.update({key: value}))
    strategy.order_filled(trade.pair, trade, None, now)
    assert persisted['rule_plan'] == plan
    path.unlink()  # The actual trade keeps its exits after the source plan disappears.
    assert strategy.custom_exit(trade.pair, trade, now + timedelta(seconds=89.9), 100, 0) is None
    assert strategy.custom_exit(trade.pair, trade, now + timedelta(seconds=90), 100, 0) == 'rules_time'
    assert strategy.custom_exit(trade.pair, trade, now, 99 if short else 101, 0) == 'rules_target'
    assert strategy.custom_exit(trade.pair, trade, now, 101 if short else 99, 0) == 'rules_stop'
    assert strategy.custom_stoploss(trade.pair, trade, now, 100, 0) == pytest.approx(.005)


@pytest.mark.parametrize('patch', [
    {'purpose': 'strategy'}, {'pair': 'BTC/USDT'}, {'isShort': True},
    {'timeframe': '15m'}, {'maxHoldingSeconds': 91}, {'maxHoldingBars': True},
    {'stopFraction': .02}, {'targetFraction': .03}, {'maxEntryNotionalUsdt': 25.01},
    {'maxEntryNotionalUsdt': float('nan')}, {'riskBudgetUsdt': 2},
    {'riskCostFraction': float('nan')}, {'riskCostFraction': -.01},
    {'riskCostFraction': .04}, {'riskBudgetUsdt': True}, {'createdAt': 'invalid'},
])
def test_native_probe_rejects_invalid_identity_exit_or_risk_fields(patch):
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot'}
    now = datetime.now(timezone.utc)
    plan = probe_plan(now) | patch
    strategy._entry_plan = lambda *args: plan
    assert not strategy.entry_risk_allowed(pair='ETH/USDT', order_type='market', amount=.25, rate=100,
                time_in_force='GTC', current_time=now, entry_tag='codex-' + 'c' * 32, side='long')


def test_native_probe_rejects_expired_future_and_wrong_account_or_side():
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot'}
    strategy.dp = SimpleNamespace(_exchange=fake_exchange())
    now = NOW
    plan = probe_plan(now)
    strategy._entry_plan = lambda *args: plan
    args = dict(pair=plan['pair'], order_type='market', amount=.25, rate=100,
                time_in_force='GTC', current_time=now, entry_tag=plan['tag'], side='long')
    assert strategy.entry_risk_allowed(**args)
    for offset in (-.1, 120.1):
        assert not strategy.entry_risk_allowed(**(args | {'current_time': now + timedelta(seconds=offset)}))
    for side in ('short', 'buy', None):
        assert not strategy.entry_risk_allowed(**(args | {'side': side}))
    for mode in ('futures', 'margin', None):
        strategy.config['trading_mode'] = mode
        assert not strategy.entry_risk_allowed(**args)


@pytest.mark.parametrize('version', ['confirmed-breakout-atr-v1', 'buffered-breakout-atr-v2', 'buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5'])
def test_legacy_plan_remains_exit_only(version):
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot'}
    now = datetime.now(timezone.utc)
    plan = probe_plan(now) | dict(ruleVersion=version, atrTimeframe='15m', maxHoldingBars=16,
                                  maxHoldingSeconds=14400)
    if version in ('buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5'):
        plan['maxHoldingBars'] = 48
    plan['purpose'] = 'strategy'
    strategy._entry_plan = lambda *args: plan
    assert valid_plan(plan, plan['pair'], False, plan['tag']) is plan
    assert not strategy.entry_risk_allowed(pair=plan['pair'], order_type='market', amount=.25, rate=100,
                time_in_force='GTC', current_time=now, entry_tag=plan['tag'], side='long')
