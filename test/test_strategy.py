import importlib.util
from pathlib import Path
import pytest
from pandas import DataFrame

path = Path(__file__).resolve().parents[1] / "freqtrade/strategies/CodexResearchSpot.py"
spec = importlib.util.spec_from_file_location("research_strategy", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def strategy(config=None):
    return module.CodexResearchSpot(config or {"dry_run": True, "trading_mode": "spot", "exchange": {"name": "binance"}})

def test_entries_are_only_from_bridge():
    s = strategy()
    s.bot_start()
    result = s.populate_entry_trend(DataFrame({"close": [100, 101, 99]}), {})
    assert result.enter_long.sum() == 0
    assert s.stoploss == -0.02
    assert s.minimal_roi["0"] == 0.03
    assert s.position_adjustment_enable is False

@pytest.mark.parametrize("config", [
    {"dry_run": False, "exchange": {"name": "binance"}},
    {"dry_run": True, "trading_mode": "futures", "exchange": {"name": "binance"}},
    {"dry_run": True, "exchange": {"name": "binance", "key": "not-a-real-key"}},
    {"dry_run": True, "exchange": {"name": "other"}},
    {"dry_run": True, "exchange": {"name": "binance"}, "position_adjustment_enable": True},
])
def test_rejects_non_project_execution(config):
    with pytest.raises(ValueError):
        strategy(config).bot_start()

def test_entry_confirmation_rejects_unbounded_or_unattributed_orders():
    s = strategy({"dry_run": True, "stake_amount": 25, "exchange": {"name": "binance", "pair_whitelist": ["BTC/USDT"]}})
    args = dict(pair="BTC/USDT", order_type="market", amount=0.0002, rate=100000, time_in_force="GTC", current_time=None, entry_tag="codex-test", side="long")
    assert s.confirm_trade_entry(**args) is True
    for override in [{"amount": 1}, {"entry_tag": "manual"}, {"side": "short"}, {"rate": "NaN"}, {"pair": "FAKE/USDT"}]:
        assert s.confirm_trade_entry(**(args | override)) is False

def test_exact_native_stake_division_is_accepted_without_increasing_limit():
    s = strategy({"dry_run": True, "stake_amount": 25, "exchange": {"name": "binance", "pair_whitelist": ["BTC/USDT"]}})
    rate = 79000.01
    args = dict(pair="BTC/USDT", order_type="market", amount=25 / rate, rate=rate, time_in_force="GTC",
        current_time=None, entry_tag="codex-test", side="long")
    assert s.confirm_trade_entry(**args)
    assert not s.confirm_trade_entry(**(args | {"amount": 25.000001 / rate}))
