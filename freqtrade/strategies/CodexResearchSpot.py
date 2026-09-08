"""Spot dry-run strategy. Entries arrive only through the guarded local bridge.
Fixed exits remain active even while Codex is unavailable. Not a proven strategy.
"""
from decimal import Decimal
from pandas import DataFrame
from freqtrade.strategy import IStrategy

class CodexResearchSpot(IStrategy):
    INTERFACE_VERSION = 3
    can_short = False
    timeframe = "15m"
    startup_candle_count = 20
    process_only_new_candles = True
    minimal_roi = {"0": 0.03, "120": 0.015, "360": 0.005}
    stoploss = -0.02
    trailing_stop = False
    position_adjustment_enable = False
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    def bot_start(self, **kwargs) -> None:
        if self.config.get("dry_run") is not True or self.config.get("trading_mode", "spot") != "spot":
            raise ValueError("CodexResearchSpot supports Binance spot dry-run only")
        if self.config.get("exchange", {}).get("name") != "binance":
            raise ValueError("This project is dedicated to Binance")
        if self.config.get("exchange", {}).get("key") or self.config.get("exchange", {}).get("secret"):
            raise ValueError("Exchange credentials are unnecessary and rejected in this dry-run project")
        if self.config.get("position_adjustment_enable", False):
            raise ValueError("Position adjustment is not supported")

    def confirm_trade_entry(self, pair, order_type, amount, rate, time_in_force,
                            current_time, entry_tag, side, **kwargs) -> bool:
        if self.config.get("dry_run") is not True:
            return False
        return self.entry_allowed(pair, order_type, amount, rate, time_in_force, current_time, entry_tag, side, **kwargs)

    def entry_allowed(self, pair, order_type, amount, rate, time_in_force,
                      current_time, entry_tag, side, **kwargs):
        try:
            return (side == "long"
                    and isinstance(entry_tag, str) and entry_tag.startswith("codex-")
                    and pair in self.config.get("exchange", {}).get("pair_whitelist", [])
                    and Decimal(str(amount)) > 0
                    and Decimal(str(rate)) > 0
                    # Freqtrade passes amount as the binary-float result stake / rate.
                    # Compare in that same input representation, avoiding a spurious
                    # rejection when reconstructing the notional produces 25.000...004.
                    and Decimal(str(amount)) <= Decimal(str(
                        float(self.config.get("stake_amount", 0)) / float(rate))))
        except (ArithmeticError, ValueError, TypeError):
            return False

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["enter_long"] = 0
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["exit_long"] = 0
        return dataframe
