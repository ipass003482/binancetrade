"""Demo-only perpetual long/short strategy; bridge owns entries, engine owns exits."""
import math
from freqtrade.strategy import IStrategy
from RuleExits import RuleExits

class CodexDemoFutures(RuleExits, IStrategy):
    INTERFACE_VERSION = 3
    can_short = True
    timeframe = '5m'
    startup_candle_count = 20
    process_only_new_candles = True
    minimal_roi = {}
    stoploss = -0.02
    trailing_stop = False
    position_adjustment_enable = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    def bot_start(self, **kwargs):
        if (self.config.get('dry_run') is not False or self.config.get('trading_mode') != 'futures'
            or self.config.get('margin_mode') != 'isolated' or self.config.get('bot_name') != 'binance-trade-demo-futures'
            or self.config.get('exchange', {}).get('demo_trading') is not True
            or self.config.get('position_adjustment_enable') is not False
            or not getattr(self.dp._exchange, 'demo_futures_destination_guard', False)):
            raise ValueError('Guarded isolated Demo futures identity required')
        self.configure_rule_exits()

    def leverage(self, pair, current_time, current_rate, proposed_leverage, max_leverage, entry_tag, side, **kwargs):
        return min(1.0, max_leverage)

    def confirm_trade_entry(self, pair, order_type, amount, rate, time_in_force, current_time, entry_tag, side, **kwargs):
        try:
            self.bot_start()
            return (side in ('long', 'short') and isinstance(entry_tag, str) and entry_tag.startswith('codex-')
                and pair in self.config.get('exchange', {}).get('pair_whitelist', [])
                and all(math.isfinite(v) and v > 0 for v in (amount, rate))
                and amount * rate <= 150 + 1e-8
                and self.entry_risk_allowed(pair, order_type, amount, rate, time_in_force, current_time, entry_tag, side, **kwargs))
        except Exception:
            # Freqtrade's outer callback wrapper defaults to True on exceptions.
            return False

    def populate_indicators(self, dataframe, metadata):
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe['enter_long'] = 0
        dataframe['enter_short'] = 0
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe['exit_long'] = 0
        dataframe['exit_short'] = 0
        return dataframe
