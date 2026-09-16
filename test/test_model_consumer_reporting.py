"""Consumer configuration is not executed-trade evidence; no model/network loads."""
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
FINGERPRINT = "a" * 64
MODEL = "kronos-small-pretrained-v1"


@pytest.fixture
def worker(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("kronos_consumer_reporting_test", ROOT / "scripts/kronos-worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "BASE", tmp_path / "local/model-research")
    monkeypatch.setattr(module, "now_ms", lambda: 1_800_000_010_000)
    monkeypatch.setattr(module, "latest_snapshot", lambda _: (None, None))
    return module


def identity():
    return {"model": MODEL, "fingerprint": FINGERPRINT, "checkpoint": "pinned-test-checkpoint"}


def execution_config():
    return {"schemaVersion": 1, "enabled": True, "model": MODEL,
            "modelFingerprint": FINGERPRINT, "maxWaitSeconds": 35, "maxPredictionAgeSeconds": 60}


def save_config(worker, value):
    worker.write(worker.ROOT / "config/model-execution.json", value)


def assert_no_inferred_fills(result):
    assert result["evidenceScope"] == "configuration_only"
    assert result["actualModelOrderCount"] is None
    assert result["actualModelRealizedPnl"] is None


def test_absent_consumer_config_is_disconnected_not_zero_trades(worker):
    result = worker.consumer_integration(identity())
    assert result["enabled"] is False
    assert result["status"] == "disconnected"
    assert result["reason"] == "MODEL_EXECUTION_CONFIG_MISSING"
    assert_no_inferred_fills(result)


def test_pinned_consumer_can_be_configured_without_asserting_execution(worker):
    save_config(worker, execution_config())
    result = worker.consumer_integration(identity())
    assert result["enabled"] is True
    assert result["status"] == "configured"
    assert result["consumer"] == "v11_demo_rule_entry"
    assert result["modelFingerprint"] == FINGERPRINT
    assert_no_inferred_fills(result)


@pytest.mark.parametrize("mutation,reason", [
    ({"enabled": False}, "MODEL_EXECUTION_DISABLED"),
    ({"modelFingerprint": "b" * 64}, "MODEL_EXECUTION_FINGERPRINT_MISMATCH"),
    ({"schemaVersion": True}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"schemaVersion": 2}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"enabled": 1}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"model": "another-model"}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"modelFingerprint": "not-a-fingerprint"}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"modelFingerprint": None}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"maxWaitSeconds": 35.0}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"maxWaitSeconds": 36}, "MODEL_EXECUTION_CONFIG_INVALID"),
    ({"maxPredictionAgeSeconds": 61}, "MODEL_EXECUTION_CONFIG_INVALID"),
])
def test_disabled_mismatched_or_invalid_consumer_never_appears_connected(worker, mutation, reason):
    save_config(worker, {**execution_config(), **mutation})
    result = worker.consumer_integration(identity())
    assert result["enabled"] is False
    assert result["reason"] == reason
    assert_no_inferred_fills(result)


@pytest.mark.parametrize("raw", ["{", "[]", "null", '"enabled"'])
def test_unreadable_config_cannot_look_enabled(worker, raw):
    path = worker.ROOT / "config/model-execution.json"
    path.parent.mkdir(parents=True)
    path.write_text(raw, encoding="utf-8")
    result = worker.consumer_integration(identity())
    assert result["enabled"] is False
    assert result["reason"] == "MODEL_EXECUTION_CONFIG_INVALID"


def test_status_and_report_scope_producer_flags_and_do_not_invent_actual_fills(worker):
    save_config(worker, execution_config())
    status = worker.run_once(None, identity(), {})
    assert status["consumerIntegration"]["enabled"] is True
    assert status["usedForOrders"] is False
    assert status["usedForOrdersScope"] == "forecast_producer_only"
    assert status["orderAuthority"] == "none"
    assert status["downstreamUsage"] == "see_host_execution_evidence"
    report = (worker.BASE / "report.md").read_text(encoding="utf-8")
    assert "與目前模型指紋一致的 v11 DEMO" in report
    assert "設定啟用本身不是已下單或已成交的證據" in report
    assert "不代表主程式沒有使用模型或沒有實際成交" in report
    assert "沒有模型下單或模型實現獲利" not in report
    assert "v10 Demo 交易獨立繼續" not in report
    assert "forecast_error_diagnostics_only" in report
    review = worker.read(worker.BASE / "review.json")
    assert review["scope"] == "forecast_error_diagnostics_only"
    assert review["strategyRealizedPnl"] is None
    for mode in review["modes"].values():
        assert "realizedModelTrades" not in mode
        assert mode["actualModelOrderCount"] is None
        assert mode["actualModelRealizedPnl"] is None


def test_status_rereads_config_when_consumer_is_disabled(worker):
    save_config(worker, execution_config())
    worker.run_once(None, identity(), {})
    save_config(worker, {**execution_config(), "enabled": False})
    result = worker.run_once(None, identity(), {})
    assert result["consumerIntegration"]["enabled"] is False
    report = (worker.BASE / "report.md").read_text(encoding="utf-8")
    assert "目前模型尚未連接有效的進場讀取設定" in report
    assert "MODEL_EXECUTION_DISABLED" in report
    assert "與目前模型指紋一致的 v11 DEMO" not in report


def test_consumer_reporting_preserves_old_forecast_archives(worker):
    record = {"modelFingerprint": "b" * 64, "forecasts": [],
              "usedForOrders": False, "modelOrders": 0, "strategyRealizedPnl": None}
    archived = worker.BASE / "predictions/demo/old.json"
    latest = worker.BASE / "latest-demo.json"
    worker.write(archived, record)
    worker.write(latest, record)
    before = [path.read_bytes() for path in [archived, latest]]
    save_config(worker, execution_config())
    worker.run_once(None, identity(), {})
    assert [path.read_bytes() for path in [archived, latest]] == before


def test_failed_diagnostic_review_keeps_unknown_accounting_scope(worker, monkeypatch):
    def fail(*_):
        raise ValueError("MODEL_SETTLEMENT_IDENTITY")
    monkeypatch.setattr(worker, "settle_all", fail)
    worker.run_once(None, identity(), {})
    review = worker.read(worker.BASE / "review.json")
    assert review["reason"] == "MODEL_SETTLEMENT_IDENTITY"
    assert review["scope"] == "forecast_error_diagnostics_only"
    assert review["strategyRealizedPnl"] is None
    assert all(mode["actualModelOrderCount"] is None for mode in review["modes"].values())
