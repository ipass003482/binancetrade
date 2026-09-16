"""Prospective model evidence contracts, using synthetic data and mocked inference.

No weights, network, account API, or credentials are loaded by this suite.
"""
from contextlib import nullcontext
from copy import deepcopy
from decimal import Decimal
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import pretrained_model as pm

B = 1_800_000_000_000  # Exactly aligned to a 15-minute boundary.
NOW = B + 10_000
SID = "12345678-1234-1234-1234-123456789abc"


def config():
    return {
        "schemaVersion": 1, "model": "kronos-small-pretrained-v1",
        "executionRole": "advisory", "modes": ["demo", "demo-futures"],
        "timeframe": "5m", "historyBars": 96, "labelHorizonBars": 3,
        "maxPredictionAgeSeconds": 60, "device": "cpu", "threads": 2,
        "sampleCount": 4, "temperature": 1.0, "topP": .9, "seed": 2914,
        "reviewWindows": 100, "minimumReviewWindows": 30, "note": "Test contract",
    }


def candles(boundary=B):
    return [{"openTime": boundary - (96 - i) * pm.MS,
             "closeTime": boundary - (95 - i) * pm.MS - 1,
             "open": "100", "high": "102", "low": "99", "close": "101",
             "volume": "12.50000000"} for i in range(96)]


def snapshot(mode="demo", boundary=B, now=NOW):
    source = pm.SOURCES[mode]
    suffix = "/api/v3/time" if mode == "demo" else "/fapi/v1/time"
    pair = "BTC/USDT" if mode == "demo" else "BTC/USDT:USDT"
    return {
        "id": SID, "mode": mode, "timeframe": "5m", "candleBoundary": boundary,
        "createdAt": pm.utc(now - 2000), "completedAt": pm.utc(now - 500),
        "clock": {"mode": mode, "source": source + suffix,
                  "requestStartedAt": now - 1000, "receivedAt": now - 800,
                  "serverTime": now - 900},
        "markets": [{"pair": pair, "source": source, "mode": mode,
                     "verifiedSpot" if mode == "demo" else "verifiedFutures": True,
                     "candles": candles(boundary),
                     "entryCost": {"status": "ok", "mode": mode, "pair": pair,
                                   "source": source, "estimatedRoundTripCostBps": "20",
                                   "requiredPriceSpaceBps": "30", "observedAt": pm.utc(now)}}],
    }


def raw_klines(cs):
    return [[c["openTime"], c["open"], c["high"], c["low"], c["close"],
             c["volume"], c["closeTime"], "1259.12345678"] for c in cs]


def forecast(mode="demo", close=102):
    s = snapshot(mode)
    return pm.forecast_row(s["markets"][0], [[100, 103, 99, close, 12, 1259]] * 3,
                           mode, B, pm.utc(NOW), pm.cost_view(s["markets"][0], mode, NOW))


@pytest.fixture
def worker(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("kronos_worker_contract_test", ROOT / "scripts/kronos-worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "BASE", tmp_path / "evidence")
    monkeypatch.setattr(module, "now_ms", lambda: NOW)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(manual_seed=lambda _: None,
                                                             inference_mode=nullcontext))
    return module


@pytest.mark.parametrize("mode", pm.MODES)
def test_snapshot_accepts_only_complete_contiguous_closed_demo_history(mode):
    assert pm.validate_snapshot(snapshot(mode), mode, NOW) == B


@pytest.mark.parametrize("mutation", [
    lambda s: s.update(createdAt=pm.utc(NOW + 1)),
    lambda s: s.update(completedAt=pm.utc(NOW + 1)),
    lambda s: s.update(candleBoundary=B + pm.MS),
    lambda s: s.update(purpose="execution_probe"),
    lambda s: s["markets"][0].update(source="https://api.binance.com"),
    lambda s: s["clock"].update(source="https://api.binance.com/api/v3/time"),
    lambda s: s["clock"].update(receivedAt=NOW + 1),
    lambda s: s["clock"].update(serverTime=NOW + 3000),
    lambda s: s["markets"][0]["candles"][-1].update(openTime=B, closeTime=B + pm.MS - 1),
    lambda s: s["markets"][0]["candles"][10].update(openTime=B - 85 * pm.MS),
    lambda s: s["markets"].append(deepcopy(s["markets"][0])),
])
def test_snapshot_rejects_future_data_untrusted_sources_and_gaps(mutation):
    s = snapshot()
    mutation(s)
    with pytest.raises(ValueError):
        pm.validate_snapshot(s, "demo", NOW)


def test_snapshot_cannot_be_backfilled_after_first_minute():
    with pytest.raises(ValueError):
        pm.validate_snapshot(snapshot(), "demo", B + 60_001)


@pytest.mark.parametrize("bad", [True, False, "NaN", "Infinity", "1e51", "1e-51", None])
def test_numbers_reject_ambiguous_nonfinite_or_unbounded_values(bad):
    with pytest.raises(ValueError):
        pm.number(bad)


def test_config_matches_reviewed_contract():
    assert pm.validate_config(config()) == config()


@pytest.mark.parametrize("key,value", [("executionRole", "execution"), ("threads", 3),
                                        ("schemaVersion", True), ("threads", 2.0),
                                        ("temperature", True), ("device", "cuda"),
                                        ("modes", ["live"]), ("seed", "2914")])
def test_config_rejects_unreviewed_values_and_python_numeric_type_aliases(key, value):
    c = config()
    c[key] = value
    with pytest.raises(ValueError):
        pm.validate_config(c)


def test_config_rejects_unknown_keys():
    c = config()
    c["placeOrders"] = True
    with pytest.raises(ValueError):
        pm.validate_config(c)


def test_quote_amount_is_exact_exchange_value_not_close_times_base_volume():
    cs = candles()
    raw = raw_klines(cs)
    raw[0][1] = "100.00000000000000000"  # Decimal equivalence is valid.
    result = pm.exact_amounts(cs, raw, B)
    assert result[0][-1] == 1259.12345678
    assert result[0][-1] != result[0][3] * result[0][4]


@pytest.mark.parametrize("column", [1, 2, 3, 4, 5])
def test_quote_supplement_rejects_even_tiny_candle_revision(column):
    cs = candles()
    raw = raw_klines(cs)
    raw[17][column] = str(Decimal(raw[17][column]) + Decimal("0.000000000001"))
    with pytest.raises(ValueError, match="PROVIDER_CANDLE_REVISED"):
        pm.exact_amounts(cs, raw, B)


@pytest.mark.parametrize("mutation", [lambda raw: raw.pop(), lambda raw: raw.reverse(),
                                      lambda raw: raw[0].__setitem__(7, "-1"),
                                      lambda raw: raw[0].__setitem__(6, raw[0][6] + 1)])
def test_quote_supplement_rejects_incomplete_wrong_time_or_negative_amount(mutation):
    cs = candles()
    raw = raw_klines(cs)
    mutation(raw)
    with pytest.raises(ValueError):
        pm.exact_amounts(cs, raw, B)


@pytest.mark.parametrize("mode", pm.MODES)
def test_supplement_network_route_is_unsigned_fixed_demo_and_closed_only(worker, monkeypatch, mode):
    s = snapshot(mode)
    captured = {}
    payload = json.dumps(raw_klines(s["markets"][0]["candles"])).encode()

    def open_request(request, timeout):
        captured.update(url=request.full_url, method=request.get_method(), headers=dict(request.header_items()), timeout=timeout)
        return io.BytesIO(payload)

    monkeypatch.setattr(worker, "build_opener", lambda handler: SimpleNamespace(open=open_request))
    result = worker.supplement(s, s["markets"][0])
    parsed = urlparse(captured["url"])
    assert "https://" + parsed.netloc == pm.SOURCES[mode]
    assert captured["method"] == "GET"
    assert set(k.lower() for k in captured["headers"]) == {"accept"}
    assert parse_qs(parsed.query) == {"symbol": ["BTCUSDT"], "interval": ["5m"],
                                     "startTime": [str(B - 96 * pm.MS)],
                                     "endTime": [str(B - 1)], "limit": ["96"]}
    assert result["rawResponseSha256"] == pm.digest(payload)


def test_redirects_cannot_change_market_provider(worker):
    with pytest.raises(ValueError, match="REDIRECT_REJECTED"):
        worker.NoRedirect().redirect_request(None, None, 302, "", {}, "https://api.binance.com/")


@pytest.mark.parametrize("mode,close,action", [("demo", 102, "buy"), ("demo", 100, "hold"),
                                                ("demo-futures", 102, "open-long"),
                                                ("demo-futures", 100, "open-short")])
def test_forecast_is_cost_screened_advice_never_realized_profit(mode, close, action):
    row = forecast(mode, close)
    assert row["advisoryAction"] == action
    assert row["targetCloseAt"] == B + 3 * pm.MS - 1
    assert row["forecastBarOpens"] == [B, B + pm.MS, B + 2 * pm.MS]
    assert row["usedForOrders"] is False
    assert "strategyRealizedPnl" not in row


def test_costs_cannot_be_used_after_expiry_or_from_other_market():
    s = snapshot()
    market = s["markets"][0]
    market["entryCost"]["pair"] = "ETH/USDT"
    assert pm.cost_view(market, "demo", NOW)["status"] == "unavailable"
    market["entryCost"]["pair"] = market["pair"]
    assert pm.cost_view(market, "demo", NOW + 900_001)["status"] == "unavailable"


def test_settlement_waits_for_label_close_and_retains_error_baseline():
    row = forecast()
    prediction = {"candleBoundary": B, "issuedExchangeUpperAt": NOW + 100}
    future = candles(B + 3 * pm.MS)
    future[-1]["close"] = "103"
    assert pm.settle_row(prediction, row, future, row["targetCloseAt"]) is None
    settled = pm.settle_row(prediction, row, future, B + 3 * pm.MS)
    assert Decimal(settled["actualCloseReturnBps"]) == (Decimal(103) / 101 - 1) * 10_000
    assert Decimal(settled["modelAbsoluteErrorBps"]) < Decimal(settled["unchangedPriceAbsoluteErrorBps"])
    assert settled["strategyRealizedPnl"] is None


@pytest.mark.parametrize("issued,target_delta", [(B + pm.MS, 0), (B - 1, 0), (NOW, -pm.MS)])
def test_settlement_rejects_backfilled_or_inconsistent_forecast_chronology(issued, target_delta):
    row = forecast()
    row["targetCloseAt"] += target_delta
    prediction = {"candleBoundary": B, "issuedExchangeUpperAt": issued}
    try:
        result = pm.settle_row(prediction, row, candles(B + 3 * pm.MS), B + 3 * pm.MS)
    except ValueError:
        return
    assert result is None, "Corrupt chronology must not count as prospective evidence"


def window(index, model_error=1, baseline_error=2, mode="demo", pairs=1):
    return {"mode": mode, "candleBoundary": B + index * 3 * pm.MS, "complete": True,
            "rows": [{"pair": f"COIN{i}/USDT", "modelAbsoluteErrorBps": str(model_error),
                      "unchangedPriceAbsoluteErrorBps": str(baseline_error)} for i in range(pairs)]}


def test_rolling_review_counts_time_windows_not_cross_asset_rows_or_overlaps():
    data = [window(i, pairs=10) for i in range(29)]
    data += [dict(window(30), complete=False), dict(window(31), candleBoundary=B + pm.MS)]
    review = pm.rolling_review(data)["demo"]
    assert review["independentTimeWindows"] == 29
    assert review["status"] == "collecting"
    assert review["suppressAdvisoryEntries"] is False


def test_rolling_review_distinguishes_no_initial_edge_from_possible_degradation():
    bad = [window(i, model_error=3) for i in range(30)]
    first = pm.rolling_review(bad)["demo"]
    assert first["status"] == "underperforming_baseline"
    assert first["suppressAdvisoryEntries"] is True
    assert first["alphaEstablished"] is False
    improved_then_worse = [window(i) for i in range(30)] + [window(i, model_error=3) for i in range(30, 60)]
    second = pm.rolling_review(improved_then_worse)["demo"]
    assert second["status"] == "possible_degradation"
    assert second["prior"]["maeImprovementBps"] > 0
    assert second["recent"]["maeImprovementBps"] < 0


def test_rolling_review_is_chronological_limited_and_weights_each_window_equally():
    data = [window(i, model_error=100) for i in range(3)]
    data += [window(i, model_error=1 if i % 2 else 3, pairs=1 if i % 2 else 10) for i in range(3, 103)]
    review = pm.rolling_review(list(reversed(data)))["demo"]
    assert review["independentTimeWindows"] == 100
    assert review["recent"]["modelMaeBps"] == 2
    assert review["realizedModelTrades"] == 0
    assert pm.rolling_review(data)["demo-futures"]["independentTimeWindows"] == 0


def test_duplicate_review_window_is_not_additional_evidence():
    with pytest.raises(ValueError, match="DUPLICATE_REVIEW_WINDOW"):
        pm.rolling_review([window(1), window(1)])


def test_repeated_market_in_one_window_is_not_additional_evidence():
    data = window(1, pairs=2)
    data["rows"][1]["pair"] = data["rows"][0]["pair"]
    with pytest.raises(ValueError, match="REVIEW_PAIR_INVALID"):
        pm.rolling_review([data])


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-1", True, "broken"])
def test_invalid_review_errors_cannot_silently_unsuppress_model(bad):
    data = [window(i) for i in range(30)]
    data[-1]["rows"][0]["modelAbsoluteErrorBps"] = bad
    with pytest.raises(ValueError):
        pm.rolling_review(data)


def artifact_manifest(worker, tmp_path):
    expected = {"vendor/Kronos/" + p: sha for p, sha in worker.SOURCE_HASHES.items()}
    for role, (_, _, sha) in worker.CHECKPOINTS.items():
        expected[f"weights/{role}/model.safetensors"] = sha
        expected[f"weights/{role}/config.json"] = worker.CONFIG_HASHES[role]
    return {"sourceCommit": worker.COMMIT,
            "files": [{"path": p, "sha256": sha} for p, sha in expected.items()]}


@pytest.mark.parametrize("change", ["commit", "manifest_hash", "actual_bytes"])
def test_source_and_weight_pins_are_checked_before_model_import(worker, tmp_path, change):
    manifest = artifact_manifest(worker, tmp_path)
    if change == "commit":
        manifest["sourceCommit"] = "0" * 40
    elif change == "manifest_hash":
        manifest["files"][0]["sha256"] = "0" * 64
    else:
        path = worker.BASE / manifest["files"][0]["path"]
        path.parent.mkdir(parents=True)
        path.write_bytes(b"modified source must never execute")
    worker.write(worker.BASE / "artifacts.json", manifest)
    with pytest.raises(ValueError, match="MODEL_(MANIFEST|ARTIFACT)"):
        worker.load_model(config())


class FakePredictor:
    def __init__(self, after=None):
        self.calls = 0
        self.after = after

    def predict_batch(self, frames, x, y, **kwargs):
        self.calls += 1
        assert kwargs["pred_len"] == 3
        assert all(len(frame) == 96 for frame in frames)
        assert x[0].iloc[-1].value // 1_000_000 == B - pm.MS
        assert y[0].iloc[0].value // 1_000_000 == B
        if self.after:
            self.after()
        return [pd.DataFrame([[100, 103, 99, 102, 12, 1259]] * 3) for _ in frames]


def inference_fixture(worker, monkeypatch):
    monkeypatch.setattr(worker, "supplement", lambda s, m: {"pair": m["pair"],
                        "ohlcva": pm.exact_amounts(m["candles"], raw_klines(m["candles"]), B),
                        "source": pm.SOURCES[s["mode"]], "rawResponseSha256": "a" * 64})
    return {"fingerprint": "b" * 64}, {"asOf": pm.utc(NOW), "modes": pm.rolling_review([])}


def test_live_inference_records_before_label_arrives_and_never_rewrites_prediction(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    predictor = FakePredictor()
    s = snapshot()
    result = worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)
    assert result["status"] == "predicted"
    target = worker.BASE / "predictions/demo" / (SID + ".json")
    before = target.read_bytes()
    record = worker.read(target)
    assert record["issuedExchangeUpperAt"] < B + 60_000
    assert record["modelOrders"] == 0
    assert record["strategyRealizedPnl"] is None
    assert not (worker.BASE / "settlements").exists()
    monkeypatch.setattr(worker, "now_ms", lambda: B + 4 * pm.MS)
    assert worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)["status"] == "stale_source"
    assert predictor.calls == 1
    assert target.read_bytes() == before


def test_expired_snapshot_never_invokes_model_or_backfills_prediction(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    monkeypatch.setattr(worker, "now_ms", lambda: B + 3 * pm.MS)
    predictor = FakePredictor()
    s = snapshot()
    with pytest.raises(ValueError):
        worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)
    assert predictor.calls == 0
    assert not (worker.BASE / "predictions").exists()


def test_inference_finishing_after_expiry_is_not_recorded_as_early_forecast(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    predictor = FakePredictor(after=lambda: monkeypatch.setattr(worker, "now_ms", lambda: B + 60_001))
    s = snapshot()
    with pytest.raises(ValueError):
        worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)
    assert predictor.calls == 1
    assert not (worker.BASE / "predictions").exists()


def test_forward_settlement_requires_subsequent_validated_candles(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    s = snapshot()
    worker.infer_snapshot(FakePredictor(), identity, config(), s, pm.digest(s), review)
    worker.settle_all(identity, {"demo": s})
    assert not (worker.BASE / "settlements").exists()
    future_boundary = B + 3 * pm.MS
    future_now = future_boundary + 10_000
    future = snapshot(boundary=future_boundary, now=future_now)
    future["id"] = "87654321-1234-1234-1234-123456789abc"
    monkeypatch.setattr(worker, "now_ms", lambda: future_now)
    review = worker.settle_all(identity, {"demo": future})
    settled = worker.read(worker.BASE / "settlements/demo" / (SID + ".json"))
    assert settled["complete"] is True
    assert settled["evidenceSnapshotId"] == future["id"]
    assert settled["modelOrders"] == 0
    assert settled["rows"][0]["strategyRealizedPnl"] is None
    assert review["modes"]["demo"]["independentTimeWindows"] == 1


def test_settlement_does_not_mix_model_fingerprints(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    s = snapshot()
    worker.infer_snapshot(FakePredictor(), identity, config(), s, pm.digest(s), review)
    future_boundary = B + 3 * pm.MS
    future = snapshot(boundary=future_boundary, now=future_boundary + 10_000)
    monkeypatch.setattr(worker, "now_ms", lambda: future_boundary + 10_000)
    report = worker.settle_all({"fingerprint": "c" * 64}, {"demo": future})
    assert report["modes"]["demo"]["independentTimeWindows"] == 0
    assert not (worker.BASE / "settlements").exists()


def test_modified_prediction_cannot_reuse_previously_scored_settlement(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    s = snapshot()
    worker.infer_snapshot(FakePredictor(), identity, config(), s, pm.digest(s), review)
    future_boundary = B + 3 * pm.MS
    future = snapshot(boundary=future_boundary, now=future_boundary + 10_000)
    monkeypatch.setattr(worker, "now_ms", lambda: future_boundary + 10_000)
    worker.settle_all(identity, {"demo": future})
    path = worker.BASE / "predictions/demo" / (SID + ".json")
    modified = worker.read(path)
    modified["forecasts"][0]["grossForecastReturnBps"] = "0"
    worker.write(path, modified)
    with pytest.raises(ValueError, match="SETTLEMENT_IDENTITY"):
        worker.settle_all(identity, {"demo": future})


def test_recorded_forecast_waits_for_next_cycle_without_reinference(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    predictor = FakePredictor()
    s = snapshot()
    worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)
    target = worker.BASE / "predictions/demo" / (SID + ".json")
    original = target.read_bytes()
    monkeypatch.setattr(worker, "now_ms", lambda: B + pm.MS + 1000)
    status = worker.infer_snapshot(predictor, identity, config(), s, pm.digest(s), review)
    assert status["status"] == "awaiting_next_cycle"
    assert status["predictionAlreadyRecorded"] is True
    assert status["sourceFreshness"]["lastSourceBoundary"] == B
    assert status["sourceFreshness"]["sourceAgeLowerMs"] == pm.MS + 900
    assert predictor.calls == 1
    assert target.read_bytes() == original


@pytest.mark.parametrize("offset", [-1500, 1500])
def test_source_staleness_uses_archived_exchange_bounds_not_raw_local_time(worker, offset):
    s = snapshot()
    s["clock"]["serverTime"] += offset
    # Fixture has +/-100ms offset uncertainty. Mark stale only once the
    # conservative lower age is beyond two cycles, on either clock offset.
    at_limit = B + 2 * pm.MS - offset + 100
    current = worker.source_freshness(s, "demo", at_limit)
    assert current["status"] == "current"
    assert current["sourceAgeLowerMs"] == 2 * pm.MS
    assert current["sourceAgeUpperMs"] == 2 * pm.MS + 200
    assert "not a fresh exchange clock" in current["clockBasis"]
    stale = worker.source_freshness(s, "demo", at_limit + 1)
    assert stale["status"] == "stale"
    assert stale["sourceAgeLowerMs"] == 2 * pm.MS + 1


def test_source_clock_reversal_or_wrong_provider_is_unavailable(worker):
    s = snapshot()
    assert worker.source_freshness(s, "demo", B)["status"] == "unavailable"
    s["clock"]["source"] = "https://api.binance.com/api/v3/time"
    result = worker.source_freshness(s, "demo", B + pm.MS)
    assert result["status"] == "unavailable"
    assert result["reason"] == "MODEL_CLOCK_SOURCE"


def test_stale_review_keeps_last_scored_target_and_cannot_look_fresh(worker, monkeypatch):
    identity, review = inference_fixture(worker, monkeypatch)
    s = snapshot()
    worker.infer_snapshot(FakePredictor(), identity, config(), s, pm.digest(s), review)
    future_boundary = B + 3 * pm.MS
    future = snapshot(boundary=future_boundary, now=future_boundary + 10_000)
    monkeypatch.setattr(worker, "now_ms", lambda: future_boundary + 10_000)
    first = worker.settle_all(identity, {"demo": future})
    first_mode = first["modes"]["demo"]
    assert first_mode["status"] == "collecting"
    assert first_mode["lastSettledTargetAt"] == pm.utc(future_boundary - 1)
    monkeypatch.setattr(worker, "now_ms", lambda: future_boundary + 3 * pm.MS)
    stale = worker.settle_all(identity, {"demo": future})
    assert stale["asOf"] != first["asOf"]
    stale_mode = stale["modes"]["demo"]
    assert stale_mode["status"] == "stale_source"
    assert stale_mode["diagnosticStatus"] == "collecting"
    assert stale_mode["suppressAdvisoryEntries"] is True
    assert stale_mode["lastSettledTargetAt"] == first_mode["lastSettledTargetAt"]
    assert stale_mode["sourceFreshness"]["lastSourceBoundary"] == future_boundary


def test_missing_sources_are_visible_in_worker_status_and_review(worker, monkeypatch):
    identity, _ = inference_fixture(worker, monkeypatch)
    identity["checkpoint"] = "test-checkpoint"
    monkeypatch.setattr(worker, "latest_snapshot", lambda mode: (None, None))
    predictor = FakePredictor()
    status = worker.run_once(predictor, identity, config())
    assert {s["mode"] for s in status["states"]} == set(pm.MODES)
    assert all(s["status"] == "unavailable" and s["lastSettledTargetAt"] is None for s in status["states"])
    review = worker.read(worker.BASE / "review.json")
    assert all(v["status"] == "unavailable" and v["suppressAdvisoryEntries"] for v in review["modes"].values())
    assert predictor.calls == 0
