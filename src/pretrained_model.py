"""Kronos adapter contracts and prospective scoring; no execution authority."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re

MS = 300_000
MODES = ("demo", "demo-futures")
SOURCES = {"demo": "https://demo-api.binance.com", "demo-futures": "https://demo-fapi.binance.com"}


def reject(code):
    raise ValueError("MODEL_" + code)


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        reject("NUMBER_INVALID")
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        reject("NUMBER_INVALID")
    if not result.is_finite() or abs(result.adjusted()) > 50:
        reject("NUMBER_INVALID")
    return result


def millis(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if value.tzinfo is None:
            reject("TIMEZONE_REQUIRED")
        value = int(value.timestamp() * 1000)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        reject("TIME_INVALID")
    return value


def utc(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(data).hexdigest()


def clock_range(clock, mode, now):
    suffix = "/api/v3/time" if mode == "demo" else "/fapi/v1/time"
    if mode not in MODES or clock.get("mode") != mode or clock.get("source") != SOURCES[mode] + suffix:
        reject("CLOCK_SOURCE")
    start, end, server = [millis(clock.get(k)) for k in ("requestStartedAt", "receivedAt", "serverTime")]
    low, high = server - end, server - start
    if not 0 <= end - start <= 1500 or max(abs(low), abs(high)) > 2000 or not 0 <= now - end <= 60_000:
        reject("CLOCK_UNBOUNDED_OR_STALE")
    return now + low, now + high


def validate_config(c):
    expected = {"schemaVersion": 1, "model": "kronos-small-pretrained-v1", "executionRole": "advisory",
                "modes": list(MODES), "timeframe": "5m", "historyBars": 96, "labelHorizonBars": 3,
                "maxPredictionAgeSeconds": 60, "device": "cpu", "threads": 2, "sampleCount": 4,
                "temperature": 1.0, "topP": .9, "seed": 2914, "reviewWindows": 100, "minimumReviewWindows": 30}
    if not isinstance(c, dict) or set(c) != set(expected) | {"note"} or any(type(c.get(k)) is not type(v) or c.get(k) != v for k, v in expected.items()) or not isinstance(c["note"], str):
        reject("CONFIG_NOT_REVIEWED")
    return c


def model_cycle_snapshot(s):
    """Flow can decide each minute; frozen candle models still observe once/5m.

    Reject malformed cadence metadata rather than silently treating it as a
    legacy model source. This selector does not relax validate_snapshot expiry.
    """
    keys = {"decisionCadenceVersion", "decisionIntervalMs", "decisionBoundary"}
    if not keys.intersection(s):
        return True
    boundary, candle = s.get("decisionBoundary"), s.get("candleBoundary")
    if (s.get("decisionCadenceVersion") != "flow-minute-v1"
            or type(s.get("decisionIntervalMs")) is not int or s["decisionIntervalMs"] != 60000
            or s.get("mode") not in MODES or s.get("timeframe") != "5m"
            or type(boundary) is not int or boundary <= 0 or boundary % 60000
            or type(candle) is not int or candle <= 0 or candle % MS
            or not candle <= boundary < candle + MS):
        reject("DECISION_TIMING_INVALID")
    return boundary == candle


def validate_snapshot(s, mode, now):
    if mode not in MODES or s.get("mode") != mode or s.get("timeframe") != "5m" or s.get("purpose") == "execution_probe":
        reject("SNAPSHOT_MODE")
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", s.get("id", "")):
        reject("SNAPSHOT_ID")
    boundary, created, completed = millis(s.get("candleBoundary")), millis(s.get("createdAt")), millis(s.get("completedAt"))
    low, high = clock_range(s.get("clock", {}), mode, now)
    if boundary % MS or not created <= completed <= now or not 0 <= now - created <= 60_000 or not boundary <= low <= high < boundary + 60_000:
        reject("SNAPSHOT_EXPIRED")
    markets = s.get("markets")
    if not isinstance(markets, list) or not 1 <= len(markets) <= (10 if mode == "demo" else 4):
        reject("MARKETS_INVALID")
    pairs = set()
    for market in markets:
        pair = market.get("pair", "")
        pattern = r"[A-Z0-9]+/USDT" if mode == "demo" else r"(?:BTC|ETH|SOL|BNB)/USDT:USDT"
        if not re.fullmatch(pattern, pair) or pair in pairs or market.get("source") != SOURCES[mode] or market.get("mode") != mode:
            reject("MARKET_IDENTITY")
        pairs.add(pair)
        if market.get("verifiedSpot" if mode == "demo" else "verifiedFutures") is not True:
            reject("MARKET_NOT_VERIFIED")
        validate_candles(market.get("candles"), boundary)
    return boundary


def validate_candles(candles, boundary):
    if not isinstance(candles, list) or len(candles) != 96:
        reject("CANDLE_COUNT")
    for index, c in enumerate(candles):
        start = boundary - (96 - index) * MS
        if c.get("openTime") != start or c.get("closeTime") != start + MS - 1:
            reject("CANDLE_TIME_OR_GAP")
        o, h, low, close, vol = [number(c.get(k)) for k in ("open", "high", "low", "close", "volume")]
        if min(o, h, low, close) <= 0 or vol < 0 or h < max(o, low, close) or low > min(o, h, close):
            reject("CANDLE_VALUES")


def exact_amounts(candles, raw, boundary):
    """Get actual quote-asset volume, rejecting revisions instead of synthesizing it."""
    validate_candles(candles, boundary)
    if not isinstance(raw, list) or len(raw) != 96:
        reject("SUPPLEMENT_COUNT")
    result = []
    for c, b in zip(candles, raw):
        if not isinstance(b, list) or len(b) < 8 or b[0] != c["openTime"] or b[6] != c["closeTime"]:
            reject("SUPPLEMENT_TIME")
        if any(number(b[i + 1]) != number(c[k]) for i, k in enumerate(("open", "high", "low", "close", "volume"))):
            reject("PROVIDER_CANDLE_REVISED")
        amount = number(b[7])
        if amount < 0:
            reject("QUOTE_VOLUME_INVALID")
        result.append([float(number(c[k])) for k in ("open", "high", "low", "close", "volume")] + [float(amount)])
    return result


def cost_view(market, mode, now):
    c = market.get("entryCost", {})
    if c.get("status") != "ok" or c.get("mode") != mode or c.get("pair") != market["pair"] or c.get("source") != SOURCES[mode]:
        return {"status": "unavailable", "reason": "COST_SOURCE"}
    try:
        cost, required = number(c.get("estimatedRoundTripCostBps")), number(c.get("requiredPriceSpaceBps"))
        if cost < 0 or required < cost or not 0 <= now - millis(c.get("observedAt")) <= 900_000:
            reject("COST_STALE_OR_INVALID")
        return {"status": "ok", "estimatedRoundTripCostBps": str(cost), "requiredPriceSpaceBps": str(required),
                "observedAt": c["observedAt"], "basis": "Original bot snapshot cost estimate; not known future expense."}
    except (ValueError, TypeError):
        return {"status": "unavailable", "reason": "COST_STALE_OR_INVALID"}


def forecast_row(market, prediction, mode, boundary, issued, cost, suppressed=False):
    if len(prediction) != 3 or any(len(row) != 6 for row in prediction):
        reject("OUTPUT_SHAPE")
    closes = [number(row[3]) for row in prediction]
    if any(c <= 0 for c in closes) or any(not math.isfinite(float(v)) for row in prediction for v in row):
        reject("OUTPUT_NONFINITE_OR_PRICE")
    origin = number(market["candles"][-1]["close"])
    gross = (closes[-1] / origin - 1) * 10_000
    action = "hold"
    long_net = short_net = None
    if cost["status"] == "ok":
        reserve, required = number(cost["estimatedRoundTripCostBps"]), number(cost["requiredPriceSpaceBps"])
        long_net, short_net = gross - reserve, -gross - reserve
        if gross > required:
            action = "buy" if mode == "demo" else "open-long"
        elif mode == "demo-futures" and -gross > required:
            action = "open-short"
    return {"pair": market["pair"], "originClose": str(origin), "forecastCloses": [str(v) for v in closes],
            "forecastBarOpens": [boundary + MS * i for i in range(3)], "targetCloseAt": boundary + MS * 3 - 1,
            "grossForecastReturnBps": str(gross), "estimatedLongNetBps": str(long_net) if long_net is not None else None,
            "estimatedShortNetBps": str(short_net) if short_net is not None and mode == "demo-futures" else None, "cost": cost,
            "rawCostScreenedAction": action, "advisoryAction": "hold" if suppressed else action,
            "suppressedByModelReview": suppressed, "issuedAt": issued, "usedForOrders": False,
            "note": "Forecast is the mean of 4 sampled paths, not calibrated confidence or a trade fill. Cost-screened close-to-close movement is not realized strategy PnL."}


def settle_row(prediction, forecast, candles, available_at):
    boundary, issued, target = [millis(v) for v in (prediction["candleBoundary"], prediction["issuedExchangeUpperAt"], forecast["targetCloseAt"])]
    if boundary % MS or target != boundary + 3 * MS - 1 or not boundary <= issued < boundary + 60_000:
        reject("SETTLEMENT_CHRONOLOGY")
    if millis(available_at) <= target:
        return None
    wanted = [prediction["candleBoundary"] + i * MS for i in range(3)]
    found = [c for c in candles if c.get("openTime") in wanted]
    if [c.get("openTime") for c in found] != wanted or any(c.get("closeTime") != c["openTime"] + MS - 1 for c in found):
        return None
    origin, actual_close = number(forecast["originClose"]), number(found[-1]["close"])
    if min(origin, actual_close) <= 0:
        reject("SETTLEMENT_PRICE")
    actual = (actual_close / origin - 1) * 10_000
    predicted = number(forecast["grossForecastReturnBps"])
    return {"pair": forecast["pair"], "targetCloseAt": target, "observedTargetClose": str(actual_close),
            "actualCloseReturnBps": str(actual), "modelAbsoluteErrorBps": str(abs(predicted - actual)),
            "unchangedPriceAbsoluteErrorBps": str(abs(actual)),
            "directionCorrect": (predicted > 0) == (actual > 0) if predicted != 0 and actual != 0 else None,
            "source": "subsequent-closed-demo-candles", "strategyRealizedPnl": None,
            "note": "Prospective forecast scoring only. No hypothetical trade profit is recorded."}


def rolling_review(settlements, minimum=30, limit=100):
    if not isinstance(settlements, list) or type(minimum) is not int or type(limit) is not int or minimum < 1 or limit < 2 * minimum:
        reject("REVIEW_CONFIG")
    output = {}
    for mode in MODES:
        # Disjoint 15-minute targets reduce temporal overlap; all pairs in one
        # window count as one observed window, not independent trades.
        windows = [s for s in settlements if s.get("mode") == mode and s.get("complete") is True
                   and s.get("candleBoundary", 1) % (3 * MS) == 0 and s.get("rows")]
        unique = {}
        for item in windows:
            key = millis(item["candleBoundary"])
            if key in unique:
                reject("DUPLICATE_REVIEW_WINDOW")
            pairs = set()
            for row in item["rows"]:
                pair = row.get("pair")
                if not isinstance(pair, str) or pair in pairs:
                    reject("REVIEW_PAIR_INVALID")
                pairs.add(pair)
                if any(number(row.get(k)) < 0 for k in ("modelAbsoluteErrorBps", "unchangedPriceAbsoluteErrorBps")):
                    reject("REVIEW_ERROR_INVALID")
            unique[key] = item
        windows = sorted(unique.values(), key=lambda s: s["candleBoundary"])[-limit:]

        def metric(selected):
            if not selected:
                return None
            model = sum(sum(float(r["modelAbsoluteErrorBps"]) for r in s["rows"]) / len(s["rows"]) for s in selected) / len(selected)
            baseline = sum(sum(float(r["unchangedPriceAbsoluteErrorBps"]) for r in s["rows"]) / len(s["rows"]) for s in selected) / len(selected)
            return {"windows": len(selected), "modelMaeBps": model, "unchangedPriceMaeBps": baseline,
                    "maeImprovementBps": baseline - model}

        recent, prior = metric(windows[-minimum:]), metric(windows[-2 * minimum:-minimum])
        enough = len(windows) >= minimum
        underperforming = enough and recent["maeImprovementBps"] <= 0
        possible_decay = underperforming and len(windows) >= 2 * minimum and prior["maeImprovementBps"] > 0
        output[mode] = {"independentTimeWindows": len(windows), "minimumReviewWindows": minimum,
                        "status": "possible_degradation" if possible_decay else "underperforming_baseline" if underperforming else "observing" if enough else "collecting",
                        "suppressAdvisoryEntries": underperforming, "recent": recent, "prior": prior,
                        "alphaEstablished": False, "realizedModelTrades": 0,
                        "note": "Diagnostic error comparison, not a significance test or alpha proof. Each cross-asset window is one time observation; cross-asset dependence remains."}
    return output
