"""Binance Demo-only variant. Native adapter provides destination guards."""
from CodexResearchSpot import CodexResearchSpot
from RuleExits import RuleExits

class CodexDemoSpot(RuleExits, CodexResearchSpot):
    timeframe = '5m'
    minimal_roi = {}
    trailing_stop = False

    def bot_start(self, **kwargs):
        if (self.config.get("dry_run") is not False
            or self.config.get("trading_mode") != "spot"
            or self.config.get("exchange", {}).get("name") != "binance"
            or self.config["exchange"].get("demo_trading") is not True
            or self.config.get("bot_name") != "binance-trade-demo"):
            raise ValueError("Binance Demo spot identity required")
        # The guarded process sets this marker through its exchange adapter.
        if not getattr(self.dp._exchange, "demo_destination_guard", False):
            raise ValueError("Guarded Demo adapter required")
        self.configure_rule_exits()
    def confirm_trade_entry(self, *args, **kwargs):
        # Reuse amount, tag, pair and side checks without changing config.
        try:
            self.bot_start()
            return self.entry_allowed(*args, **kwargs) and self.entry_risk_allowed(*args, **kwargs)
        except Exception:
            # Freqtrade's outer callback wrapper defaults to True on exceptions.
            # Every failure here must therefore become an explicit rejection.
            return False
