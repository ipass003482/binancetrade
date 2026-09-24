"""Offline quote research; no exchange, order, credential, or runtime imports.

Spread is paid by crossing ask/bid. Net values are COST SCENARIOS, never fills.
All model fits share a chronological, purged split and the same eligible rows.
"""
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time

VERSION = "prospective-quote-model-comparison-v1"
SOURCES = {"demo": "https://demo-api.binance.com", "demo-futures": "https://demo-fapi.binance.com"}
BASE_FEATURES = ["side", "return1Bps", "return3Bps", "return12Bps", "volatilityBps", "volumeRatio",
                 "spreadBps", "nonSpreadCostBps", "depthImbalance", "depthMissing", "hourSin", "hourCos"]
KRONOS_FEATURES = ["forecastEdgeBps", "forecastSameSide", "predictionAgeSeconds"]


def stamp(value):
    if isinstance(value, bool):
        raise ValueError("invalid timestamp")
    if isinstance(value, (int, float)) and math.isfinite(value):
        return int(value)
    if not isinstance(value, str):
        raise ValueError("timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return int(parsed.timestamp() * 1000)


def utc(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def number(value):
    if value is None or isinstance(value, bool):
        raise ValueError("missing numeric evidence")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite numeric evidence")
    return result


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def read_evidence(path, manifest):
    raw = path.read_bytes()
    manifest[str(path)] = sha(raw)
    return json.loads(raw), sha(raw)


def validate_config(config):
    if config.get("schemaVersion") != 1 or config.get("researchOnly") is not True or config.get("usedForOrders") is not False:
        raise ValueError("research-only configuration required")
    if config.get("horizonMs") != 900000 or config.get("threads") != 1:
        raise ValueError("fixed 15 minute horizon / single thread required")
    if not 0 < config["trainFraction"] < config["trainFraction"] + config["calibrationFraction"] < 1:
        raise ValueError("invalid chronological split")
    for key in ("entryDelayLimitMs", "quoteAgeLimitMs", "exitToleranceMs", "costAgeLimitMs"):
        if type(config.get(key)) is not int or config[key] <= 0:
            raise ValueError("invalid timing configuration")
    return config


def non_spread_cost(market, mode, at, config):
    """Known fee-rate/slippage/funding scenario; never invent missing commission."""
    cost = market.get("entryCost") or {}
    if cost.get("status") != "ok" or cost.get("mode") != mode or cost.get("pair") != market.get("pair") or cost.get("source") != SOURCES[mode]:
        raise ValueError("cost provenance unknown")
    age = at - stamp(cost.get("observedAt"))
    if not 0 <= age <= config["costAgeLimitMs"]:
        raise ValueError("cost stale")
    fee, slip, funding = [number(cost.get(k)) for k in ("roundTripFeeBps", "slippageBpsPerSide", "fundingReserveBps")]
    buy, sell = [number(cost.get(k)) for k in ("buyRate", "sellRate")]
    if min(fee, slip, funding, buy, sell) < 0 or abs(fee - (buy + sell) * 10000) > 1e-5:
        raise ValueError("fee decomposition invalid")
    return {"feeBps": fee, "slippageBps": 2 * slip, "fundingReserveBps": funding,
            "totalBps": fee + 2 * slip + funding,
            "basis": "entry-time known rate and reserve scenario; actual commission/funding unknown"}


def quote_projection(snapshot, market, config):
    mode = snapshot["mode"]
    if market.get("source") != SOURCES.get(mode) or market.get("mode") != mode:
        raise ValueError("quote source invalid")
    fetched, available = stamp(market["fetchedAt"]), stamp(snapshot["completedAt"])
    bid, ask = number(market["bid"]), number(market["ask"])
    if not 0 < bid <= ask or not 0 <= available - fetched <= config["quoteAgeLimitMs"]:
        raise ValueError("quote stale or crossed")
    imbalance, depth_missing = 0., 1.
    books = (market.get("orderFlow") or {}).get("books", [])
    if books:
        book = books[-1]
        if 0 <= available - stamp(book["at"]) <= config["quoteAgeLimitMs"]:
            try:
                b = sum(number(p) * number(q) for p, q in book["bids"])
                a = sum(number(p) * number(q) for p, q in book["asks"])
                if a >= 0 and b >= 0 and a + b > 0:
                    imbalance, depth_missing = (b - a) / (b + a), 0.
            except (ValueError, TypeError, KeyError):
                pass
    try:
        cost = non_spread_cost(market, mode, available, config)
    except (ValueError, TypeError, KeyError):
        cost = None
    return {"snapshotId": snapshot["id"], "pair": market["pair"], "mode": mode,
            "at": available, "fetchedAt": fetched, "bid": bid, "ask": ask,
            "spreadBps": (ask / bid - 1) * 10000, "cost": cost,
            "depthImbalance": imbalance, "depthMissing": depth_missing}


def candle_features(matrix):
    if len(matrix) != 96 or any(len(row) != 6 for row in matrix):
        raise ValueError("invalid prospective input")
    closes = [number(row[3]) for row in matrix]
    volumes = [number(row[4]) for row in matrix]
    if min(closes) <= 0 or min(volumes) < 0:
        raise ValueError("invalid candles")
    returns = [(closes[i] / closes[i - 1] - 1) * 10000 for i in range(1, len(closes))]
    mean = sum(returns[-12:]) / 12
    vol = math.sqrt(sum((r - mean) ** 2 for r in returns[-12:]) / 12)
    base_volume = sum(volumes[-13:-1]) / 12
    return {"return1Bps": returns[-1], "return3Bps": (closes[-1] / closes[-4] - 1) * 10000,
            "return12Bps": (closes[-1] / closes[-13] - 1) * 10000, "volatilityBps": vol,
            "volumeRatio": volumes[-1] / base_volume if base_volume > 0 else 0}


def find_quote(quotes, times, lower, tolerance, after_fetched=None):
    index = bisect_left(times, lower)
    for quote in quotes[index:]:
        if quote["at"] > lower + tolerance:
            break
        if after_fetched is None or quote["fetchedAt"] >= after_fetched:
            return quote
    return None


def quote_label(entry, exit_quote, side):
    if side == 1:
        return (exit_quote["bid"] / entry["ask"] - 1) * 10000
    if side == -1:
        # Fixed unit position PnL divided by entry proceeds, not an inverse return.
        return (entry["bid"] - exit_quote["ask"]) / entry["bid"] * 10000
    raise ValueError("invalid side")


def build_dataset(root, config, start, as_of, progress=None):
    """Read only specific public snapshots/model artifacts; no account files."""
    manifest, excluded = {}, Counter()
    by_id, quotes_by_pair, source_opportunity_keys = {}, defaultdict(list), set()
    for mode in SOURCES:
        files = sorted((root / "local" / mode / "runs").glob("*.snapshot.json"))
        for i, path in enumerate(files):
            try:
                snapshot, source_sha = read_evidence(path, manifest)
                created, completed = stamp(snapshot["createdAt"]), stamp(snapshot["completedAt"])
                if not start <= created <= completed <= as_of or snapshot.get("mode") != mode or snapshot.get("purpose") == "execution_probe":
                    manifest.pop(str(path), None)
                    continue
                if snapshot["id"] in by_id:
                    raise ValueError("duplicate snapshot identity")
                by_id[snapshot["id"]] = {"sha": source_sha, "completedAt": completed, "createdAt": created,
                                           "boundary": snapshot["candleBoundary"], "mode": mode}
                boundary = snapshot["candleBoundary"]
                if (boundary <= created < boundary + 60000
                        and snapshot.get("decisionBoundary", boundary) == boundary):
                    source_opportunity_keys.update((mode, market["pair"], boundary) for market in snapshot.get("markets", []))
                for market in snapshot.get("markets", []):
                    try:
                        quote = quote_projection(snapshot, market, config)
                        quote["sha"] = source_sha
                        quotes_by_pair[(mode, market["pair"])].append(quote)
                    except (ValueError, TypeError, KeyError):
                        excluded["quote_invalid_or_stale"] += 1
            except (ValueError, TypeError, KeyError, OSError):
                excluded["snapshot_invalid"] += 1
            if i % 250 == 0 and progress:
                progress(f"projecting {mode} snapshots {i}/{len(files)}")
            time.sleep(.001)  # Yield between large JSON parses; no parallel scan.
    quote_times = {}
    for key, quotes in quotes_by_pair.items():
        quotes.sort(key=lambda q: (q["at"], q["snapshotId"]))
        quote_times[key] = [q["at"] for q in quotes]
    rows, opportunities, seen_prediction_windows, pinned_forecast_keys = [], [], set(), set()
    for mode in SOURCES:
        prediction_paths = []
        for path in (root / "local/model-research/predictions" / mode).glob("*.json"):
            try:
                header = json.loads(path.read_bytes())
                prediction_paths.append((stamp(header["issuedAt"]), str(path), path))
            except (ValueError, TypeError, KeyError, OSError):
                excluded["prediction_invalid_header"] += 1
        for _, _, path in sorted(prediction_paths):
            try:
                prediction, prediction_sha = read_evidence(path, manifest)
                boundary, issued = prediction["candleBoundary"], stamp(prediction["issuedAt"])
                if not start <= boundary <= issued <= as_of:
                    manifest.pop(str(path), None)
                    continue
                if prediction.get("modelFingerprint") != config["modelFingerprint"]:
                    excluded["other_model_fingerprint"] += 1
                    continue
                if (mode, boundary) in seen_prediction_windows:
                    excluded["duplicate_prediction_window"] += 1
                    continue
                # Select the first issued pinned forecast before reading outcomes.
                # Never choose a restart's forecast using subsequent label quality.
                seen_prediction_windows.add((mode, boundary))
                pinned_forecast_keys.update((mode, forecast["pair"], boundary) for forecast in prediction["forecasts"])
                sid = prediction["snapshotId"]
                source = by_id.get(sid)
                if (not source or source["sha"] != prediction["snapshotSha256"] or source["mode"] != mode
                        or source["boundary"] != boundary or source["completedAt"] > stamp(prediction["startedAt"])
                        or not stamp(prediction["startedAt"]) <= issued or issued >= boundary + 60000):
                    raise ValueError("prediction chronology/provenance")
                input_data, input_sha = read_evidence(root / "local/model-research/inputs" / mode / (sid + ".json"), manifest)
                if (input_sha != prediction["inputSha256"] or input_data.get("snapshotSha256") != source["sha"]
                        or input_data.get("snapshotId") != sid or input_data.get("mode") != mode):
                    raise ValueError("input provenance")
                inputs = {row["pair"]: row for row in input_data["inputs"]}
                settlement, settlement_sha = read_evidence(root / "local/model-research/settlements" / mode / (sid + ".json"), manifest)
                if (settlement.get("predictionSha256") != prediction_sha or settlement.get("modelFingerprint") != config["modelFingerprint"]
                        or stamp(settlement["settledAt"]) > as_of or stamp(settlement["settledAt"]) <= boundary + 900000 - 1):
                    raise ValueError("settlement provenance")
                settled_pairs = {row["pair"] for row in settlement["rows"]}
                for forecast in prediction["forecasts"]:
                    pair = forecast["pair"]
                    opportunity = {"mode": mode, "pair": pair, "window": boundary, "snapshotId": sid, "status": "unknown"}
                    opportunities.append(opportunity)
                    try:
                        if pair not in settled_pairs or pair not in inputs or stamp(inputs[pair]["receivedAt"]) > issued:
                            raise ValueError("input_or_settlement_missing")
                        series = quotes_by_pair[(mode, pair)]
                        times = quote_times.get((mode, pair), [])
                        entry = find_quote(series, times, issued, config["entryDelayLimitMs"], issued)
                        if entry is None:
                            raise ValueError("fresh_post_prediction_quote_missing")
                        if entry["cost"] is None:
                            raise ValueError("known_fee_scenario_missing")
                        target = entry["at"] + config["horizonMs"]
                        exit_quote = find_quote(series, times, target, config["exitToleranceMs"], target)
                        if exit_quote is None or exit_quote["at"] > as_of:
                            raise ValueError("on_time_exit_quote_missing")
                        features = candle_features(inputs[pair]["ohlcva"])
                        closes = [number(v) for v in forecast["forecastCloses"]]
                        origin = number(forecast["originClose"])
                        if len(closes) != 3 or min(closes) <= 0:
                            raise ValueError("forecast_invalid")
                        for side in ((1,) if mode == "demo" else (1, -1)):
                            edge = (closes[-1] / entry["ask"] - 1) * 10000 if side == 1 else (entry["bid"] - closes[-1]) / entry["bid"] * 10000
                            raw = quote_label(entry, exit_quote, side)
                            fee_scenario = entry["cost"]["totalBps"]
                            hour = (entry["at"] % 86400000) / 86400000 * math.tau
                            model_features = {**features, "side": side, "spreadBps": entry["spreadBps"],
                                              "nonSpreadCostBps": fee_scenario, "depthImbalance": entry["depthImbalance"],
                                              "depthMissing": entry["depthMissing"], "hourSin": math.sin(hour), "hourCos": math.cos(hour),
                                              "forecastEdgeBps": edge, "forecastSameSide": float(all(side * (v - origin) > 0 for v in closes)),
                                              "predictionAgeSeconds": (entry["at"] - issued) / 1000}
                            # A linear baseline needs explicit directional returns;
                            # it cannot infer side-by-return interactions unaided.
                            for key in ("return1Bps", "return3Bps", "return12Bps", "depthImbalance"):
                                model_features[key] *= side
                            rows.append({**opportunity, "status": "eligible", "side": side, "features": model_features,
                                         "issuedAt": issued, "entryAt": entry["at"], "exitAt": exit_quote["at"], "targetAt": target,
                                         "actualElapsedMs": exit_quote["at"] - entry["at"], "rawQuoteReturnBps": raw,
                                         "netScenarioBps": raw - fee_scenario, "cost": entry["cost"],
                                         "entrySnapshotId": entry["snapshotId"], "exitSnapshotId": exit_quote["snapshotId"],
                                         "predictionSha256": prediction_sha, "inputSha256": input_sha,
                                         "settlementSha256": settlement_sha, "entrySha256": entry["sha"], "exitSha256": exit_quote["sha"]})
                        opportunity["status"] = "eligible"
                    except (ValueError, TypeError, KeyError) as error:
                        reason = str(error) if isinstance(error, ValueError) else "pair_evidence_invalid"
                        opportunity["reason"] = reason
                        excluded[reason] += 1
                excluded["model_missing_pair_outputs"] += max(0, prediction["expectedPairs"] - len(prediction["forecasts"]))
            except (ValueError, TypeError, KeyError, OSError):
                excluded["prediction_evidence_missing_or_invalid"] += 1
    rows.sort(key=lambda r: (r["window"], r["mode"], r["pair"], r["side"]))
    matching_keys = {(o["mode"], o["pair"], o["window"]) for o in opportunities}
    eligible_keys = {(r["mode"], r["pair"], r["window"]) for r in rows}
    coverage = {}
    for mode in SOURCES:
        expected = {key for key in source_opportunity_keys if key[0] == mode}
        forecasted = expected & pinned_forecast_keys
        matching = expected & matching_keys
        eligible = expected & eligible_keys
        coverage[mode] = {"sourceCandleWindows": len({k[2] for k in expected}), "sourcePairWindows": len(expected),
                          "pinnedForecastPairWindows": len(forecasted), "missingPinnedForecastPairWindows": len(expected - forecasted),
                          "forecastWithUnavailableMatchingEvidence": len(forecasted - matching),
                          "pairWindowsReachingQuoteMatching": len(matching), "eligiblePairWindows": len(eligible),
                          "eligibleFractionOfSourcePairWindows": len(eligible) / len(expected) if expected else None}
    return {"schemaVersion": 1, "version": VERSION, "researchOnly": True, "usedForOrders": False,
            "start": utc(start), "asOf": utc(as_of), "config": config, "configFingerprint": sha(canonical(config)),
            "rows": rows, "opportunities": opportunities,
            "excluded": dict(excluded), "sourceManifest": manifest,
            "conditionalMatchedForecastStudy": True, "sourceOpportunityCoverage": coverage,
            "sourceFingerprint": sha(canonical(manifest)), "rowsFingerprint": sha(canonical(rows)),
            "interpretation": "15m from first fresh post-prediction quote; modeled costs, not fills or portfolio PnL",
            "limitations": ["Kronos original 15m candle target precedes our entry+15m target by acquisition delay",
                            "without_kronos arms are conditional on a valid Kronos forecast and matching evidence; not full operational replacement tests",
                            "REST receipt time proves observation time, not exchange event freshness",
                            "actual fill, queue, market impact, actual commission and funding are unknown"]}


def purged_split(rows, config):
    windows = sorted({r["window"] for r in rows})
    if len(windows) < 3:
        return {"train": [], "calibration": [], "test": []}, {"reason": "too_few_windows"}
    i = max(1, min(len(windows) - 2, int(len(windows) * config["trainFraction"])))
    j = max(i + 1, min(len(windows) - 1, int(len(windows) * (config["trainFraction"] + config["calibrationFraction"]))))
    calibration_start, test_start = windows[i], windows[j]
    split = {"train": [], "calibration": [], "test": []}
    purged = Counter()
    for row in rows:
        name = "train" if row["window"] < calibration_start else "calibration" if row["window"] < test_start else "test"
        upper = calibration_start if name == "train" else test_start if name == "calibration" else math.inf
        if row["exitAt"] >= upper:
            purged[name] += 1
        else:
            split[name].append(row)
    return split, {"calibrationStart": utc(calibration_start), "testStart": utc(test_start),
                   "purgedDirectionalRows": dict(purged), "method": "shared clock-window split; label exit strictly before next partition start"}


def logistic_fit(x, y, penalty=1.):
    import numpy as np
    from scipy.optimize import minimize
    z = np.column_stack([np.ones(len(x)), x])
    def objective(w):
        a = z @ w
        probability = 1 / (1 + np.exp(-np.clip(a, -35, 35)))
        loss = np.logaddexp(0, a).sum() - y @ a + penalty * (w[1:] @ w[1:]) / 2
        grad = z.T @ (probability - y)
        grad[1:] += penalty * w[1:]
        return loss, grad
    fit = minimize(objective, np.zeros(z.shape[1]), jac=True, method="L-BFGS-B", options={"maxiter": 150})
    if not fit.success or not np.isfinite(fit.x).all():
        raise ValueError("logistic fit failed")
    return fit.x


def logistic_predict(x, weights):
    import numpy as np
    a = np.column_stack([np.ones(len(x)), x]) @ weights
    return 1 / (1 + np.exp(-np.clip(a, -35, 35)))


def block_interval(values, config):
    """Time-block descriptive bootstrap; no independence/promotion claim."""
    import numpy as np
    blocks = defaultdict(list)
    for at, value in values:
        blocks[at // config["bootstrapBlockMs"]].append(value)
    if len(blocks) < 10:
        return {"status": "insufficient_time_blocks", "blocks": len(blocks), "interval95Bps": None}
    totals = np.array([(sum(v), len(v)) for v in blocks.values()], dtype=float)
    rng = np.random.default_rng(config["seed"])
    indices = rng.integers(0, len(totals), size=(config["bootstrapReplicates"], len(totals)))
    samples = totals[indices].sum(axis=1)
    estimates = samples[:, 0] / samples[:, 1]
    return {"status": "descriptive_only", "blocks": len(blocks), "interval95Bps": np.quantile(estimates, [.025, .975]).tolist()}


def evaluate_signals(test, scores, probabilities, config):
    import numpy as np
    grouped = defaultdict(list)
    for index, row in enumerate(test):
        grouped[(row["window"], row["pair"])].append(index)
    selected, next_free, window_values = [], {}, defaultdict(list)
    for _, indices in sorted(grouped.items()):
        best = max(indices, key=lambda i: scores[i])
        row = test[best]
        value = 0.
        if scores[best] > 0 and row["entryAt"] >= next_free.get(row["pair"], 0):
            selected.append(row)
            next_free[row["pair"]] = row["exitAt"]
            value = row["netScenarioBps"]
        window_values[row["window"]].append(value)
    opportunity_values = [value for values in window_values.values() for value in values]
    net = [r["netScenarioBps"] for r in selected]
    positives, negatives = sum(max(0, v) for v in net), -sum(min(0, v) for v in net)
    result = {"eligiblePairWindows": len(grouped), "selectedNonoverlappingSignals": len(selected),
              "meanSelectedNetScenarioBps": float(np.mean(net)) if net else None,
              "meanNetScenarioBpsPerOpportunity": float(np.mean(opportunity_values)) if opportunity_values else None,
              "signalProfitFactor": positives / negatives if negatives > 0 else None,
              "positiveSignalFraction": sum(v > 0 for v in net) / len(net) if net else None,
              "meanSelectedStressBps": float(np.mean(net)) - 2 * config["stressAdditionalBpsPerSide"] if net else None,
              "meanOpportunityInterval": block_interval([(at, v) for at, values in window_values.items() for v in values], config),
              "actualTradePnl": None, "portfolioPnl": None,
              "interpretation": "equal-weight quote signal diagnostics; one position per pair, no portfolio capital simulation"}
    if probabilities is not None:
        y = np.array([r["netScenarioBps"] > 0 for r in test], dtype=float)
        p = np.clip(probabilities, 1e-8, 1 - 1e-8)
        result.update(brier=float(np.mean((p - y) ** 2)), logLoss=float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))))
    return result


def compare(dataset):
    import importlib.metadata
    import numpy as np
    config = validate_config(dataset["config"])
    if sha(canonical(dataset["rows"])) != dataset["rowsFingerprint"]:
        raise ValueError("frozen dataset hash mismatch")
    if (sha(canonical(config)) != dataset.get("configFingerprint")
            or sha(canonical(dataset["sourceManifest"])) != dataset["sourceFingerprint"]):
        raise ValueError("frozen dataset provenance mismatch")
    split, split_info = purged_split(dataset["rows"], config)
    report = {"version": VERSION, "researchOnly": True, "usedForOrders": False, "promotionAuthorized": False,
              "status": "inconclusive", "reason": "exploratory historical quote study; no untouched prospective champion trial",
              "dataAsOf": dataset["asOf"], "rowsFingerprint": dataset["rowsFingerprint"], "sourceFingerprint": dataset["sourceFingerprint"],
              "configFingerprint": sha(canonical(config)), "split": split_info, "excluded": dataset["excluded"], "modes": {},
              "conditionalMatchedForecastStudy": True, "sourceOpportunityCoverage": dataset.get("sourceOpportunityCoverage", {}),
              "dependencies": dependency_versions(),
              "chronos2": {"status": "not_evaluated", "reason": "adapter/weights absent; no replacement ranking can be claimed"},
              "limitations": dataset["limitations"]}
    for mode in SOURCES:
        partitions = {name: [r for r in rows if r["mode"] == mode] for name, rows in split.items()}
        counts = {name: {"rows": len(rows), "windows": len({r["window"] for r in rows})} for name, rows in partitions.items()}
        result = {"splitCounts": counts, "candidates": {}, "status": "inconclusive", "promotionAuthorized": False}
        report["modes"][mode] = result
        if not partitions["test"]:
            result["reason"] = "no eligible on-time fee-known quote test rows"
            continue
        test = partitions["test"]
        result["candidates"]["hold"] = evaluate_signals(test, np.zeros(len(test)), None, config)
        kronos_score = np.array([r["features"]["forecastEdgeBps"] - r["cost"]["totalBps"] - config["kronosBufferBps"]
                                 if r["features"]["forecastSameSide"] else -1 for r in test])
        result["candidates"]["kronos_frozen"] = evaluate_signals(test, kronos_score, None, config)
        sufficient = all(counts[name]["windows"] >= config[key] for name, key in (("train", "minimumTrainWindows"), ("calibration", "minimumCalibrationWindows"), ("test", "minimumTestWindows")))
        if not sufficient:
            result["reason"] = "insufficient grouped windows for fit/calibration/test"
            continue
        train, calibration = partitions["train"], partitions["calibration"]
        y_train = np.array([r["netScenarioBps"] > 0 for r in train], dtype=float)
        y_cal = np.array([r["netScenarioBps"] > 0 for r in calibration], dtype=float)
        if len(set(y_train)) < 2 or len(set(y_cal)) < 2:
            result["reason"] = "training/calibration needs both cost-adjusted classes"
            continue
        net_train = np.array([r["netScenarioBps"] for r in train])
        mean_gain, mean_loss = net_train[y_train == 1].mean(), net_train[y_train == 0].mean()
        for kind in ("logistic", "lightgbm"):
            for include_kronos in (False, True):
                name = kind + ("_with_kronos" if include_kronos else "_without_kronos")
                features = BASE_FEATURES + (KRONOS_FEATURES if include_kronos else [])
                matrices = {part: np.array([[r["features"][f] for f in features] for r in rows], dtype=float) for part, rows in partitions.items()}
                started = time.perf_counter()
                try:
                    if kind == "logistic":
                        center, scale = matrices["train"].mean(axis=0), matrices["train"].std(axis=0)
                        scale[scale < 1e-8] = 1
                        matrices = {part: np.clip((x - center) / scale, -20, 20) for part, x in matrices.items()}
                        weights = logistic_fit(matrices["train"], y_train)
                        p_cal, p_test = [logistic_predict(matrices[part], weights) for part in ("calibration", "test")]
                        model_digest = sha(canonical({"weights": weights.tolist(), "center": center.tolist(), "scale": scale.tolist()}))
                    else:
                        import lightgbm as lgb
                        model = lgb.train({"objective": "binary", "verbosity": -1, "num_threads": 1,
                                           "seed": config["seed"], "deterministic": True, "force_col_wise": True,
                                           "learning_rate": .04, "num_leaves": 7, "max_depth": 3,
                                           "min_data_in_leaf": 40, "lambda_l2": 5., "feature_pre_filter": False},
                                          lgb.Dataset(matrices["train"], label=y_train, feature_name=features),
                                          num_boost_round=config["lightgbmRounds"])
                        p_cal, p_test = [model.predict(matrices[part], num_threads=1) for part in ("calibration", "test")]
                        model_digest = sha(model.model_to_string().encode())
                    logit_cal = np.log(np.clip(p_cal, 1e-6, 1 - 1e-6) / np.clip(1 - p_cal, 1e-6, 1))[:, None]
                    calibrator = logistic_fit(logit_cal, y_cal, penalty=1.)
                    logit_test = np.log(np.clip(p_test, 1e-6, 1 - 1e-6) / np.clip(1 - p_test, 1e-6, 1))[:, None]
                    probability = logistic_predict(logit_test, calibrator)
                    expected_scenario = probability * mean_gain + (1 - probability) * mean_loss
                    scores = np.where(probability >= config["probabilityThreshold"], expected_scenario, -1.)
                    metrics = evaluate_signals(test, scores, probability, config)
                    result["candidates"][name] = {**metrics, "fitAndEvaluationSeconds": time.perf_counter() - started,
                                                 "features": features, "modelSha256": model_digest,
                                                 "calibrationWeights": calibrator.tolist(), "status": "evaluated"}
                except ImportError:
                    result["candidates"][name] = {"status": "dependency_unavailable"}
                except ValueError as error:
                    result["candidates"][name] = {"status": "fit_unavailable", "reason": str(error)}
        result["calendarSpanDays"] = (max(r["exitAt"] for r in dataset["rows"] if r["mode"] == mode) - min(r["entryAt"] for r in dataset["rows"] if r["mode"] == mode)) / 86400000
        result["reason"] = "quote scenarios and limited calendar coverage cannot establish actual fee-adjusted trading alpha"
    return report


def dependency_versions():
    import importlib.metadata
    result = {}
    for distribution in ("numpy", "scipy", "lightgbm", "chronos-forecasting"):
        try:
            result[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            result[distribution] = None
    return result
