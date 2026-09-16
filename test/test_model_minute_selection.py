"""Minute flow must not turn a frozen5m observer into duplicate inference."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from pretrained_model import model_cycle_snapshot

B = 1_800_000_000_000


def minute_snapshot(minute):
    return {"id": str(minute), "mode": "demo", "timeframe": "5m", "candleBoundary": B,
            "completedAt": "2027-01-15T08:00:05.000Z", "decisionCadenceVersion": "flow-minute-v1",
            "decisionIntervalMs": 60000, "decisionBoundary": B + minute * 60000}


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_only_first_minute_is_a_new_model_candle():
    assert model_cycle_snapshot({"candleBoundary": B})
    assert model_cycle_snapshot(minute_snapshot(0))
    assert all(not model_cycle_snapshot(minute_snapshot(i)) for i in range(1, 5))


@pytest.mark.parametrize("change", [{"decisionCadenceVersion": "unknown"}, {"decisionIntervalMs": 300000},
                                    {"decisionIntervalMs": True}, {"decisionBoundary": B + 1},
                                    {"decisionBoundary": B + 300000}, {"candleBoundary": B + 1}])
def test_malformed_metadata_does_not_disappear_into_legacy_or_skip(change):
    with pytest.raises(ValueError, match="DECISION_TIMING_INVALID"):
        model_cycle_snapshot({**minute_snapshot(0), **change})


@pytest.mark.parametrize("name", ["kronos-worker", "kronos-horizon-lab"])
def test_observers_select_original_candle_behind_four_new_minute_snapshots(name, monkeypatch, tmp_path):
    worker = module(name)
    monkeypatch.setattr(worker, "ROOT", tmp_path)
    if name == "kronos-horizon-lab":
        monkeypatch.setattr(worker, "validate_snapshot", lambda snapshot, mode, now: B)
    runs = tmp_path / "local/demo/runs"
    runs.mkdir(parents=True)
    for i in range(5):
        path = runs / f"{i}.snapshot.json"
        path.write_text(json.dumps(minute_snapshot(i)), encoding="utf-8")
        os.utime(path, ns=(B * 1000000 + i, B * 1000000 + i))
    selected = worker.latest_snapshot("demo")[0] if name == "kronos-worker" else worker.latest_closed_snapshot("demo")[1]
    assert selected["id"] == "0"


@pytest.mark.parametrize("name", ["kronos-worker", "kronos-horizon-lab"])
def test_observers_do_not_infer_from_minute_two_if_first_minute_missing(name, monkeypatch, tmp_path):
    worker = module(name)
    monkeypatch.setattr(worker, "ROOT", tmp_path)
    runs = tmp_path / "local/demo/runs"
    runs.mkdir(parents=True)
    (runs / "later.snapshot.json").write_text(json.dumps(minute_snapshot(1)), encoding="utf-8")
    assert worker.latest_snapshot("demo") == (None, None) if name == "kronos-worker" else worker.latest_closed_snapshot("demo") is None
