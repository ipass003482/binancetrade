"""Frozen horizon-lab contracts, mocked inference and immutable evidence replay.

No weights, network, credentials, account reads or trading runtime are used.
"""
from contextlib import nullcontext
from copy import deepcopy
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import UUID

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import horizon_lab as lab
from pretrained_model import SOURCES, MS, digest, utc

B = 1_800_000_000_000
PIN = "a" * 64
LAB_PIN = "b" * 64
SID = "12345678-1234-1234-1234-123456789abc"


def encoded(value):
    return (json.dumps(value, indent=2) + "\n").encode()


def snapshot(mode="demo", boundary=B, sid=SID):
    source = SOURCES[mode]
    suffix = "/api/v3/time" if mode == "demo" else "/fapi/v1/time"
    pair = "BTC/USDT" if mode == "demo" else "BTC/USDT:USDT"
    clock = {"mode": mode, "source": source + suffix, "requestStartedAt": boundary + 4500,
             "receivedAt": boundary + 4700, "serverTime": boundary + 4500}
    candles = [{"openTime": boundary - (96 - i) * MS, "closeTime": boundary - (95 - i) * MS - 1,
                "open": "101", "high": "104", "low": "99", "close": "101", "volume": "12"} for i in range(96)]
    market = {"pair": pair, "mode": mode, "source": source, "candles": candles,
              "verifiedSpot" if mode == "demo" else "verifiedFutures": True, "clock": clock,
              "bid": "100.99", "ask": "101.01", "fetchedAt": utc(boundary + 6000), "quoteAsOf": None,
              "entryCost": {"status": "ok", "mode": mode, "pair": pair, "source": source,
                            "observedAt": utc(boundary + 5000), "roundTripFeeBps": "10",
                            "spreadBps": "2", "slippageBpsPerSide": 4, "fundingReserveBps": "0",
                            "estimatedRoundTripCostBps": "20", "requiredPriceSpaceBps": "50"}}
    return {"id": sid, "mode": mode, "timeframe": "5m", "clock": clock, "candleBoundary": boundary,
            "createdAt": utc(boundary + 5000), "completedAt": utc(boundary + 8000), "markets": [market]}


def bundle(mode="demo", boundary=B, sid=SID):
    s = snapshot(mode, boundary, sid)
    pair, source = s["markets"][0]["pair"], SOURCES[mode]
    raw_snapshot = encoded(s)
    inputs = {"snapshotId": sid, "mode": mode, "snapshotSha256": digest(raw_snapshot), "candleBoundary": boundary,
              "clock": s["clock"], "inputs": [{"pair": pair, "source": source + ("/api/v3/klines" if mode == "demo" else "/fapi/v1/klines"),
                                                "requestStartedAt": boundary + 9000, "receivedAt": boundary + 10000,
                                                "rawResponseSha256": "c" * 64, "ohlcva": [[101, 104, 99, 101, 12, 1212]] * 96}]}
    raw_input = encoded(inputs)
    producer = {"schemaVersion": 1, "source": "frozen-pretrained-kronos", "model": "kronos-small-pretrained-v1",
                "modelFingerprint": PIN, "snapshotId": sid, "mode": mode, "snapshotSha256": digest(raw_snapshot),
                "inputSha256": digest(raw_input), "candleBoundary": boundary, "pretrained": True, "fineTuned": False,
                "sampleCount": 4, "usedForOrders": False, "startedAt": utc(boundary + 9000), "issuedAt": utc(boundary + 15000),
                "issuedExchangeLowerAt": boundary + 14800, "issuedExchangeUpperAt": boundary + 15000,
                "expectedPairs": 1, "errors": [], "forecasts": [{"pair": pair, "issuedAt": utc(boundary + 15000),
                  "targetCloseAt": boundary + 3 * MS - 1, "forecastBarOpens": [boundary + i * MS for i in range(3)],
                  "forecastCloses": ["102"] * 3, "originClose": "101"}]}
    raw_producer = encoded(producer)
    raw = {"snapshot": raw_snapshot, "input": raw_input, "producer": raw_producer}
    validated = lab.validate_bundle(s, producer, inputs, mode=mode, pin=PIN,
                                    snapshot_sha=digest(raw_snapshot), input_sha=digest(raw_input),
                                    producer_sha=digest(raw_producer), now=boundary + 20000)
    return {"snapshot": s, "inputs": inputs, "producer": producer, "raw": raw, "validated": validated}


def revalidate(value, now=B + 20000):
    return lab.validate_bundle(value["snapshot"], value["producer"], value["inputs"], mode=value["snapshot"]["mode"],
                               pin=PIN, snapshot_sha=digest(value["raw"]["snapshot"]),
                               input_sha=digest(value["raw"]["input"]), producer_sha=digest(value["raw"]["producer"]), now=now)


def prediction(boundary=B, mode="demo", sid=SID, eligible=True):
    s = snapshot(mode, boundary, sid)
    row = lab.forecast_prefixes(s["markets"][0], [[101, 104, 99, 102, 12, 1212]] * 12,
                                mode, boundary, boundary + 25000)
    return {"schemaVersion": 1, "experiment": lab.SCHEMA, "labFingerprint": LAB_PIN, "mode": mode,
            "snapshotId": sid, "candleBoundary": boundary, "generationBars": 12, "horizons": [3, 6, 12],
            "expectedPairs": [row["pair"]], "missingPairs": [], "rows": [row], "eligible": eligible,
            "issuedAt": utc(boundary + 25000), "issuedExchangeUpperAt": boundary + 25000,
            "totalSeconds": 5, "usedForOrders": False}


def future(boundary=B + 12 * MS, mode="demo", sid="23456789-1234-1234-1234-123456789abc"):
    s = snapshot(mode, boundary, sid)
    for candle in s["markets"][0]["candles"]:
        candle["close"] = "103"
    return s


def settlement(p, horizon):
    label = future(p["candleBoundary"] + horizon * MS, p["mode"])
    row = lab.settle_horizon(p, p["rows"][0], horizon, label["markets"][0]["candles"], label["candleBoundary"])
    return {"mode": p["mode"], "snapshotId": p["snapshotId"], "labFingerprint": LAB_PIN,
            "horizonBars": horizon, "candleBoundary": p["candleBoundary"], "expectedPairs": p["expectedPairs"],
            "predictionSha256": digest(encoded(p)), "predictionContentSha256": digest(p), "rows": [row],
            "settledAt": utc(label["candleBoundary"] + 10000)}


@pytest.mark.parametrize("mode", ["demo", "demo-futures"])
def test_bundle_uses_exact_current_producer_snapshot_and_input_hashes(mode):
    value = bundle(mode)
    assert revalidate(value)["expectedPairs"] == [value["snapshot"]["markets"][0]["pair"]]


@pytest.mark.parametrize("mutate", [
    lambda b: b["producer"].update(modelFingerprint="f" * 64),
    lambda b: b["producer"].update(snapshotSha256="f" * 64),
    lambda b: b["producer"].update(inputSha256="f" * 64),
    lambda b: b["producer"].update(issuedAt=utc(B + 21000)),
    lambda b: b["producer"].update(issuedExchangeUpperAt=B + 14900),
    lambda b: b["inputs"]["inputs"][0]["ohlcva"][0].__setitem__(3, 999),
    lambda b: b["inputs"]["inputs"][0].update(source="https://example.test/klines"),
    lambda b: b["inputs"].update(inputs=[]),
    lambda b: b["producer"].update(expectedPairs=2),
])
def test_invalid_or_future_producer_evidence_cannot_start_inference(mutate):
    value = bundle()
    mutate(value)
    with pytest.raises(ValueError):
        revalidate(value)


def test_cannot_backfill_old_snapshots_or_extend_the_first_minute():
    with pytest.raises(ValueError):
        revalidate(bundle(), now=B + 60001)


def test_prefixes_keep_cost_components_original_quote_and_exact_additive_reference():
    s = snapshot()
    row = lab.forecast_prefixes(s["markets"][0], [[101, 104, 99, 102 + i / 10, 12, 1212] for i in range(12)], "demo", B, B + 25000)
    assert row["originalCost"] == s["markets"][0]["entryCost"]
    assert row["originalQuoteFetchedAt"] == s["markets"][0]["fetchedAt"]
    assert row["originalQuoteAsOf"] is None
    assert [x["forecastClose"] for x in row["horizons"]] == ["102.2", "102.5", "103.1"]
    for assessment in row["horizons"]:
        difference = (Decimal(assessment["modeledMoveAtQuoteReferenceBps"]) + Decimal(assessment["quoteGapAtQuoteReferenceBps"])
                      - Decimal(assessment["quoteToForecastBps"]))
        assert abs(difference) < Decimal("1e-22")
        assert assessment["generationBars"] == 12


@pytest.mark.parametrize("field,value", [("fetchedAt", None), ("fetchedAt", utc(B - MS)), ("bid", "0"), ("ask", "99")])
def test_missing_stale_or_invalid_quote_is_not_synthesized(field, value):
    s = snapshot()
    s["markets"][0][field] = value
    with pytest.raises((ValueError, TypeError)):
        lab.forecast_prefixes(s["markets"][0], [[101, 104, 99, 102, 12, 1212]] * 12, "demo", B, B + 25000)


def test_missing_costs_or_older_than_current_300_second_contract_are_rejected():
    for cost in [{"status": "unavailable"}, {**snapshot()["markets"][0]["entryCost"], "observedAt": utc(B - 300000)}]:
        s = snapshot()
        s["markets"][0]["entryCost"] = cost
        with pytest.raises(ValueError):
            lab.forecast_prefixes(s["markets"][0], [[101, 104, 99, 102, 12, 1212]] * 12, "demo", B, B + 25000)


def test_spot_downward_path_holds_but_futures_records_short_cost_coverage():
    rows = {}
    for mode in ["demo", "demo-futures"]:
        rows[mode] = lab.forecast_prefixes(snapshot(mode)["markets"][0], [[101, 104, 99, 100, 12, 1212]] * 12, mode, B, B + 25000)
    assert all(r["direction"] == "hold" and not r["predictedCostCover"] for r in rows["demo"]["horizons"])
    assert all(r["direction"] == "short" and r["predictedCostCover"] for r in rows["demo-futures"]["horizons"])


def test_outcome_waits_for_exact_horizon_close_and_does_not_create_trade_pnl():
    p = prediction()
    candles = future()["markets"][0]["candles"]
    assert lab.settle_horizon(p, p["rows"][0], 3, candles, B + 3 * MS - 1) is None
    row = lab.settle_horizon(p, p["rows"][0], 3, candles, B + 3 * MS)
    assert row["strategyRealizedPnl"] is None
    assert Decimal(row["modelAbsoluteErrorBps"]) < Decimal(row["unchangedPriceAbsoluteErrorBps"])
    assert row["actualCostCoverForPredictedDirection"] is True
    missing = [c for c in candles if c["openTime"] != B + MS]
    assert lab.settle_horizon(p, p["rows"][0], 3, missing, B + 3 * MS) is None


def test_late_predictions_can_never_become_scored_forecasts():
    p = prediction(eligible=False)
    with pytest.raises(ValueError, match="PREDICTION_IDENTITY"):
        lab.settle_horizon(p, p["rows"][0], 3, future()["markets"][0]["candles"], B + 12 * MS)
    p["eligible"] = True
    p["issuedExchangeUpperAt"] = B + 60000
    with pytest.raises(ValueError, match="CHRONOLOGY"):
        lab.settle_horizon(p, p["rows"][0], 3, future()["markets"][0]["candles"], B + 12 * MS)


def review_fixture(count=30):
    predictions = [prediction(B + i * 12 * MS, sid=str(UUID(int=i + 1))) for i in range(count)]
    settlements = [settlement(p, h) for p in predictions for h in [3, 6, 12]]
    return predictions, settlements, utc(B + (count + 1) * 12 * MS)


def test_review_requires_30_independent_paired_hourly_windows_and_never_selects_winner():
    ps, ss, at = review_fixture(29)
    first = lab.review(ss, ps, LAB_PIN, at)
    assert first["modes"]["demo"]["independentMatchedWindows"] == 29
    assert first["modes"]["demo"]["status"] == "collecting"
    ps, ss, at = review_fixture(30)
    result = lab.review(ss, ps, LAB_PIN, at)
    assert result["modes"]["demo"]["status"] == "comparison_available_for_manual_research"
    assert result["recommendedHorizon"] is None
    assert result["holdoutValidated"] is False
    assert result["promotionAuthorized"] is False


def test_orphan_future_late_and_changed_prediction_settlements_cannot_manufacture_review_floor():
    ps, ss, at = review_fixture(30)
    with pytest.raises(ValueError, match="ORPHAN"):
        lab.review(ss, [], LAB_PIN, at)
    with pytest.raises(ValueError):
        lab.review(ss, ps, LAB_PIN, utc(B))
    ps[0]["eligible"] = False
    with pytest.raises(ValueError, match="PREDICTION_IDENTITY"):
        lab.review(ss, ps, LAB_PIN, at)
    ps[0]["eligible"] = True
    ps[0]["rows"][0]["forecastCloses"][0] = "200"
    with pytest.raises(ValueError, match="PREDICTION_LINK"):
        lab.review(ss, ps, LAB_PIN, at)


def test_duplicate_missing_horizon_partial_pairs_and_nonhour_starts_are_not_more_evidence():
    ps, ss, at = review_fixture(2)
    with pytest.raises(ValueError, match="DUPLICATE_REVIEW_HORIZON"):
        lab.review(ss + [deepcopy(ss[0])], ps, LAB_PIN, at)
    result = lab.review(ss[:-1], ps, LAB_PIN, at)
    assert result["modes"]["demo"]["independentMatchedWindows"] == 1
    p = prediction(B + MS, sid=str(UUID(int=111)))
    extra = [settlement(p, h) for h in [3, 6, 12]]
    result = lab.review(ss + extra, ps + [p], LAB_PIN, at)
    assert result["modes"]["demo"]["independentMatchedWindows"] == 2


@pytest.fixture
def runner(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("horizon_lab_runner_test", ROOT / "scripts/kronos-horizon-lab.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "BASE", tmp_path / "local/horizon-lab")
    monkeypatch.setattr(module, "PRODUCER", tmp_path / "local/model-research")
    clock = {"now": B + 20000, "mono": 0.0, "calls": 0}
    monkeypatch.setattr(module, "now_ms", lambda: clock["now"])
    monkeypatch.setattr(module, "time", SimpleNamespace(perf_counter=lambda: clock["mono"]))
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(manual_seed=lambda _: None, inference_mode=nullcontext))
    identity = {"labFingerprint": LAB_PIN, "producerModelFingerprint": PIN, "implementation": {}}
    monkeypatch.setattr(module, "producer_identity", lambda: {"fingerprint": PIN})
    value = bundle()
    monkeypatch.setattr(module, "current_bundle", lambda mode, identity: value)
    return module, identity, clock, value


class Predictor:
    def __init__(self, clock, seconds=5, wall_extra=0, callback=None):
        self.clock, self.seconds, self.wall_extra, self.callback = clock, seconds, wall_extra, callback

    def predict_batch(self, frames, xs, ys, **kwargs):
        assert kwargs == {"pred_len": 12, "T": 1.0, "top_p": .9, "sample_count": 4, "verbose": False}
        assert all(len(y) == 12 for y in ys)
        self.clock["calls"] += 1
        self.clock["now"] += self.seconds * 1000 + self.wall_extra
        self.clock["mono"] += self.seconds
        if self.callback:
            self.callback()
        return [pd.DataFrame([[101, 104, 99, 102, 12, 1212]] * 12) for _ in frames]


def test_runner_archives_exact_input_once_and_never_mutates_producer(runner):
    module, identity, clock, value = runner
    result = module.infer_current(Predictor(clock), identity, "demo")
    assert result["status"] == "predicted"
    stored = module.read(module.BASE / "predictions/demo" / (SID + ".json"))
    assert stored["generationBars"] == 12 and stored["eligible"] is True
    assert stored["usedForOrders"] is False and stored["holdoutValidated"] is False
    assert (module.BASE / "inputs/demo" / (SID + ".snapshot.json")).read_bytes() == value["raw"]["snapshot"]
    assert not module.PRODUCER.exists()
    assert module.infer_current(Predictor(clock), identity, "demo")["status"] == "awaiting_next_cycle"
    assert clock["calls"] == 1


def test_late_inference_is_archived_ineligible_without_retiming(runner):
    module, identity, clock, _ = runner
    result = module.infer_current(Predictor(clock, seconds=45), identity, "demo")
    assert result["status"] == "ineligible_prediction"
    stored = module.read(module.BASE / "predictions/demo" / (SID + ".json"))
    assert stored["issuedAt"] == utc(B + 65000)
    assert stored["ineligibleReasons"] == ["HORIZON_ISSUED_LATE"]
    assert module.collect_scores(identity, {})["modes"]["demo"]["eligiblePredictions"] == 0


def test_clock_jump_is_rejected_before_eligible_prediction_write_and_not_retried(runner):
    module, identity, clock, _ = runner
    with pytest.raises(ValueError, match="CLOCK_JUMP"):
        module.infer_current(Predictor(clock, wall_extra=1000), identity, "demo")
    assert not (module.BASE / "predictions/demo" / (SID + ".json")).exists()
    assert module.infer_current(Predictor(clock), identity, "demo")["status"] == "previous_attempt_incomplete"
    assert clock["calls"] == 1


def test_stops_before_or_during_inference_are_honored(runner):
    module, identity, clock, _ = runner
    stop = module.ROOT / "local/demo/STOP"
    stop.parent.mkdir(parents=True)
    stop.write_text("test", encoding="utf-8")
    assert module.infer_current(Predictor(clock), identity, "demo")["status"] == "stopped"
    stop.unlink()
    result = module.infer_current(Predictor(clock, callback=lambda: stop.write_text("test", encoding="utf-8")), identity, "demo")
    assert result["eligible"] is False
    assert "HORIZON_STOPPED_DURING_INFERENCE" in result["reasons"]


def test_cost_unavailable_is_missingness_not_zero_cost_or_synthetic_output(runner):
    module, identity, clock, value = runner
    value["validated"]["markets"]["BTC/USDT"]["entryCost"] = {"status": "unavailable"}
    result = module.infer_current(Predictor(clock), identity, "demo")
    stored = module.read(module.BASE / "predictions/demo" / (SID + ".json"))
    assert result["eligible"] is False
    assert stored["rows"] == [] and stored["missingPairs"] == ["BTC/USDT"]
    assert stored["errors"][0]["reason"] == "HORIZON_ORIGINAL_COST_MISSING"


def make_scores(runner):
    module, identity, clock, _ = runner
    module.infer_current(Predictor(clock), identity, "demo")
    label = future()
    clock["now"] = B + 12 * MS + 30000
    clock["mono"] += 12 * MS / 1000
    result = module.collect_scores(identity, {"demo": (encoded(label), label)})
    return module, identity, clock, label, result


def test_runner_scores_only_later_closed_snapshot_and_replays_archived_labels(runner):
    module, identity, clock, _ = runner
    module.infer_current(Predictor(clock), identity, "demo")
    assert module.collect_scores(identity, {})["modes"]["demo"]["independentMatchedWindows"] == 0
    label = future()
    clock["now"] = B + 12 * MS + 30000
    result = module.collect_scores(identity, {"demo": (encoded(label), label)})
    assert result["modes"]["demo"]["independentMatchedWindows"] == 1
    assert module.collect_scores(identity, {})["modes"]["demo"]["independentMatchedWindows"] == 1
    assert not module.PRODUCER.exists()


@pytest.mark.parametrize("kind", ["label_bytes", "score_rows", "missing_label", "input_hash", "input_roles"])
def test_tampered_or_missing_archives_cannot_reuse_prior_scores(runner, kind):
    module, identity, _, label, _ = make_scores(runner)
    if kind == "label_bytes":
        path = module.BASE / "label-inputs/demo" / (label["id"] + ".snapshot.json")
        path.write_bytes(path.read_bytes() + b" ")
    elif kind == "missing_label":
        (module.BASE / "label-inputs/demo" / (label["id"] + ".snapshot.json")).unlink()
    elif kind == "score_rows":
        path = module.BASE / "settlements/demo" / (SID + "-h3.json")
        item = module.read(path)
        item["rows"][0]["modelAbsoluteErrorBps"] = "0"
        module.write(path, item)
    elif kind == "input_hash":
        path = module.BASE / "inputs/demo" / (SID + ".input.json")
        path.write_bytes(path.read_bytes() + b" ")
    else:
        path = module.BASE / "predictions/demo" / (SID + ".json")
        item = module.read(path)
        item["sourceHashes"].pop("input")
        module.write(path, item)
    with pytest.raises((ValueError, FileNotFoundError)):
        module.collect_scores(identity, {})


def test_mutated_lab_implementation_refuses_run_until_reviewed_restart(runner, monkeypatch):
    module, identity, _, _ = runner
    identity["implementation"] = {"src/horizon_lab.py": "f" * 64}
    path = module.ROOT / "src/horizon_lab.py"
    path.parent.mkdir(parents=True)
    path.write_text("changed source", encoding="utf-8")
    with pytest.raises(ValueError, match="IMPLEMENTATION_CHANGED"):
        module.run_once(None, identity)


def test_normal_between_cycle_wait_is_distinct_from_genuinely_stale_source(runner, monkeypatch):
    module, identity, clock, value = runner
    waiting = module.source_observation(value["snapshot"], "demo", B + 180000)
    assert waiting["status"] == "awaiting_fresh_cycle"
    assert waiting["lastSourceBoundary"] == B
    assert module.source_observation(value["snapshot"], "demo", B + 601000)["status"] == "stale_source"
    monkeypatch.setattr(module, "current_bundle", lambda mode, identity: {"deferred": waiting})
    assert module.infer_current(Predictor(clock), identity, "demo")["status"] == "awaiting_fresh_cycle"
    assert clock["calls"] == 0
