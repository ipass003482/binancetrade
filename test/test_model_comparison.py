"""Offline research tests: chronology, fee accounting and honest evidence gaps."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from model_comparison import (BASE_FEATURES, KRONOS_FEATURES, build_dataset, canonical, compare, find_quote,
                             non_spread_cost, purged_split, quote_label, quote_projection, sha, stamp, utc)


def config():
    return json.loads((ROOT / "config/model-comparison.json").read_text())


def market(at, mode="demo"):
    pair = "BTC/USDT" if mode == "demo" else "BTC/USDT:USDT"
    source = "https://demo-api.binance.com" if mode == "demo" else "https://demo-fapi.binance.com"
    return {"mode": mode, "pair": pair, "source": source, "fetchedAt": utc(at - 1000), "bid": "99", "ask": "101",
            "orderFlow": None,
            "entryCost": {"status": "ok", "mode": mode, "pair": pair, "source": source,
                          "observedAt": utc(at - 2000), "buyRate": ".001", "sellRate": ".001", "roundTripFeeBps": "20",
                          "spreadBps": "200", "slippageBpsPerSide": 5, "fundingReserveBps": "0"}}


class ComparisonTests(unittest.TestCase):
    def test_spread_is_paid_exactly_once_in_crossed_quotes(self):
        entry = {"ask": 101., "bid": 99.}
        exit_quote = entry.copy()
        self.assertAlmostEqual(quote_label(entry, exit_quote, 1), -2 / 101 * 10000)
        self.assertAlmostEqual(quote_label(entry, exit_quote, -1), -2 / 99 * 10000)
        cost = non_spread_cost(market(100000), "demo", 100000, config())
        self.assertEqual(cost["totalBps"], 30)  # 200 bps spread not charged again.
        self.assertAlmostEqual(quote_label(entry, exit_quote, 1) - cost["totalBps"], -2 / 101 * 10000 - 30)

    def test_missing_fee_is_unknown_not_zero(self):
        m = market(100000)
        del m["entryCost"]["roundTripFeeBps"]
        with self.assertRaises(ValueError):
            non_spread_cost(m, "demo", 100000, config())
        snapshot = {"id": "s", "mode": "demo", "completedAt": utc(100000)}
        self.assertIsNone(quote_projection(snapshot, m, config())["cost"])

    def test_future_and_stale_fee_evidence_rejected(self):
        m = market(1000000)
        for observed in (1000001, 1):
            m["entryCost"]["observedAt"] = utc(observed)
            with self.assertRaises(ValueError):
                non_spread_cost(m, "demo", 1000000, config())

    def test_late_quote_and_pre_prediction_quote_are_not_usable(self):
        quotes = [{"at": 100, "fetchedAt": 80}, {"at": 150, "fetchedAt": 145}]
        self.assertIsNone(find_quote(quotes, [100, 150], 90, 20, 90))
        self.assertEqual(find_quote(quotes, [100, 150], 90, 70, 90)["at"], 150)
        self.assertIsNone(find_quote(quotes, [100, 150], 110, 30, 110))

    def test_quote_age_and_source_are_checked(self):
        snapshot = {"id": "s", "mode": "demo", "completedAt": utc(100000)}
        m = market(100000)
        m["fetchedAt"] = utc(80000)
        with self.assertRaises(ValueError):
            quote_projection(snapshot, m, config())
        m = market(100000)
        m["source"] = "https://api.binance.com"
        with self.assertRaises(ValueError):
            quote_projection(snapshot, m, config())

    def test_cross_assets_and_modes_split_together_with_overlap_purge(self):
        rows = [{"window": w * 300000, "exitAt": w * 300000 + 910000, "mode": mode, "pair": pair}
                for w in range(20) for mode in ("demo", "demo-futures") for pair in ("BTC", "ETH")]
        split, info = purged_split(rows, config())
        cal, test = stamp(info["calibrationStart"]), stamp(info["testStart"])
        self.assertTrue(all(r["exitAt"] < cal for r in split["train"]))
        self.assertTrue(all(r["exitAt"] < test for r in split["calibration"]))
        sets = {name: {r["window"] for r in group} for name, group in split.items()}
        self.assertFalse(sets["train"] & sets["calibration"] or sets["calibration"] & sets["test"])
        for group in split.values():
            for window in {r["window"] for r in group}:
                self.assertEqual(len([r for r in group if r["window"] == window]), 4)

    def create_evidence(self, root, late=False, missing_fee=False):
        base = 1789516800000
        paths = {}
        def write(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            raw = canonical(value)
            path.write_bytes(raw)
            return sha(raw)
        for minute in (0, 1, 16):
            at = base + minute * 60000 + 10000 + (1000 if minute == 16 else 0) + (40000 if late and minute == 16 else 0)
            m = market(at)
            if missing_fee and minute == 1:
                m["entryCost"] = None
            snapshot = {"id": f"snapshot-{minute}", "mode": "demo", "createdAt": utc(at - 2000),
                        "completedAt": utc(at), "candleBoundary": base + (minute // 5) * 300000, "markets": [m]}
            paths[minute] = write(root / "local/demo/runs" / (snapshot["id"] + ".snapshot.json"), snapshot)
        input_data = {"snapshotId": "snapshot-0", "mode": "demo", "snapshotSha256": paths[0],
                      "inputs": [{"pair": "BTC/USDT", "receivedAt": base + 18000,
                                  "ohlcva": [[100, 101, 99, 100, 10, 1000] for _ in range(96)]}]}
        input_sha = write(root / "local/model-research/inputs/demo/snapshot-0.json", input_data)
        prediction = {"snapshotId": "snapshot-0", "mode": "demo", "candleBoundary": base, "issuedAt": utc(base + 20000),
                      "startedAt": utc(base + 12000), "modelFingerprint": config()["modelFingerprint"],
                      "snapshotSha256": paths[0], "inputSha256": input_sha, "expectedPairs": 1,
                      "forecasts": [{"pair": "BTC/USDT", "originClose": "100", "forecastCloses": ["102", "103", "104"]}]}
        pred_sha = write(root / "local/model-research/predictions/demo/snapshot-0.json", prediction)
        settlement = {"predictionSha256": pred_sha, "modelFingerprint": config()["modelFingerprint"],
                      "settledAt": utc(base + 930000), "rows": [{"pair": "BTC/USDT"}]}
        write(root / "local/model-research/settlements/demo/snapshot-0.json", settlement)
        return base

    def test_extracts_only_after_prediction_and_on_time_fixed_horizon(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root)
            dataset = build_dataset(root, config(), base, base + 2000000)
            self.assertEqual(len(dataset["rows"]), 1)
            row = dataset["rows"][0]
            self.assertGreater(row["entryAt"], row["issuedAt"])
            self.assertEqual(row["actualElapsedMs"], 901000)
            self.assertEqual(row["cost"]["totalBps"], 30)
            self.assertEqual(dataset["rowsFingerprint"], sha(canonical(dataset["rows"])))
            coverage = dataset["sourceOpportunityCoverage"]["demo"]
            self.assertEqual(coverage["sourcePairWindows"], 1)
            self.assertEqual(coverage["eligiblePairWindows"], 1)

    def test_late_label_is_counted_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root, late=True)
            dataset = build_dataset(root, config(), base, base + 2000000)
            self.assertFalse(dataset["rows"])
            self.assertEqual(dataset["excluded"]["on_time_exit_quote_missing"], 1)

    def test_unknown_fee_removes_row_for_every_model(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root, missing_fee=True)
            dataset = build_dataset(root, config(), base, base + 2000000)
            self.assertFalse(dataset["rows"])
            self.assertEqual(dataset["excluded"]["known_fee_scenario_missing"], 1)

    def test_tampered_input_not_used(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root)
            path = root / "local/model-research/inputs/demo/snapshot-0.json"
            path.write_bytes(path.read_bytes() + b" ")
            dataset = build_dataset(root, config(), base, base + 2000000)
            self.assertFalse(dataset["rows"])
            self.assertEqual(dataset["excluded"]["prediction_evidence_missing_or_invalid"], 1)

    def test_missing_whole_prediction_stays_in_source_denominator(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root)
            (root / "local/model-research/predictions/demo/snapshot-0.json").unlink()
            dataset = build_dataset(root, config(), base, base + 2000000)
            coverage = dataset["sourceOpportunityCoverage"]["demo"]
            self.assertEqual(coverage["sourcePairWindows"], 1)
            self.assertEqual(coverage["missingPinnedForecastPairWindows"], 1)
            self.assertEqual(coverage["eligiblePairWindows"], 0)

    def test_missing_whole_settlement_has_pair_coverage_gap(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root)
            (root / "local/model-research/settlements/demo/snapshot-0.json").unlink()
            dataset = build_dataset(root, config(), base, base + 2000000)
            coverage = dataset["sourceOpportunityCoverage"]["demo"]
            self.assertEqual(coverage["pinnedForecastPairWindows"], 1)
            self.assertEqual(coverage["forecastWithUnavailableMatchingEvidence"], 1)
            self.assertEqual(coverage["eligiblePairWindows"], 0)

    def test_dataset_tamper_rejected_before_fit(self):
        dataset = {"config": config(), "rows": [{"window": 1}], "rowsFingerprint": "bad"}
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            compare(dataset)

    def test_duplicate_forecast_window_is_not_an_extra_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = self.create_evidence(root)
            source = root / "local/model-research/predictions/demo/snapshot-0.json"
            duplicate = json.loads(source.read_bytes())
            duplicate["issuedAt"] = utc(base + 21000)
            (source.parent / "restart.json").write_bytes(canonical(duplicate))
            dataset = build_dataset(root, config(), base, base + 2000000)
            self.assertEqual(len(dataset["rows"]), 1)
            self.assertEqual(dataset["excluded"]["duplicate_prediction_window"], 1)

    def assert_test_labels_do_not_change_fit(self, candidate_names):
        cfg = config()
        cfg["bootstrapReplicates"] = 20
        rows = []
        for i in range(120):
            features = {key: 0. for key in BASE_FEATURES + KRONOS_FEATURES}
            features.update(side=1, return1Bps=float(i % 3), volatilityBps=10., spreadBps=1.,
                            nonSpreadCostBps=30., forecastEdgeBps=float(i % 5), forecastSameSide=1.)
            for pair in ("BTC", "ETH"):
                rows.append({"mode": "demo", "pair": pair, "window": i * 300000, "entryAt": i * 300000 + 20000,
                             "exitAt": i * 300000 + 920000, "netScenarioBps": 10. if i % 3 == 0 else -10.,
                             "side": 1, "cost": {"totalBps": 30.}, "features": features.copy()})
        dataset = {"config": cfg, "configFingerprint": sha(canonical(cfg)), "rows": rows, "rowsFingerprint": sha(canonical(rows)),
                   "sourceManifest": {}, "sourceFingerprint": sha(canonical({})),
                   "asOf": "2026-09-20T15:37:00Z", "excluded": {}, "limitations": ["synthetic test"]}
        report1 = compare(dataset)
        changed = copy.deepcopy(dataset)
        for row in changed["rows"]:
            if row["window"] >= 96 * 300000:
                row["netScenarioBps"] *= -10
        changed["rowsFingerprint"] = sha(canonical(changed["rows"]))
        report2 = compare(changed)
        for name in candidate_names:
            first = report1["modes"]["demo"]["candidates"][name]
            second = report2["modes"]["demo"]["candidates"][name]
            self.assertEqual(first["status"], "evaluated")
            self.assertEqual(first["modelSha256"], second["modelSha256"])
            self.assertEqual(first["calibrationWeights"], second["calibrationWeights"])
        self.assertFalse(report1["promotionAuthorized"])

    def test_test_labels_do_not_change_logistic_models_or_calibration(self):
        self.assert_test_labels_do_not_change_fit(("logistic_without_kronos", "logistic_with_kronos"))

    @unittest.skipUnless(importlib.util.find_spec("lightgbm") is not None,
                         "LightGBM is optional here; run this check in .venv-model")
    def test_test_labels_do_not_change_lightgbm_models_or_calibration(self):
        # Presence alone controls skipping: an installed but broken LightGBM
        # must still fail the evaluated-status assertion rather than be hidden.
        self.assert_test_labels_do_not_change_fit(("lightgbm_without_kronos", "lightgbm_with_kronos"))


if __name__ == "__main__":
    unittest.main()
