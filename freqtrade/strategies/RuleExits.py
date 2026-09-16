"""Structured rule exits for bridge entries, persisted on the Freqtrade trade."""
import json
import math
import logging
import re
import sys
from pathlib import Path
from ccxt import ROUND_DOWN, ROUND_UP, TICK_SIZE, DECIMAL_PLACES
from freqtrade.exchange import price_to_precision
from freqtrade.strategy import stoploss_from_absolute

RULE_ENGINE_VERSION = 'demo-rule-exits-v12'
ENTRY_RULE_VERSION = 'kronos-direction-v12'
BREAKEVEN_RULE_VERSIONS = ('atr15m-forward-v7', 'atr15m-forward-v8', 'atr15m-forward-v9')
TRAILING_RULE_VERSIONS = ('atr15m-forward-v10', 'kronos-forward-v11', ENTRY_RULE_VERSION)
TRAILING_POLICY = {'version': 'net-profit-trail-v1', 'triggerNetUsdt': .5, 'givebackNetUsdt': .25, 'riskMultiple': .5}
TRAILING_KEY = 'net_profit_trail'
PROTECTED_RULE_VERSIONS = (*BREAKEVEN_RULE_VERSIONS, *TRAILING_RULE_VERSIONS)
FIXED_ATR_RULE_VERSION = 'atr15m-forward-v6'
BREAKEVEN_POLICY = {'version': 'fee-breakeven-v1', 'triggerNetUsdt': .5, 'riskMultiple': .5}
BREAKEVEN_KEY = 'fee_breakeven'
logger = logging.getLogger(__name__)
PROBE_RULE_VERSION = 'demo-execution-probe-v1'
LEGACY_RULE_VERSIONS = ('confirmed-breakout-atr-v1', 'buffered-breakout-atr-v2',
                        'buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5')
TIMED_RULE_VERSIONS = ('buffered-breakout-atr-v3', 'atr15m-risk-v4', 'atr15m-forward-v5', FIXED_ATR_RULE_VERSION, *PROTECTED_RULE_VERSIONS)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from demo_model_guard import authorize_entry, clear_entry_permit, record_callback_rejection
from demo_flow_exit import QUALITY_VERSION as FLOW_QUALITY_VERSION, POLICY as FLOW_EXIT_POLICY, STATE_KEY as FLOW_EXIT_KEY, advance as advance_flow_exit, policy_for_plan


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def valid_risk_budget(plan):
    budget = plan.get('riskBudgetUsdt')
    if not finite_number(budget):
        return False
    profile = plan.get('adaptiveParameters')
    if profile is None:
        return budget == 1
    # Entry authorization independently recomputes the full adaptive proof.
    # Persisted exits retain their entry-time budget without reading live flow.
    try:
        return (plan.get('ruleVersion') == ENTRY_RULE_VERSION
                and isinstance(profile, dict) and profile.get('version') in ('live-flow-adaptive-v1', 'live-flow-adaptive-v2')
                and plan.get('decisionCadenceVersion') == 'flow-minute-v1'
                and plan.get('decisionIntervalMs') == 60000
                and type(plan.get('decisionBoundary')) is int and plan['decisionBoundary'] % 60000 == 0
                and .25 <= budget <= 1
                and isinstance(profile.get('riskBudgetUsdt'), str) and isinstance(profile.get('riskScale'), str)
                and float(profile['riskBudgetUsdt']) == budget == float(profile['riskScale']))
    except (ValueError, TypeError, OverflowError):
        return False


def valid_plan(value, pair, is_short, tag):
    # Existing positions keep their original, persisted numeric exit plan.
    if not isinstance(value, dict) or value.get('ruleVersion') not in (*LEGACY_RULE_VERSIONS, FIXED_ATR_RULE_VERSION, *PROTECTED_RULE_VERSIONS, PROBE_RULE_VERSION):
        return None
    if not isinstance(tag, str) or not re.fullmatch(r'codex-[0-9a-f]{32}', tag):
        return None
    if value.get('pair') != pair or value.get('isShort') is not is_short or value.get('tag') != tag:
        return None
    for key in ('stopFraction', 'targetFraction'):
        n = value.get(key)
        if not finite_number(n) or n <= 0:
            return None
    version = value['ruleVersion']
    if version in PROTECTED_RULE_VERSIONS:
        protection = value.get('profitProtection')
        expected = TRAILING_POLICY if version in TRAILING_RULE_VERSIONS else BREAKEVEN_POLICY
        if (not isinstance(protection, dict) or protection != expected
                or not finite_number(protection.get('triggerNetUsdt'))
                or not finite_number(protection.get('riskMultiple'))
                or (version in TRAILING_RULE_VERSIONS and not finite_number(protection.get('givebackNetUsdt')))
                or not valid_risk_budget(value)):
            return None
    if version == PROBE_RULE_VERSION:
        if (value.get('purpose') != 'execution_probe'
            or (pair, is_short) not in (('ETH/USDT', False), ('ETH/USDT:USDT', True))
            or value.get('timeframe') != '5m'
            or type(value.get('maxHoldingSeconds')) is not int or value['maxHoldingSeconds'] != 90
            or type(value.get('maxHoldingBars')) is not int or value['maxHoldingBars'] != 1
            or value['stopFraction'] != .005 or value['targetFraction'] != .005
            or not finite_number(value.get('maxEntryNotionalUsdt'))
            or not 0 < value['maxEntryNotionalUsdt'] <= 25):
            return None
        return value
    timed = version in TIMED_RULE_VERSIONS
    if timed and (value.get('timeframe') != '5m' or value.get('maxHoldingSeconds') != 14400):
        return None
    if version in ('atr15m-forward-v5', FIXED_ATR_RULE_VERSION, *PROTECTED_RULE_VERSIONS) and (value.get('atrTimeframe') != '15m'
            or value.get('purpose') == 'execution_probe'):
        return None
    if value['stopFraction'] > 0.02 or value['targetFraction'] > 1 or value.get('maxHoldingBars') != (48 if timed else 16):
        return None
    return value


class RuleExits:
    use_custom_stoploss = True
    use_custom_roi = True
    minimal_roi = {}
    trailing_stop = False

    def configure_rule_exits(self):
        # StrategyResolver may have loaded the previous config before the guarded
        # adapter migrated it. Pin both views; no global ROI/trailing may override
        # a v6 trade's persisted ATR plan.
        self.minimal_roi = {}
        self.trailing_stop = False
        self.use_custom_roi = True
        self.use_custom_stoploss = True
        self.config.update(minimal_roi={}, trailing_stop=False, use_custom_stoploss=True)
        if self.config.get('order_types'):
            self.order_types = dict(self.config['order_types'])
        exchange = getattr(getattr(self, 'dp', None), '_exchange', None)
        if callable(getattr(exchange, 'demo_protection_capabilities', None)):
            exchange.demo_protection_capabilities()

    def custom_roi(self, pair, trade, current_time, trade_duration, entry_tag, side, **kwargs):
        plan = self._rule_plan(trade)
        if plan and plan['ruleVersion'] in (FIXED_ATR_RULE_VERSION, *PROTECTED_RULE_VERSIONS, PROBE_RULE_VERSION):
            return None
        # Preserve the pre-upgrade ROI schedule for already-open legacy trades.
        return .005 if trade_duration >= 360 else .015 if trade_duration >= 120 else .03

    def bot_loop_start(self, current_time, **kwargs):
        # A flat engine still publishes fresh capability/process evidence for
        # bridge preflight. This does NOT refresh any active order's observedAt;
        # Freqtrade queries each native stop in handle_stoploss_on_exchange on
        # every normal engine loop (separate from the 15s replacement interval).
        exchange = getattr(getattr(self, 'dp', None), '_exchange', None)
        refresh = getattr(exchange, 'demo_protection_capabilities', None)
        if not callable(refresh):
            return
        try:
            timestamp = current_time.timestamp()
            previous = getattr(self, '_protection_heartbeat_at', None)
            if previous is None or timestamp < previous or timestamp - previous >= 15:
                observe = getattr(exchange, 'refresh_demo_stop_observations', None)
                if callable(observe):
                    observe()
                refresh()
                self._protection_heartbeat_at = timestamp
        except Exception:
            pause = getattr(exchange, '_pause_entries', None)
            if callable(pause):
                pause('DEMO_PROTECTION_HEARTBEAT_FAILED')

    def _entry_plan(self, pair, is_short, tag):
        if not isinstance(tag, str) or not re.fullmatch(r'codex-[0-9a-f]{32}', tag):
            return None
        mode = 'demo-futures' if self.config.get('trading_mode') == 'futures' else 'demo'
        try:
            value = json.loads((ROOT / 'local' / mode / 'entry-plans' / (tag + '.json')).read_text(encoding='utf-8'))
            return valid_plan(value, pair, is_short, tag)
        except (OSError, ValueError, TypeError):
            return None

    def entry_risk_allowed(self, pair, order_type, amount, rate, time_in_force, current_time, entry_tag, side, **kwargs):
        # Freqtrade has adjusted minimum stake here; quantity precision is applied later.
        clear_entry_permit()
        mode = self.config.get('trading_mode')
        if side not in ('long', 'short') or mode not in ('spot', 'futures') or (mode == 'spot' and side != 'long'):
            return False
        exchange = getattr(getattr(self, 'dp', None), '_exchange', None)
        if (callable(getattr(exchange, 'demo_entry_protection_allowed', None))
                and not exchange.demo_entry_protection_allowed(pair)):
            return False
        plan = self._entry_plan(pair, side == 'short', entry_tag)
        plan = valid_plan(plan, pair, side == 'short', entry_tag)
        if not plan or plan['ruleVersion'] not in (ENTRY_RULE_VERSION, PROBE_RULE_VERSION):
            return False
        if plan['ruleVersion'] == PROBE_RULE_VERSION and pair != ('ETH/USDT' if mode == 'spot' else 'ETH/USDT:USDT'):
            return False
        try:
            values = [amount, rate, plan['riskCostFraction'], plan['riskBudgetUsdt'], plan['maxEntryNotionalUsdt']]
            if any(not finite_number(n) for n in values):
                record_callback_rejection(plan, 'demo-futures' if mode == 'futures' else 'demo', pair, entry_tag,
                    'DEMO_NATIVE_MODEL_CALLBACK_RISK_REJECTED')
                return False
            from datetime import datetime
            age = (current_time - datetime.fromisoformat(plan['createdAt'].replace('Z', '+00:00'))).total_seconds()
            allowed = (0 <= age <= 120 and amount > 0 and rate > 0 and plan['riskCostFraction'] >= 0
                    and valid_risk_budget(plan) and plan['maxEntryNotionalUsdt'] > 0
                    and amount * rate <= plan['maxEntryNotionalUsdt'] + 1e-8
                    and amount * rate * (plan['stopFraction'] + plan['riskCostFraction']) <= plan['riskBudgetUsdt'] + 1e-8)
            if not allowed:
                record_callback_rejection(plan, 'demo-futures' if mode == 'futures' else 'demo', pair, entry_tag,
                    'DEMO_NATIVE_MODEL_CALLBACK_RISK_REJECTED')
                return False
            return authorize_entry(exchange, plan, 'demo-futures' if mode == 'futures' else 'demo',
                                   pair, side, amount, rate, order_type)
        except Exception as error:
            # Native/RPC callbacks must reject explicitly; Freqtrade otherwise
            # defaults to accepting a callback which raises an exception.
            code=str(error)
            if not re.fullmatch(r'DEMO_NATIVE_MODEL_[A-Z_]+',code):
                code='ENTRY_CALLBACK_REJECTED'
            logger.warning('NATIVE_ENTRY_DENIED pair=%s tag=%s code=%s',pair,entry_tag,code)
            record_callback_rejection(plan, 'demo-futures' if mode == 'futures' else 'demo', pair, entry_tag, code)
            clear_entry_permit()
            return False

    def version(self):
        return RULE_ENGINE_VERSION

    def _rule_plan(self, trade):
        tag = trade.enter_tag
        if not isinstance(tag, str) or not re.fullmatch(r'codex-[0-9a-f]{32}', tag):
            return None
        stored = trade.get_custom_data(key='rule_plan', default=None)
        if stored is not None:
            return valid_plan(stored, trade.pair, trade.is_short, tag)
        mode = 'demo-futures' if trade.is_short or self.config.get('trading_mode') == 'futures' else 'demo'
        try:
            path = ROOT / 'local' / mode / 'entry-plans' / (tag + '.json')
            plan = valid_plan(json.loads(path.read_text(encoding='utf-8')), trade.pair, trade.is_short, tag)
            if plan:
                trade.set_custom_data(key='rule_plan', value=plan)
            return plan
        except (OSError, ValueError, TypeError):
            return None

    def order_filled(self, pair, trade, order, current_time, **kwargs):
        self._rule_plan(trade)

    def _breakeven_failure(self, trade):
        # Preserve the native stop when accounting or persisted evidence fails.
        # Make the fault visible and prevent new exposure; never invent a price.
        if getattr(self, '_breakeven_failed_trade', None) != trade.enter_tag:
            logger.error('BREAKEVEN_EVIDENCE_INVALID pair=%s tag=%s', trade.pair, trade.enter_tag)
            self._breakeven_failed_trade = trade.enter_tag
        pause = getattr(getattr(getattr(self, 'dp', None), '_exchange', None), '_pause_entries', None)
        if callable(pause):
            pause('BREAKEVEN_EVIDENCE_INVALID')

    def _breakeven_state(self, trade):
        state = trade.get_custom_data(key=BREAKEVEN_KEY, default=None)
        if state is None:
            return None
        from datetime import datetime
        plan = self._rule_plan(trade)
        if (not isinstance(state, dict) or state.get('version') != BREAKEVEN_POLICY['version']
                or not plan or plan['ruleVersion'] not in BREAKEVEN_RULE_VERSIONS
                or state.get('ruleVersion') != plan['ruleVersion'] or state.get('tag') != trade.enter_tag
                or state.get('pair') != trade.pair or state.get('isShort') is not trade.is_short
                or not finite_number(state.get('stopPrice')) or state['stopPrice'] <= 0
                or not finite_number(state.get('observedNetUsdt')) or state['observedNetUsdt'] < .5
                or datetime.fromisoformat(state['activatedAt']).tzinfo is None):
            raise ValueError('BREAKEVEN_STATE_INVALID')
        return state

    def _breakeven_stop(self, trade, current_time, current_rate):
        try:
            state = self._breakeven_state(trade)
            # The installed engine includes entry/estimated exit fees and accrued
            # futures funding. Use monetary net, independent of leverage/ROI %.
            values = (trade.amount, trade.open_trade_value, trade.fee_open, trade.fee_close,
                      trade.funding_fees if trade.funding_fees is not None else 0, current_rate)
            if (any(not finite_number(x) for x in values) or trade.amount <= 0
                    or trade.open_trade_value <= 0 or current_rate <= 0
                    or not 0 <= trade.fee_open < 1 or not 0 <= trade.fee_close < 1
                    or str(trade.trading_mode or 'spot') not in ('spot', 'futures')
                    or trade.precision_mode_price not in (TICK_SIZE, DECIMAL_PLACES)
                    or not finite_number(trade.price_precision)
                    or (trade.precision_mode_price == TICK_SIZE and trade.price_precision <= 0)
                    or (trade.precision_mode_price == DECIMAL_PLACES
                        and (trade.price_precision < 0 or int(trade.price_precision) != trade.price_precision))):
                raise ValueError('BREAKEVEN_ACCOUNTING_INVALID')
            net = trade.calculate_profit(current_rate).profit_abs
            if not finite_number(net):
                raise ValueError('BREAKEVEN_NET_INVALID')
            if state is None and net < BREAKEVEN_POLICY['triggerNetUsdt']:
                return None
            # calc_close_trade_value is affine for spot and linear futures.
            # Its intercept carries signed funding. Solve close value = open value.
            intercept = trade.calc_close_trade_value(0.0)
            slope = trade.amount * (1 + trade.fee_close if trade.is_short else 1 - trade.fee_close)
            rate = (trade.open_trade_value - intercept) / slope
            stop = price_to_precision(rate, trade.price_precision, trade.precision_mode_price,
                                      rounding_mode=ROUND_DOWN if trade.is_short else ROUND_UP)
            if not finite_number(stop) or stop <= 0 or trade.calculate_profit(stop).profit_abs < -1e-8:
                raise ValueError('BREAKEVEN_PRICE_INVALID')
            tighter = min if trade.is_short else max
            if state:
                stop = tighter(stop, state['stopPrice'])
            # after_fill permits Freqtrade to loosen a stop. Explicitly retain
            # an already tighter native stop, including after a process restart.
            if finite_number(trade.stop_loss) and trade.stop_loss > 0:
                stop = tighter(stop, trade.stop_loss)
            if state is None or stop != state['stopPrice']:
                updated = dict(state or {}, version=BREAKEVEN_POLICY['version'], ruleVersion=self._rule_plan(trade)['ruleVersion'],
                    tag=trade.enter_tag, pair=trade.pair, isShort=trade.is_short,
                    activatedAt=state['activatedAt'] if state else current_time.isoformat(),
                    observedNetUsdt=state['observedNetUsdt'] if state else net,
                    updatedAt=current_time.isoformat(), stopPrice=stop,
                    accounting=dict(amount=trade.amount, openTradeValue=trade.open_trade_value,
                        feeOpen=trade.fee_open, feeClose=trade.fee_close, fundingFees=trade.funding_fees))
                trade.set_custom_data(key=BREAKEVEN_KEY, value=updated)
                logger.info('BREAKEVEN_STOP_ARMED pair=%s tag=%s stop=%s trigger_net=%s',
                            trade.pair, trade.enter_tag, stop, updated['observedNetUsdt'])
            return stop
        except Exception:
            self._breakeven_failure(trade)
            raise ValueError('BREAKEVEN_EVIDENCE_INVALID') from None

    def _trailing_failure(self, trade):
        logger.error('PROFIT_TRAIL_EVIDENCE_INVALID pair=%s tag=%s', trade.pair, trade.enter_tag)
        pause = getattr(getattr(getattr(self, 'dp', None), '_exchange', None), '_pause_entries', None)
        if callable(pause):
            pause('PROFIT_TRAIL_EVIDENCE_INVALID')

    def _trailing_state(self, trade):
        from datetime import datetime
        state = trade.get_custom_data(key=TRAILING_KEY, default=None)
        if state is None:
            return None
        plan = self._rule_plan(trade)
        if (not isinstance(state, dict) or not plan or plan['ruleVersion'] not in TRAILING_RULE_VERSIONS
                or state.get('version') != TRAILING_POLICY['version']
                or state.get('ruleVersion') != plan['ruleVersion'] or state.get('tag') != trade.enter_tag
                or state.get('pair') != trade.pair or state.get('isShort') is not trade.is_short
                or any(not finite_number(state.get(k)) for k in ('stopPrice', 'observedNetUsdt', 'peakNetUsdt', 'protectedNetUsdt'))
                or state['stopPrice'] <= 0 or state['observedNetUsdt'] < TRAILING_POLICY['triggerNetUsdt']
                or state['peakNetUsdt'] < state['observedNetUsdt']
                or abs(state['protectedNetUsdt'] - (state['peakNetUsdt'] - TRAILING_POLICY['givebackNetUsdt'])) > 1e-8
                or datetime.fromisoformat(state['activatedAt']).tzinfo is None
                or datetime.fromisoformat(state['updatedAt']).tzinfo is None
                or datetime.fromisoformat(state['updatedAt']) < datetime.fromisoformat(state['activatedAt'])):
            raise ValueError('PROFIT_TRAIL_STATE_INVALID')
        return state

    def _trailing_stop(self, trade, current_time, current_rate):
        try:
            from datetime import datetime
            state = self._trailing_state(trade)
            values = (trade.amount, trade.open_trade_value, trade.fee_open, trade.fee_close,
                      trade.funding_fees if trade.funding_fees is not None else 0, current_rate)
            if (any(not finite_number(x) for x in values) or trade.amount <= 0
                    or trade.open_trade_value <= 0 or current_rate <= 0
                    or not 0 <= trade.fee_open < 1 or not 0 <= trade.fee_close < 1
                    or str(trade.trading_mode or 'spot') not in ('spot', 'futures')
                    or trade.precision_mode_price not in (TICK_SIZE, DECIMAL_PLACES)
                    or not finite_number(trade.price_precision)
                    or (trade.precision_mode_price == TICK_SIZE and trade.price_precision <= 0)
                    or (trade.precision_mode_price == DECIMAL_PLACES and
                        (trade.price_precision < 0 or int(trade.price_precision) != trade.price_precision))
                    or current_time.tzinfo is None
                    or (state and current_time < datetime.fromisoformat(state['updatedAt']))):
                raise ValueError('PROFIT_TRAIL_ACCOUNTING_INVALID')
            net = trade.calculate_profit(current_rate).profit_abs
            if not finite_number(net):
                raise ValueError('PROFIT_TRAIL_NET_INVALID')
            if state is None and net < TRAILING_POLICY['triggerNetUsdt']:
                return None
            peak = max(net, state['peakNetUsdt']) if state else net
            protected = peak - TRAILING_POLICY['givebackNetUsdt']
            # Solve the installed engine's fee/funding-aware affine PnL for the
            # desired monetary floor, reversing the PnL sign for linear shorts.
            intercept = trade.calc_close_trade_value(0.0)
            slope = trade.amount * (1 + trade.fee_close if trade.is_short else 1 - trade.fee_close)
            rate = (trade.open_trade_value - intercept + (-protected if trade.is_short else protected)) / slope
            stop = price_to_precision(rate, trade.price_precision, trade.precision_mode_price,
                                      rounding_mode=ROUND_DOWN if trade.is_short else ROUND_UP)
            if not finite_number(stop) or stop <= 0 or trade.calculate_profit(stop).profit_abs < protected - 1e-8:
                raise ValueError('PROFIT_TRAIL_PRICE_INVALID')
            tighter = min if trade.is_short else max
            if state:
                stop = tighter(stop, state['stopPrice'])
            if finite_number(trade.stop_loss) and trade.stop_loss > 0:
                stop = tighter(stop, trade.stop_loss)
            # Persist every new observed peak, even if its price rounds to the
            # same tick. Restart/after_fill must never reset the high-water mark.
            if state is None or peak != state['peakNetUsdt'] or stop != state['stopPrice']:
                updated = dict(version=TRAILING_POLICY['version'], ruleVersion=self._rule_plan(trade)['ruleVersion'],
                    tag=trade.enter_tag, pair=trade.pair, isShort=trade.is_short,
                    activatedAt=state['activatedAt'] if state else current_time.isoformat(),
                    observedNetUsdt=state['observedNetUsdt'] if state else net,
                    updatedAt=current_time.isoformat(), peakNetUsdt=peak, protectedNetUsdt=protected, stopPrice=stop,
                    accounting=dict(amount=trade.amount, openTradeValue=trade.open_trade_value,
                        feeOpen=trade.fee_open, feeClose=trade.fee_close, fundingFees=trade.funding_fees))
                trade.set_custom_data(key=TRAILING_KEY, value=updated)
                logger.info('PROFIT_TRAIL_ARMED pair=%s tag=%s stop=%s peak_net=%s protected_net=%s',
                            trade.pair, trade.enter_tag, stop, peak, protected)
            return stop
        except Exception:
            self._trailing_failure(trade)
            raise ValueError('PROFIT_TRAIL_EVIDENCE_INVALID') from None

    def custom_stoploss(self, pair, trade, current_time, current_rate, current_profit, after_fill=False, **kwargs):
        plan = self._rule_plan(trade)
        if not plan:
            # Untagged positions predate structured plans. Keep their prior
            # spot trailing behavior; a missing structured plan stays fail-safe
            # at the native hard stop and is never guessed into a new profile.
            if isinstance(trade.enter_tag, str) and trade.enter_tag.startswith('codex-'):
                return None
            stop = trade.open_rate * (1 + (.02 if trade.is_short else -.02))
            legacy = True
        else:
            stop = trade.open_rate * (1 + (plan['stopFraction'] if trade.is_short else -plan['stopFraction']))
            if plan['ruleVersion'] in TRAILING_RULE_VERSIONS and finite_number(trade.stop_loss) and trade.stop_loss > 0:
                stop = (min if trade.is_short else max)(stop, trade.stop_loss)
            legacy = plan['ruleVersion'] in LEGACY_RULE_VERSIONS
            if plan['ruleVersion'] in PROTECTED_RULE_VERSIONS:
                try:
                    breakeven = (self._trailing_stop if plan['ruleVersion'] in TRAILING_RULE_VERSIONS else self._breakeven_stop)(trade, current_time, current_rate)
                except ValueError:
                    # None here tells Freqtrade to retain its existing stop,
                    # even in after_fill which otherwise permits loosening.
                    return None
                # Before the monetary trail activates, retaining a tighter
                # existing stop needs no conversion. Feeding it through the
                # absolute->ratio->absolute path can round a short down another
                # tick as quotes change, unintentionally ratcheting an ATR stop.
                # None also preserves it after_fill; it never resets/widens it.
                if (plan['ruleVersion'] in TRAILING_RULE_VERSIONS and breakeven is None
                        and finite_number(trade.stop_loss) and trade.stop_loss > 0
                        and stop == trade.stop_loss):
                    return None
                if breakeven is not None:
                    stop = (min if trade.is_short else max)(stop, breakeven)
                    # A gap through the persisted stop is handled by custom_exit;
                    # returning a negative/zero distance would not update Freqtrade.
                    if (current_rate >= stop if trade.is_short else current_rate <= stop):
                        return None
                    # Freqtrade converts this ratio back to a price then rounds
                    # sell UP / buy DOWN. Send the interior of the same tick cell
                    # so binary float round trips cannot drift one tick per loop.
                    tick = (trade.price_precision if trade.precision_mode_price == TICK_SIZE
                            else 10 ** -trade.price_precision)
                    stop += tick * (.5 if trade.is_short else -.5)
        if (legacy and not trade.is_short
                and getattr(self, 'config', {}).get('trading_mode') == 'spot'
                and current_profit > .008):
            # Legacy spot used a 0.4% trail above 0.8% fee-adjusted profit.
            # Native Trade.adjust_stop_loss retains the tighter persisted stop.
            stop = max(stop, current_rate * (1 - .004))
        return stoploss_from_absolute(stop, current_rate=current_rate, is_short=trade.is_short, leverage=trade.leverage)

    def _flow_invalidation_exit(self, trade, plan, current_time):
        # Prospective only: old positions keep their exact entry-time exits.
        policy = policy_for_plan(plan)
        if (policy is None
                or self.config.get('trading_mode') != 'spot' or trade.is_short
                or self.config.get('dry_run') is not False):
            return None
        try:
            state = trade.get_custom_data(key=FLOW_EXIT_KEY, default=None)
            proof = None
            if not (isinstance(state, dict) and state.get('decision')):
                try:
                    with (ROOT / 'local/demo/order-flow.json').open('rb') as stream:
                        raw = stream.read(4000001)
                    if len(raw) <= 4000000:
                        sample = json.loads(raw)
                        if sample.get('mode') == 'demo':
                            proof = sample.get('markets', {}).get(trade.pair)
                except (OSError, ValueError, TypeError):
                    pass
            updated, should_exit, reason = advance_flow_exit(state, proof, pair=trade.pair,
                tag=trade.enter_tag, opened_at=int(trade.open_date_utc.timestamp()*1000),
                now=int(current_time.timestamp()*1000), policy=policy)
            if updated != state:
                trade.set_custom_data(key=FLOW_EXIT_KEY, value=updated)
            status = trade.get_custom_data(key=FLOW_EXIT_KEY+'_status', default=None)
            if not isinstance(status, dict) or status.get('reason') != reason:
                trade.set_custom_data(key=FLOW_EXIT_KEY+'_status', value={
                    'version': policy['version'], 'reason': reason,
                    'at': current_time.isoformat(), 'tag': trade.enter_tag})
                logger.info('SPOT_FLOW_EXIT pair=%s tag=%s reason=%s', trade.pair, trade.enter_tag, reason)
            return 'rules_flow_invalidated' if should_exit else None
        except Exception:
            # A missing/corrupt optional signal never removes ATR/trailing stops.
            logger.warning('SPOT_FLOW_EXIT_UNAVAILABLE pair=%s tag=%s', trade.pair, trade.enter_tag)
            return None

    def custom_exit(self, pair, trade, current_time, current_rate, current_profit, **kwargs):
        plan = self._rule_plan(trade)
        if not plan:
            return None
        if plan['ruleVersion'] in TRAILING_RULE_VERSIONS:
            try:
                state = self._trailing_state(trade)
                if state and (current_rate >= state['stopPrice'] if trade.is_short else current_rate <= state['stopPrice']):
                    return 'rules_profit_trail'
            except Exception:
                self._trailing_failure(trade)
        if plan['ruleVersion'] in BREAKEVEN_RULE_VERSIONS:
            try:
                state = self._breakeven_state(trade)
                if state and (current_rate >= state['stopPrice'] if trade.is_short else current_rate <= state['stopPrice']):
                    return 'rules_breakeven'
            except Exception:
                self._breakeven_failure(trade)
        change = (current_rate / trade.open_rate - 1) * (-1 if trade.is_short else 1)
        if change <= -plan['stopFraction']:
            return 'rules_stop'
        if change >= plan['targetFraction']:
            return 'rules_target'
        holding_seconds = plan['maxHoldingSeconds'] if plan['ruleVersion'] in (*TIMED_RULE_VERSIONS, PROBE_RULE_VERSION) else plan['maxHoldingBars'] * 900
        if (current_time - trade.open_date_utc).total_seconds() >= holding_seconds:
            return 'rules_time'
        return self._flow_invalidation_exit(trade, plan, current_time)
