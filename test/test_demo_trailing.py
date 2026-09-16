"""Exercise installed Freqtrade trailing logic, not a duplicate implementation."""
import sys
from pathlib import Path
from datetime import datetime, timezone
import pytest
from freqtrade.persistence import LocalTrade

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'freqtrade/strategies'))
from CodexDemoSpot import CodexDemoSpot
from CodexResearchSpot import CodexResearchSpot


def test_demo_trailing_activates_after_fees_and_never_loosens():
    strategy = CodexDemoSpot({'dry_run': False, 'trading_mode': 'spot'})
    trade = LocalTrade(pair='ETH/USDT', open_rate=100, amount=3, stake_amount=300,
                       fee_open=0.001, fee_close=0.001, is_short=False, leverage=1,
                       open_date=datetime.now(timezone.utc))
    trade.recalc_open_trade_value()
    now = datetime.now(timezone.utc)
    def adjust(rate):
        strategy.ft_stoploss_adjust(rate, trade, now, trade.calc_profit_ratio(rate), 0)
    adjust(100.8)  # 0.8% gross does not yet clear 0.8% net.
    assert trade.stop_loss == pytest.approx(98)
    adjust(101.1)
    assert trade.stop_loss == pytest.approx(101.1 * 0.996)
    adjust(102)
    protected = trade.stop_loss
    assert protected == pytest.approx(102 * 0.996)
    adjust(101.8)
    assert trade.stop_loss == protected
    adjust(100.5)
    assert trade.stop_loss == protected
    assert CodexResearchSpot.trailing_stop is False
