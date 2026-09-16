"""Independent prospective 3/6/12-prefix experiment. No orders or PnL synthesis."""
from copy import deepcopy
import math
import re

from pretrained_model import (MS, MODES, SOURCES, clock_range, digest, millis,
                              number, utc, validate_snapshot)

SCHEMA = "horizon-prefix-lab-v1"
HORIZONS = (3, 6, 12)
CONFIG = {"schemaVersion": 1, "experiment": SCHEMA, "timeframe": "5m", "historyBars": 96,
          "horizons": list(HORIZONS), "generationBars": 12, "sampleCount": 4,
          "temperature": 1.0, "topP": 0.9, "seed": 2914, "threads": 1, "device": "cpu",
          "maxIssueSeconds": 60, "matchedWindowBars": 12, "minimumMatchedWindows": 30,
          "reviewWindows": 100, "costMaxAgeSeconds": 300, "executionRole": "research_only", "usedForOrders": False,
          "costPolicy": "unchanged_original_snapshot_cost_and_bid_ask"}
HEX = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def reject(code):
    raise ValueError("HORIZON_" + code)


def config():
    return deepcopy(CONFIG)


def require_hash(value):
    if not isinstance(value, str) or HEX.fullmatch(value) is None:
        reject("HASH_INVALID")
    return value


def validate_bundle(snapshot, producer, inputs, *, mode, pin, snapshot_sha, producer_sha, input_sha, now):
    """Reconcile archived producer bytes with this exact current, closed snapshot."""
    for value in (pin, snapshot_sha, producer_sha, input_sha):
        require_hash(value)
    boundary = validate_snapshot(snapshot, mode, now)
    sid = snapshot["id"]
    if (not isinstance(producer, dict) or producer.get("schemaVersion") != 1
            or producer.get("source") != "frozen-pretrained-kronos"
            or producer.get("model") != "kronos-small-pretrained-v1"
            or producer.get("modelFingerprint") != pin or producer.get("snapshotId") != sid
            or producer.get("mode") != mode or producer.get("snapshotSha256") != snapshot_sha
            or producer.get("inputSha256") != input_sha or producer.get("candleBoundary") != boundary
            or producer.get("pretrained") is not True or producer.get("fineTuned") is not False
            or producer.get("sampleCount") != 4 or producer.get("usedForOrders") is not False):
        reject("PRODUCER_IDENTITY")
    created, completed = millis(snapshot["createdAt"]), millis(snapshot["completedAt"])
    began, issued = millis(producer["startedAt"]), millis(producer["issuedAt"])
    if not created <= completed <= began <= issued <= now:
        reject("PRODUCER_CHRONOLOGY")
    lower, upper = clock_range(snapshot["clock"], mode, issued)
    if (producer.get("issuedExchangeLowerAt") != lower or producer.get("issuedExchangeUpperAt") != upper
            or not boundary <= lower <= upper < boundary + 60_000):
        reject("PRODUCER_CLOCK")
    if (not isinstance(inputs, dict) or inputs.get("snapshotId") != sid or inputs.get("mode") != mode
            or inputs.get("snapshotSha256") != snapshot_sha or inputs.get("candleBoundary") != boundary
            or inputs.get("clock") != snapshot["clock"] or not isinstance(inputs.get("inputs"), list)):
        reject("INPUT_IDENTITY")
    markets = {m["pair"]: m for m in snapshot["markets"]}
    forecasts, errors = producer.get("forecasts"), producer.get("errors")
    if not isinstance(forecasts, list) or not forecasts or not isinstance(errors, list) or producer.get("expectedPairs") != len(markets):
        reject("PRODUCER_PARTITION")
    used, covered = set(), set()
    for row in forecasts:
        pair = row.get("pair")
        if pair not in markets or pair in covered:
            reject("PRODUCER_PARTITION")
        if (row.get("issuedAt") != producer["issuedAt"] or row.get("targetCloseAt") != boundary + 3 * MS - 1
                or row.get("forecastBarOpens") != [boundary + i * MS for i in range(3)]
                or not isinstance(row.get("forecastCloses"), list) or len(row["forecastCloses"]) != 3
                or any(number(x) <= 0 for x in row["forecastCloses"])
                or number(row.get("originClose")) != number(markets[pair]["candles"][-1]["close"])):
            reject("PRODUCER_FORECAST")
        used.add(pair)
        covered.add(pair)
    for row in errors:
        pair = row.get("pair")
        if pair not in markets or pair in covered or re.fullmatch(r"MODEL_[A-Z_]+", str(row.get("reason"))) is None:
            reject("PRODUCER_PARTITION")
        covered.add(pair)
    if covered != set(markets):
        reject("PRODUCER_PARTITION")
    validated, seen = [], set()
    for row in inputs["inputs"]:
        pair = row.get("pair")
        if pair not in markets or pair in seen:
            reject("INPUT_PAIR")
        seen.add(pair)
        source = SOURCES[mode] + ("/api/v3/klines" if mode == "demo" else "/fapi/v1/klines")
        if (row.get("source") != source or not began <= millis(row.get("requestStartedAt")) <= millis(row.get("receivedAt")) <= issued):
            reject("INPUT_SOURCE")
        require_hash(row.get("rawResponseSha256"))
        matrix = row.get("ohlcva")
        if not isinstance(matrix, list) or len(matrix) != 96:
            reject("INPUT_VALUES")
        for values, candle in zip(matrix, markets[pair]["candles"]):
            if (not isinstance(values, list) or len(values) != 6
                    or any(type(x) not in (int, float) or not math.isfinite(x) for x in values)
                    or values[5] < 0 or any(values[i] != float(number(candle[k])) for i, k in enumerate(("open", "high", "low", "close", "volume")))):
                reject("INPUT_VALUES")
        # Do not resurrect a pair the current producer rejected on output.
        if pair in used:
            validated.append(row)
    if not used <= seen:
        reject("INPUT_PAIR_MISSING")
    return {"boundary": boundary, "snapshotId": sid, "markets": markets,
            "inputs": sorted(validated, key=lambda row: row["pair"]), "expectedPairs": sorted(markets),
            "missingPairs": sorted(set(markets) - used), "producerPredictionSha256": producer_sha}


def original_cost(market, mode, now):
    value = market.get("entryCost", {})
    if (value.get("status") != "ok" or value.get("mode") != mode or value.get("pair") != market["pair"]
            or value.get("source") != SOURCES[mode]):
        reject("ORIGINAL_COST_MISSING")
    total, required = number(value.get("estimatedRoundTripCostBps")), number(value.get("requiredPriceSpaceBps"))
    if total < 0 or required < total or not 0 <= now - millis(value.get("observedAt")) <= 300_000:
        reject("ORIGINAL_COST_INVALID")
    bid, ask = number(market.get("bid")), number(market.get("ask"))
    if bid <= 0 or ask < bid:
        reject("ORIGINAL_QUOTE_INVALID")
    fetched = millis(market.get("fetchedAt"))
    if not 0 <= now - fetched <= 60_000:
        reject("ORIGINAL_QUOTE_STALE")
    return deepcopy(value), bid, ask


def forecast_prefixes(market, prediction, mode, boundary, issued):
    if (not isinstance(prediction, list) or len(prediction) != 12
            or any(not isinstance(row, list) or len(row) != 6 for row in prediction)):
        reject("OUTPUT_SHAPE")
    values = [[number(value) for value in row] for row in prediction]
    closes = [row[3] for row in values]
    if any(close <= 0 for close in closes):
        reject("OUTPUT_PRICE")
    cost, bid, ask = original_cost(market, mode, issued)
    quote_low, quote_high = clock_range(market.get("clock", {}), mode, millis(market["fetchedAt"]))
    if not boundary <= quote_low <= quote_high < boundary + 60_000:
        reject("ORIGINAL_QUOTE_CYCLE")
    origin = number(market["candles"][-1]["close"])
    reserve, required = number(cost["estimatedRoundTripCostBps"]), number(cost["requiredPriceSpaceBps"])
    assessments = []
    for horizon in HORIZONS:
        target = closes[horizon - 1]
        gross = (target / origin - 1) * 10_000
        direction = "long" if target > origin else "short" if target < origin and mode == "demo-futures" else "hold"
        price = ask if direction == "long" else bid if direction == "short" else None
        edge = (target / price - 1) * (10_000 if direction == "long" else -10_000) if price else None
        sign = 1 if direction == "long" else -1
        assessments.append({"horizonBars": horizon, "generationBars": 12, "summary": "terminal_close_of_12_bar_mean_path",
                            "targetCloseAt": boundary + horizon * MS - 1, "forecastClose": str(target),
                            "grossForecastReturnBps": str(gross), "direction": direction,
                            "originalExecutableQuote": str(price) if price else None,
                            "quoteToForecastBps": str(edge) if edge is not None else None,
                            "modeledMoveAtQuoteReferenceBps": str((target - origin) / price * sign * 10_000) if price else None,
                            "quoteGapAtQuoteReferenceBps": str((origin - price) / price * sign * 10_000) if price else None,
                            "predictedCostCover": edge > reserve if edge is not None else False,
                            "predictedRequiredCover": edge > required if edge is not None else False})
    return {"pair": market["pair"], "originClose": str(origin), "originalBid": str(bid), "originalAsk": str(ask),
            "originalQuoteFetchedAt": market["fetchedAt"], "originalQuoteAsOf": market.get("quoteAsOf"),
            "quoteTimeBasis": "Original snapshot retrieval timestamp; a null event timestamp stays null.",
            "originalCost": cost, "forecastCloses": [str(x) for x in closes],
            "forecastBarOpens": [boundary + i * MS for i in range(12)], "horizons": assessments,
            "note": "Prefixes of one 12-bar generation, distinct from legacy standalone h3. Four sampled paths are averaged internally; no calibrated confidence, fills or realized PnL."}


def issue_bounds(clock, mode, started, issued, monotonic_seconds):
    low, high = clock_range(clock, mode, started)
    if issued < started or abs((issued - started) - monotonic_seconds * 1000) > 250:
        reject("CLOCK_JUMP")
    # Extrapolation records lateness but NEVER extends inference eligibility.
    return issued + low - started, issued + high - started


def prediction_identity(prediction):
    if (prediction.get("schemaVersion") != 1 or prediction.get("experiment") != SCHEMA
            or prediction.get("generationBars") != 12 or prediction.get("horizons") != list(HORIZONS)
            or prediction.get("usedForOrders") is not False or prediction.get("eligible") is not True
            or prediction.get("mode") not in MODES or UUID.fullmatch(str(prediction.get("snapshotId"))) is None):
        reject("PREDICTION_IDENTITY")
    require_hash(prediction.get("labFingerprint"))
    boundary, issued = millis(prediction.get("candleBoundary")), millis(prediction.get("issuedExchangeUpperAt"))
    if boundary % MS or not boundary <= issued < boundary + 60_000:
        reject("PREDICTION_CHRONOLOGY")
    if (not isinstance(prediction.get("expectedPairs"), list) or not prediction["expectedPairs"]
            or len(set(prediction["expectedPairs"])) != len(prediction["expectedPairs"])):
        reject("PREDICTION_PAIRS")
    return boundary


def settle_horizon(prediction, row, horizon, candles, available):
    boundary = prediction_identity(prediction)
    if horizon not in HORIZONS or row.get("pair") not in prediction["expectedPairs"]:
        reject("HORIZON_IDENTITY")
    target = boundary + horizon * MS - 1
    if millis(available) <= target:
        return None
    assessments = [x for x in row.get("horizons", []) if x.get("horizonBars") == horizon]
    if len(assessments) != 1 or assessments[0].get("targetCloseAt") != target:
        reject("HORIZON_TARGET")
    assessment = assessments[0]
    wanted = [boundary + i * MS for i in range(horizon)]
    found = [c for c in candles if c.get("openTime") in wanted]
    if [c.get("openTime") for c in found] != wanted or any(c.get("closeTime") != c["openTime"] + MS - 1 for c in found):
        return None
    origin, actual_close = number(row["originClose"]), number(found[-1]["close"])
    if min(origin, actual_close) <= 0:
        reject("SETTLEMENT_PRICE")
    actual = (actual_close / origin - 1) * 10_000
    forecast = number(assessment["grossForecastReturnBps"])
    if forecast != (number(assessment["forecastClose"]) / origin - 1) * 10_000:
        reject("FORECAST_VALUES_CHANGED")
    direction = assessment["direction"]
    if direction not in ("long", "short", "hold") or direction == "short" and prediction["mode"] == "demo":
        reject("SETTLEMENT_DIRECTION")
    cost = row["originalCost"]
    reserve, required = number(cost["estimatedRoundTripCostBps"]), number(cost["requiredPriceSpaceBps"])
    price = number(row["originalAsk"] if direction == "long" else row["originalBid"])
    actual_edge = (actual_close / price - 1) * (10_000 if direction == "long" else -10_000) if direction != "hold" else None
    return {"pair": row["pair"], "horizonBars": horizon, "targetCloseAt": target,
            "observedTargetClose": str(actual_close), "actualCloseReturnBps": str(actual),
            "modelAbsoluteErrorBps": str(abs(forecast - actual)), "unchangedPriceAbsoluteErrorBps": str(abs(actual)),
            "predictedDirection": direction, "predictedCostCover": assessment["predictedCostCover"],
            "predictedRequiredCover": assessment["predictedRequiredCover"],
            "actualCostCoverForPredictedDirection": actual_edge > reserve if actual_edge is not None else None,
            "actualRequiredCoverForPredictedDirection": actual_edge > required if actual_edge is not None else None,
            "quoteToFutureCloseBps": str(actual_edge) if actual_edge is not None else None,
            "strategyRealizedPnl": None,
            "note": "Observed subsequent close vs original quote and original estimated costs; no actual fills/exit quotes, no trade PnL."}


def review(settlements, predictions, fingerprint, as_of):
    require_hash(fingerprint)
    at = millis(as_of)
    result = {"schemaVersion": 1, "experiment": SCHEMA, "asOf": as_of, "labFingerprint": fingerprint,
              "matchedWindowBars": 12, "minimumMatchedWindows": 30, "usedForOrders": False,
              "strategyRealizedPnl": None, "promotionAuthorized": False, "recommendedHorizon": None,
              "forwardStage": "exploration", "holdoutValidated": False, "modes": {}}
    for mode in MODES:
        current = [p for p in predictions if p.get("labFingerprint") == fingerprint and p.get("mode") == mode]
        owners, boundaries = {}, set()
        for prediction in current:
            sid = prediction.get("snapshotId")
            boundary = millis(prediction.get("candleBoundary"))
            if (not isinstance(sid, str) or UUID.fullmatch(sid) is None or sid in owners or boundary in boundaries
                    or millis(prediction.get("issuedAt")) > at):
                reject("REVIEW_PREDICTION_OWNERSHIP")
            owners[sid] = prediction
            boundaries.add(boundary)
        by_boundary = {}
        for item in settlements:
            if item.get("labFingerprint") != fingerprint or item.get("mode") != mode:
                continue
            horizon, boundary = item.get("horizonBars"), millis(item.get("candleBoundary"))
            if horizon not in HORIZONS:
                reject("REVIEW_HORIZON")
            prediction = owners.get(item.get("snapshotId"))
            if prediction is None:
                reject("REVIEW_ORPHAN_SETTLEMENT")
            prediction_identity(prediction)
            if (prediction["candleBoundary"] != boundary or item.get("predictionContentSha256") != digest(prediction)
                    or item.get("expectedPairs") != prediction["expectedPairs"]):
                reject("REVIEW_PREDICTION_LINK")
            require_hash(item.get("predictionSha256"))
            target = boundary + horizon * MS - 1
            if not target < millis(item.get("settledAt")) <= at:
                reject("REVIEW_FUTURE_LABEL")
            if boundary % (12 * MS):
                continue
            group = by_boundary.setdefault(boundary, {})
            if horizon in group:
                reject("DUPLICATE_REVIEW_HORIZON")
            rows = item.get("rows", [])
            if not rows or len({r.get("pair") for r in rows}) != len(rows):
                reject("REVIEW_PAIRS")
            for row in rows:
                if (any(number(row.get(k)) < 0 for k in ("modelAbsoluteErrorBps", "unchangedPriceAbsoluteErrorBps"))
                        or row.get("targetCloseAt") != target or row.get("horizonBars") != horizon
                        or any(type(row.get(k)) is not bool for k in ("predictedCostCover", "predictedRequiredCover"))
                        or any(row.get(k) is not None and type(row[k]) is not bool for k in
                               ("actualCostCoverForPredictedDirection", "actualRequiredCoverForPredictedDirection"))):
                    reject("REVIEW_VALUE")
            group[horizon] = item
        matched = []
        for boundary, group in sorted(by_boundary.items()):
            if set(group) != set(HORIZONS):
                continue
            first = group[3]
            if (any(g.get("snapshotId") != first.get("snapshotId") or g.get("predictionSha256") != first.get("predictionSha256")
                    or g.get("expectedPairs") != first.get("expectedPairs") for g in group.values())):
                reject("REVIEW_MATCH_IDENTITY")
            if all(set(r["pair"] for r in g["rows"]) == set(first["expectedPairs"]) for g in group.values()):
                matched.append(group)
        matched = matched[-CONFIG["reviewWindows"]:]
        metrics = {}
        for horizon in HORIZONS:
            windows = [g[horizon]["rows"] for g in matched]
            flat = [row for rows in windows for row in rows]
            average = lambda key: (sum(sum(float(row[key]) for row in rows) / len(rows) for rows in windows) / len(windows)) if windows else None
            screened = [r for r in flat if r["predictedRequiredCover"]]
            model, unchanged = average("modelAbsoluteErrorBps"), average("unchangedPriceAbsoluteErrorBps")
            metrics[str(horizon)] = {"windows": len(windows), "pairRows": len(flat), "modelMaeBps": model,
                                     "unchangedPriceMaeBps": unchanged,
                                     "maeImprovementBps": unchanged - model if windows else None,
                                     "predictedCostCoverRows": sum(r["predictedCostCover"] for r in flat),
                                     "predictedRequiredCoverRows": len(screened),
                                     "actualCostCoverAmongRequiredScreenedRows": sum(r["actualCostCoverForPredictedDirection"] is True for r in screened),
                                     "actualRequiredCoverAmongRequiredScreenedRows": sum(r["actualRequiredCoverForPredictedDirection"] is True for r in screened),
                                     "countScope": "descriptive paired market rows; not independent trades"}
        latencies = sorted(float(p["totalSeconds"]) for p in current if isinstance(p.get("totalSeconds"), (int, float)))
        result["modes"][mode] = {"status": "comparison_available_for_manual_research" if len(matched) >= 30 else "collecting",
                                   "independentMatchedWindows": len(matched), "hourlyWindowsWithSomeLabels": len(by_boundary),
                                   "predictions": len(current), "eligiblePredictions": sum(p.get("eligible") is True for p in current),
                                   "lateOrStoppedPredictions": sum(p.get("eligible") is not True for p in current),
                                   "missingPairOutputs": sum(len(p.get("missingPairs", [])) for p in current),
                                   "fullPairCoveragePredictions": sum(not p.get("missingPairs") for p in current),
                                   "totalSecondsP50": latencies[len(latencies) // 2] if latencies else None,
                                   "totalSecondsP95": latencies[min(len(latencies) - 1, int(len(latencies) * .95))] if latencies else None,
                                   "lastMatchedBoundary": matched[-1][3]["candleBoundary"] if matched else None,
                                   "horizons": metrics, "recommendedHorizon": None}
    result["notes"] = ["All three horizons share the same generated path, symbol/start, original costs and quote. They are correlated, not independent bets.",
                       "Only common disjoint hourly starts with complete pair coverage enter comparison. Missing/partial/late evidence remains visible.",
            "Thirty matched windows is a predeclared diagnostic floor, not profit evidence. No automatic winner, parameter mutation or order authority."]
    return result
