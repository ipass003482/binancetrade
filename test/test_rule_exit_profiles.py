"""Versioned exits exercised through installed Freqtrade's actual callbacks."""
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from freqtrade.persistence import Trade
from freqtrade.enums import ExitType, TradingMode
from ccxt import TICK_SIZE

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'freqtrade/strategies'))
from CodexDemoSpot import CodexDemoSpot
from CodexDemoFutures import CodexDemoFutures
from RuleExits import ENTRY_RULE_VERSION, RULE_ENGINE_VERSION, BREAKEVEN_POLICY, BREAKEVEN_RULE_VERSIONS, TRAILING_POLICY, TRAILING_RULE_VERSIONS, PROTECTED_RULE_VERSIONS


def fixture(version, futures=False):
    now = datetime.now(timezone.utc)
    config = dict(dry_run=False, trading_mode='futures' if futures else 'spot', margin_mode='isolated' if futures else '',
        bot_name='binance-trade-demo-futures' if futures else 'binance-trade-demo',
        position_adjustment_enable=False, stake_amount=150 if futures else 300,
        minimal_roi={'0': .03, '120': .015, '360': .005}, trailing_stop=not futures,
        exchange={'name': 'binance', 'demo_trading': True, 'pair_whitelist': ['ETH/USDT:USDT' if futures else 'ETH/USDT']})
    strategy = (CodexDemoFutures if futures else CodexDemoSpot)(config)
    strategy.dp = SimpleNamespace(_exchange=SimpleNamespace(demo_futures_destination_guard=True, demo_destination_guard=True))
    # Simulate StrategyResolver overriding strategy fields from an old on-disk config.
    strategy.minimal_roi = {0: .03, 120: .015, 360: .005}
    strategy.trailing_stop = not futures
    strategy.bot_start()
    strategy._ft_stop_uses_after_fill = True
    pair = config['exchange']['pair_whitelist'][0]
    tag = 'codex-' + 'f' * 32
    plan = dict(ruleVersion=version, tag=tag, pair=pair, isShort=futures, timeframe='5m', atrTimeframe='15m',
                maxHoldingBars=48, maxHoldingSeconds=14400, stopFraction=.01, targetFraction=.04)
    if version in BREAKEVEN_RULE_VERSIONS:
        plan.update(riskBudgetUsdt=1, profitProtection=dict(BREAKEVEN_POLICY))
    if version in TRAILING_RULE_VERSIONS:
        plan.update(riskBudgetUsdt=1, profitProtection=dict(TRAILING_POLICY))
    trade = Trade(pair=pair, enter_tag=tag, open_rate=100, amount=1, stake_amount=100,
                  fee_open=.001, fee_close=.001, open_date=now, is_short=futures, leverage=1,
                  exchange='binance', is_open=True, trading_mode=TradingMode.FUTURES if futures else TradingMode.SPOT,
                  price_precision=.01 if version in PROTECTED_RULE_VERSIONS else None, precision_mode_price=TICK_SIZE)
    trade.recalc_open_trade_value()
    custom = {'rule_plan': plan}
    trade.get_custom_data = lambda key, default=None: custom.get(key, default)
    trade.set_custom_data = lambda key, value: custom.update({key: value})
    return strategy, trade, plan, now


@pytest.mark.parametrize('futures', [False, True])
def test_current_profile_has_no_legacy_roi_and_old_open_trade_keeps_its_roi(futures):
    for version, expect_roi in [('atr15m-forward-v5', True), ('atr15m-forward-v6', False), *[(version, False) for version in PROTECTED_RULE_VERSIONS]]:
        strategy, trade, plan, now = fixture(version, futures)
        assert strategy.version() == RULE_ENGINE_VERSION == 'demo-rule-exits-v12'
        assert strategy.minimal_roi == {} and strategy.trailing_stop is False
        at = now + timedelta(minutes=121)
        rate = 98 if futures else 102
        # Gross 2%, net after fees <2%; below stored 4% ATR target, above old 1.5% ROI.
        assert strategy.custom_exit(trade.pair, trade, at, rate, trade.calc_profit_ratio(rate)) is None
        exits = strategy.should_exit(trade, rate, at, enter=False, exit_=False)
        assert any(exit.exit_type == ExitType.ROI for exit in exits) is expect_roi
        assert strategy._rule_plan(trade) is plan


@pytest.mark.parametrize('futures', [False, True])
@pytest.mark.parametrize('version', TRAILING_RULE_VERSIONS)
def test_current_profile_target_stop_and_time_take_native_custom_exit_priority(futures, version):
    for rate, hours, expected in [(95 if futures else 105, 0, 'rules_target'),
                                  (102 if futures else 98, 0, 'rules_stop'), (100, 4, 'rules_time')]:
        strategy, trade, plan, now = fixture(version, futures)
        at = now + timedelta(hours=hours)
        exits = strategy.should_exit(trade, rate, at, enter=False, exit_=False)
        assert exits[0].exit_type == ExitType.CUSTOM_EXIT
        assert exits[0].exit_reason == expected
        assert not any(exit.exit_type == ExitType.ROI for exit in exits)


def test_only_legacy_spot_keeps_old_trailing_and_native_ratchet_preserves_its_high():
    for version, expected_stop in [('atr15m-forward-v5', 102 * .996), ('atr15m-forward-v6', 99)]:
        strategy, trade, plan, now = fixture(version)
        strategy.ft_stoploss_adjust(102, trade, now, trade.calc_profit_ratio(102), 0)
        assert trade.stop_loss == pytest.approx(expected_stop)
        strategy.ft_stoploss_adjust(101, trade, now + timedelta(seconds=5), trade.calc_profit_ratio(101), 0)
        assert trade.stop_loss == pytest.approx(expected_stop)


@pytest.mark.parametrize('duration,expected', [(0, .03), (119, .03), (120, .015), (359, .015), (360, .005)])
def test_legacy_roi_schedule_is_identical_per_trade(duration, expected):
    strategy, trade, plan, now = fixture('atr15m-forward-v5', True)
    assert strategy.custom_roi(trade.pair, trade, now, duration, trade.enter_tag, 'short') == expected


def test_probe_has_no_old_roi_or_trailing_interference():
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION)
    plan.update(ruleVersion='demo-execution-probe-v1', purpose='execution_probe',
                maxHoldingBars=1, maxHoldingSeconds=90, stopFraction=.005, targetFraction=.005,
                maxEntryNotionalUsdt=25)
    assert strategy.custom_roi(trade.pair, trade, now, 400, trade.enter_tag, 'long') is None
    assert strategy.custom_exit(trade.pair, trade, now + timedelta(seconds=90), 100, 0) == 'rules_time'


@pytest.mark.parametrize('futures', [False, True])
def test_native_callback_wrapper_cannot_turn_protection_fault_into_entry_approval(futures):
    from freqtrade.strategy.strategy_wrapper import strategy_safe_wrapper
    from freqtrade.exceptions import TemporaryError
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, futures)
    def failed_capability():
        raise TemporaryError('Protection state unreadable')
    strategy.dp._exchange.demo_protection_capabilities = failed_capability
    # This is the actual installed Freqtrade wrapper and its permissive default.
    allowed = strategy_safe_wrapper(strategy.confirm_trade_entry, default_retval=True)(
        pair=trade.pair, order_type='market', amount=.01, rate=2400,
        time_in_force='GTC', current_time=now, entry_tag=trade.enter_tag,
        side='short' if futures else 'long')
    assert allowed is False


def test_flat_native_capability_heartbeat_runs_every_15_seconds_without_order_queries():
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION)
    calls = []
    strategy.dp._exchange.demo_protection_capabilities = lambda: calls.append('capability')
    strategy.bot_loop_start(now)
    strategy.bot_loop_start(now + timedelta(seconds=14))
    assert calls == ['capability']
    strategy.bot_loop_start(now + timedelta(seconds=15))
    assert calls == ['capability', 'capability']
