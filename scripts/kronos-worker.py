"""Frozen pretrained Kronos sidecar: consumes bot snapshots; cannot send orders.

Commands: check (load and verify artifacts), once (current forward inference),
watch (continuous inference and prospective scoring until local STOP exists).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from pretrained_model import (MODES, SOURCES, MS, clock_range, cost_view, digest, exact_amounts,
                              forecast_row, millis, model_cycle_snapshot, rolling_review, settle_row, utc, validate_config, validate_snapshot)
from setup_kronos import SOURCE_HASHES, CHECKPOINTS, COMMIT

BASE = ROOT / "local/model-research"
CONFIG_HASHES = {"model": "5e0f6a605d5f81b5c9b559fe5cf716a1acb041c744e6f41bd05b097b7a685396",
                 "tokenizer": "2366e7ccfec76cbc19cf3c4c1b9c5d901be336ca1e83f2d2292c9bff381b77a2"}


def now_ms():
    return time.time_ns() // 1_000_000


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, indent=2, allow_nan=False) + "\n"
    if exclusive:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(data)
    else:
        temp = path.with_name(path.name + f".{os.getpid()}.tmp")
        temp.write_text(data, encoding="utf-8")
        temp.replace(path)


def safe_error(error):
    text = str(error)
    return text if text.startswith("MODEL_") and all(c.isupper() or c == "_" for c in text) else "MODEL_OPERATION_FAILED"


def consumer_integration(identity):
    """Describe a pinned host consumer configuration, never infer orders or fills."""
    result = {"enabled": False, "status": "disconnected", "reason": None,
              "evidenceScope": "configuration_only", "actualModelOrderCount": None,
              "actualModelRealizedPnl": None,
              "executionEvidence": ["local/<mode>/runs/*model-decision*",
                                    "local/<mode>/entry-plans", "local/readiness"]}
    try:
        execution = read(ROOT / "config/model-execution.json")
    except FileNotFoundError:
        return {**result, "reason": "MODEL_EXECUTION_CONFIG_MISSING"}
    except (OSError, ValueError, TypeError):
        return {**result, "reason": "MODEL_EXECUTION_CONFIG_INVALID"}
    if not isinstance(execution, dict) or type(execution.get("enabled")) is not bool:
        return {**result, "reason": "MODEL_EXECUTION_CONFIG_INVALID"}
    if execution["enabled"] is False:
        return {**result, "reason": "MODEL_EXECUTION_DISABLED"}
    required = {"schemaVersion": 1, "maxWaitSeconds": 35, "maxPredictionAgeSeconds": 60}
    if (any(type(execution.get(key)) is not int or execution[key] != value for key, value in required.items())
            or execution.get("model") != "kronos-small-pretrained-v1"
            or not isinstance(execution.get("modelFingerprint"), str)
            or re.fullmatch(r"[0-9a-f]{64}", execution["modelFingerprint"]) is None):
        return {**result, "reason": "MODEL_EXECUTION_CONFIG_INVALID"}
    if (execution["modelFingerprint"] != identity.get("fingerprint")
            or execution["model"] != identity.get("model")):
        return {**result, "reason": "MODEL_EXECUTION_FINGERPRINT_MISMATCH"}
    return {**result, "enabled": True, "status": "configured", "reason": None,
            "consumer": "v11_demo_rule_entry", "modelFingerprint": execution["modelFingerprint"]}


def diagnostic_scope(review):
    """Forecast scores have no access to the host's executed-trade accounting."""
    review.update(scope="forecast_error_diagnostics_only", orderAuthority="none",
                  usedForOrdersScope="forecast_producer_only",
                  downstreamUsage="see_host_execution_evidence")
    for value in review["modes"].values():
        # rolling_review's legacy zero describes its own lack of order calls.
        # Do not publish it as a count of trades by an independent host consumer.
        value.pop("realizedModelTrades", None)
        value.update(scope="forecast_error_diagnostics_only",
                     actualModelOrderCount=None, actualModelRealizedPnl=None)
    return review


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("MODEL_MARKET_REDIRECT_REJECTED")


def supplement(snapshot, market):
    mode, boundary = snapshot["mode"], snapshot["candleBoundary"]
    prefix = "/api/v3/klines" if mode == "demo" else "/fapi/v1/klines"
    query = urlencode({"symbol": market["pair"].split(":")[0].replace("/", ""), "interval": "5m",
                       "startTime": boundary - 96 * MS, "endTime": boundary - 1, "limit": 96})
    url = SOURCES[mode] + prefix + "?" + query
    started = now_ms()
    # Only this unsigned, fixed Demo klines route has runtime network access.
    with build_opener(NoRedirect()).open(Request(url, headers={"Accept": "application/json"}, method="GET"), timeout=5) as response:
        raw = response.read(250_001)
    if len(raw) > 250_000:
        raise ValueError("MODEL_MARKET_RESPONSE_TOO_LARGE")
    matrix = exact_amounts(market["candles"], json.loads(raw), boundary)
    return {"pair": market["pair"], "ohlcva": matrix, "source": SOURCES[mode] + prefix,
            "requestStartedAt": started, "receivedAt": now_ms(), "rawResponseSha256": digest(raw),
            "amountBasis": "Binance kline quote-asset volume field 7; exact OHLCV match required."}


def latest_snapshot(mode):
    files = list((ROOT / "local" / mode / "runs").glob("*.snapshot.json"))
    files.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    # A5m model source can sit behind four newer flow-only minute snapshots.
    # Bound scanning to two cycles; never enqueue the intervening observations.
    for path in files[:12]:
        raw = path.read_bytes()
        value = json.loads(raw)
        if value.get("mode") == mode and value.get("purpose") != "execution_probe" and model_cycle_snapshot(value):
            return value, digest(raw)
    return None, None


def source_freshness(snapshot, mode, now):
    """Feed health only; archived clock extrapolation never authorizes inference."""
    result = {"status": "unavailable", "lastSourceBoundary": None, "lastSourceBoundaryAt": None,
              "sourceAgeLowerMs": None, "sourceAgeUpperMs": None, "staleAfterMs": 2 * MS,
              "clockBasis": "Local elapsed time plus archived Demo clock offset bounds; not a fresh exchange clock observation."}
    if not snapshot:
        return {**result, "reason": "MODEL_SOURCE_MISSING"}
    try:
        completed = millis(snapshot["completedAt"])
        # Recheck original snapshot provenance at its completion time. Current
        # inference still uses validate_snapshot(..., now), including 60s expiry.
        boundary = validate_snapshot(snapshot, mode, completed)
        clock = snapshot["clock"]
        received = millis(clock["receivedAt"])
        lower, upper = clock_range(clock, mode, received)
        if now < completed or now < received:
            raise ValueError("MODEL_SOURCE_CLOCK_REVERSED")
        age_lower, age_upper = now + lower - received - boundary, now + upper - received - boundary
        result.update(lastSourceBoundary=boundary, lastSourceBoundaryAt=utc(boundary),
                      sourceAgeLowerMs=age_lower, sourceAgeUpperMs=age_upper,
                      status="stale" if age_lower > 2 * MS else "current")
        return result
    except (KeyError, ValueError, TypeError) as error:
        return {**result, "reason": safe_error(error)}


def load_model(config):
    began = time.perf_counter()
    manifest = read(BASE / "artifacts.json")
    expected = {"vendor/Kronos/" + path: sha for path, sha in SOURCE_HASHES.items()}
    for role, (_, _, sha) in CHECKPOINTS.items():
        expected[f"weights/{role}/model.safetensors"] = sha
        expected[f"weights/{role}/config.json"] = CONFIG_HASHES[role]
    if len(manifest.get("files", [])) != len(expected) or manifest.get("sourceCommit") != COMMIT:
        raise ValueError("MODEL_MANIFEST_INVALID")
    actual = {item["path"]: item["sha256"] for item in manifest["files"]}
    if actual != expected:
        raise ValueError("MODEL_MANIFEST_HASH_MISMATCH")
    for path, sha in expected.items():
        if digest((BASE / path).read_bytes()) != sha:
            raise ValueError("MODEL_ARTIFACT_HASH_MISMATCH")
    # Model classes are reviewed, pinned source. Safetensors is loaded directly;
    # no pickle, downloaded Python execution hook or from_pretrained fallback.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    sys.path.insert(0, str(BASE / "vendor/Kronos"))
    import torch
    from safetensors.torch import load_model as load_weights
    from model import Kronos, KronosTokenizer, KronosPredictor
    torch.set_num_threads(config["threads"])
    model = Kronos(**read(BASE / "weights/model/config.json"))
    tokenizer = KronosTokenizer(**read(BASE / "weights/tokenizer/config.json"))
    load_weights(model, str(BASE / "weights/model/model.safetensors"), strict=True)
    load_weights(tokenizer, str(BASE / "weights/tokenizer/model.safetensors"), strict=True)
    model.eval()
    tokenizer.eval()
    predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=512)
    implementation = {name: digest((ROOT / name).read_bytes()) for name in
                      ["src/pretrained_model.py", "scripts/kronos-worker.py", "scripts/setup_kronos.py", "config/model-research.json"]}
    environment = {name: importlib.metadata.version(name) for name in ["torch", "numpy", "pandas", "einops", "huggingface_hub", "safetensors"]}
    identity = {"schemaVersion": 1, "model": config["model"], "checkpoint": manifest["model"], "sourceCommit": COMMIT,
                "artifactHashes": expected, "implementation": implementation, "environment": environment,
                "config": config, "pretrained": True, "fineTuned": False}
    identity["fingerprint"] = digest(identity)
    identity["loadSeconds"] = time.perf_counter() - began
    identity["parameters"] = sum(p.numel() for p in model.parameters())
    identity["loadedAt"] = utc(now_ms())
    write(BASE / "loaded-model.json", identity)
    archive = BASE / "implementations" / identity["fingerprint"]
    for name in implementation:
        destination = archive / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes((ROOT / name).read_bytes())
    return predictor, identity


def settle_all(identity, snapshots):
    settlements = []
    for mode in MODES:
        snapshot = snapshots.get(mode)
        for file in sorted((BASE / "predictions" / mode).glob("*.json")):
            prediction = read(file)
            if prediction.get("modelFingerprint") != identity["fingerprint"]:
                continue
            target = BASE / "settlements" / mode / file.name
            if target.exists():
                result = read(target)
                if result.get("predictionSha256") != digest(file.read_bytes()) or result.get("modelFingerprint") != identity["fingerprint"] or result.get("mode") != mode or result.get("snapshotId") != prediction["snapshotId"]:
                    raise ValueError("MODEL_SETTLEMENT_IDENTITY")
            elif snapshot:
                # Exact source/pair and latest fully closed, validated market data.
                try:
                    validate_snapshot(snapshot, mode, now_ms())
                except ValueError:
                    continue
                available = snapshot["candleBoundary"]
                rows = []
                for forecast in prediction["forecasts"]:
                    markets = [m for m in snapshot["markets"] if m["pair"] == forecast["pair"]]
                    if len(markets) != 1:
                        continue
                    row = settle_row(prediction, forecast, markets[0]["candles"], available)
                    if row:
                        rows.append(row)
                if len(rows) != len(prediction["forecasts"]) or not rows:
                    continue
                result = {"schemaVersion": 1, "mode": mode, "snapshotId": prediction["snapshotId"],
                          "candleBoundary": prediction["candleBoundary"], "modelFingerprint": identity["fingerprint"],
                          "predictionSha256": digest(file.read_bytes()), "settledAt": utc(now_ms()),
                          "evidenceSnapshotId": snapshot["id"], "evidenceSnapshotSha256": digest(snapshot),
                          "complete": len(rows) == prediction["expectedPairs"], "rows": rows, "modelOrders": 0}
                write(target, result, exclusive=True)
            else:
                continue
            settlements.append(result)
    review = {"schemaVersion": 1, "asOf": utc(now_ms()), "modelFingerprint": identity["fingerprint"],
              "modes": rolling_review(settlements), "strategyRealizedPnl": None, "usedForOrders": False}
    for mode, value in review["modes"].items():
        value["lastSettledTargetAt"] = max((utc(millis(row["targetCloseAt"])) for item in settlements
                                           if item["mode"] == mode and item.get("complete") is True
                                           for row in item["rows"]), default=None)
        value["sourceFreshness"] = source_freshness(snapshots.get(mode), mode, now_ms())
        value["diagnosticStatus"] = value["status"]
        if value["sourceFreshness"]["status"] != "current":
            value["status"] = "stale_source" if value["sourceFreshness"]["status"] == "stale" else "unavailable"
            value["suppressAdvisoryEntries"] = True
    diagnostic_scope(review)
    write(BASE / "review.json", review)
    return review


def infer_snapshot(predictor, identity, config, snapshot, snapshot_sha, review):
    import numpy as np
    import pandas as pd
    import torch
    mode, snapshot_id = snapshot["mode"], snapshot["id"]
    target = BASE / "predictions" / mode / (snapshot_id + ".json")
    if target.exists():
        freshness = source_freshness(snapshot, mode, now_ms())
        state = {"current": "awaiting_next_cycle", "stale": "stale_source", "unavailable": "unavailable"}[freshness["status"]]
        return {"mode": mode, "status": state, "snapshotId": snapshot_id, "sourceFreshness": freshness,
                "predictionAlreadyRecorded": True, "usedForOrders": False}
    started = now_ms()
    boundary = validate_snapshot(snapshot, mode, started)
    markets = sorted(snapshot["markets"], key=lambda m: m["pair"])
    inputs, errors = [], []
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {m["pair"]: pool.submit(supplement, snapshot, m) for m in markets}
        for market in markets:
            try:
                inputs.append(jobs[market["pair"]].result())
            except Exception as error:
                errors.append({"pair": market["pair"], "reason": safe_error(error)})
    validate_snapshot(snapshot, mode, now_ms())
    if not inputs:
        raise ValueError("MODEL_ALL_INPUTS_UNAVAILABLE")
    frames = [pd.DataFrame(row["ohlcva"], columns=["open", "high", "low", "close", "volume", "amount"]) for row in inputs]
    x = pd.Series(pd.to_datetime([boundary - (96 - i) * MS for i in range(96)], unit="ms", utc=True))
    y = pd.Series(pd.to_datetime([boundary + i * MS for i in range(3)], unit="ms", utc=True))
    seed = (config["seed"] + int(digest(mode + snapshot_id)[:8], 16)) % (2**31)
    torch.manual_seed(seed)
    np.random.seed(seed)
    began = time.perf_counter()
    with torch.inference_mode():
        forecasts = predictor.predict_batch(frames, [x.copy() for _ in frames], [y.copy() for _ in frames],
                                            pred_len=3, T=config["temperature"], top_p=config["topP"],
                                            sample_count=config["sampleCount"], verbose=False)
    duration = time.perf_counter() - began
    issued = now_ms()
    validate_snapshot(snapshot, mode, issued)
    lower, upper = clock_range(snapshot["clock"], mode, issued)
    rows = []
    suppressed = review["modes"][mode]["suppressAdvisoryEntries"]
    for item, predicted in zip(inputs, forecasts):
        market = next(m for m in markets if m["pair"] == item["pair"])
        try:
            rows.append(forecast_row(market, predicted.to_numpy().tolist(), mode, boundary, utc(issued),
                                     cost_view(market, mode, issued), suppressed))
        except Exception as error:
            errors.append({"pair": market["pair"], "reason": safe_error(error)})
    if not rows:
        raise ValueError("MODEL_ALL_OUTPUTS_INVALID")
    input_record = {"snapshotId": snapshot_id, "mode": mode, "snapshotSha256": snapshot_sha,
                    "candleBoundary": boundary, "clock": snapshot["clock"], "inputs": inputs}
    input_file = BASE / "inputs" / mode / (snapshot_id + ".json")
    if input_file.exists() and read(input_file) != input_record:
        raise ValueError("MODEL_INPUT_ARCHIVE_CONFLICT")
    if not input_file.exists():
        write(input_file, input_record, exclusive=True)
    record = {"schemaVersion": 1, "source": "frozen-pretrained-kronos", "model": config["model"],
              "modelFingerprint": identity["fingerprint"], "pretrained": True, "fineTuned": False,
              "mode": mode, "snapshotId": snapshot_id, "snapshotSha256": snapshot_sha, "candleBoundary": boundary,
              "startedAt": utc(started), "issuedAt": utc(issued), "issuedExchangeLowerAt": lower,
              "issuedExchangeUpperAt": upper, "inferenceSeconds": duration, "totalSeconds": (issued - started) / 1000,
              "seed": seed, "sampleCount": config["sampleCount"], "expectedPairs": len(markets),
              "inputSha256": digest(input_file.read_bytes()), "reviewAsOf": review["asOf"],
              "forecasts": rows, "errors": errors, "executionRole": "advisory", "usedForOrders": False,
              "modelOrders": 0, "strategyRealizedPnl": None}
    write(target, record, exclusive=True)
    write(BASE / ("latest-" + mode + ".json"), record)
    return {"mode": mode, "status": "predicted", "snapshotId": snapshot_id, "forecasts": len(rows),
            "errors": errors, "inferenceSeconds": duration, "usedForOrders": False,
            "sourceFreshness": source_freshness(snapshot, mode, now_ms())}


def run_once(predictor, identity, config):
    snapshots, hashes, states = {}, {}, []
    for mode in MODES:
        try:
            value, sha = latest_snapshot(mode)
            if value:
                snapshots[mode], hashes[mode] = value, sha
            else:
                states.append({"mode": mode, "status": "unavailable", "reason": "MODEL_SOURCE_MISSING",
                               "sourceFreshness": source_freshness(None, mode, now_ms())})
        except Exception as error:
            states.append({"mode": mode, "status": "unavailable", "reason": safe_error(error),
                           "sourceFreshness": source_freshness(None, mode, now_ms())})
    try:
        review = settle_all(identity, snapshots)
    except Exception as error:
        # Corrupt/missing scoring evidence must not appear as a healthy zero.
        review = {"schemaVersion": 1, "asOf": utc(now_ms()), "modelFingerprint": identity["fingerprint"],
                  "modes": {mode: {"status": "unavailable", "suppressAdvisoryEntries": True,
                                   "lastSettledTargetAt": None,
                                   "sourceFreshness": source_freshness(snapshots.get(mode), mode, now_ms())} for mode in MODES},
                  "reason": safe_error(error), "strategyRealizedPnl": None, "usedForOrders": False}
        diagnostic_scope(review)
        write(BASE / "review.json", review)
    for mode, snapshot in snapshots.items():
        try:
            states.append(infer_snapshot(predictor, identity, config, snapshot, hashes[mode], review))
        except Exception as error:
            freshness = source_freshness(snapshot, mode, now_ms())
            states.append({"mode": mode, "status": "stale_source" if freshness["status"] == "stale" else "unavailable",
                           "reason": safe_error(error), "snapshotId": snapshot.get("id"), "sourceFreshness": freshness})
    for state in states:
        state["lastSettledTargetAt"] = review["modes"][state["mode"]].get("lastSettledTargetAt")
    status = {"pid": os.getpid(), "at": utc(now_ms()), "modelFingerprint": identity["fingerprint"],
              "executionRole": "advisory", "usedForOrders": False,
              "usedForOrdersScope": "forecast_producer_only", "orderAuthority": "none",
              "downstreamUsage": "see_host_execution_evidence",
              "consumerIntegration": consumer_integration(identity), "states": states}
    write(BASE / "status.json", status)
    integration = status["consumerIntegration"]
    consumer_text = ("已啟用與目前模型指紋一致的 v11 DEMO 進場讀取設定；主程式可依模型輸出與交易檢查決定進場。設定啟用本身不是已下單或已成交的證據。"
                     if integration["enabled"] else
                     f"目前模型尚未連接有效的進場讀取設定（{integration['reason']}）；不要把預測建議當成主程式已採用的交易決策。")
    lines = ["# Kronos 預訓練模型即時測試", "", f"檢查時間：{status['at']}；模型：{identity['checkpoint']}。",
             "", "官方固定權重、本機 CPU 推論、沒有重新訓練。模型讀取機器人的五分鐘快照，預測未來三根 K。預測產生程序本身沒有下單權限。",
             "", consumer_text,
             "", "本報告與預測檔案中的 usedForOrders=false、modelOrders=0 只描述預測產生程序，不代表主程式沒有使用模型或沒有實際成交。實際採用情況須查 local/<mode>/runs/*model-decision*，成交關聯查 entry-plans，實現損益查 local/readiness；本報告不推算成交筆數或獲利。",
             "", "## 最近一次事先記錄的預測", "", "以下 bps 為萬分之一；數值是預測與成本估計，不是成交損益。當輪建議只在已核對的 60 秒資料窗口內產生，不可把旧預測用在新一輪進場。", "",
             "| 模式 | 商品 | 預測記錄時間 UTC | 目標收盤時間 UTC | 預測漲跌 bps | 模型建議 |", "|---|---|---|---|---:|---|"]
    for mode in MODES:
        path = BASE / ("latest-" + mode + ".json")
        if not path.exists():
            continue
        saved = read(path)
        for row in saved["forecasts"]:
            lines.append(f"| {mode} | {row['pair']} | {saved['issuedAt']} | {utc(row['targetCloseAt'])} | {float(row['grossForecastReturnBps']):.3f} | {row['advisoryAction']} |")
    lines.extend(["", "## 前向表現檢查", "", "本區 scope=forecast_error_diagnostics_only，只檢查預測誤差，不統計主程式的實際成交或實現損益。每十五分鐘不重疊窗口合併同批商品，與價格不變基準比較預測誤差。至少 30 個窗口只是初步診斷門檻，不是 alpha、月利或勝率證明。"])
    for mode, value in review["modes"].items():
        lines.append(f"\n- {mode}：{value['status']}；已完成窗口 {value.get('independentTimeWindows', 0)}；停用模型進場建議：{value['suppressAdvisoryEntries']}。")
        lines.append(f"  最後來源 K 線邊界：{value['sourceFreshness']['lastSourceBoundaryAt']}；最後完成評分目標：{value.get('lastSettledTargetAt')}。")
    lines.append("\n上方檢查時間只是工作程序心跳；資料是否持續更新以來源 K 線邊界為準。來源超過兩個五分鐘週期會標示 stale_source，不重新製造或覆寫舊預測。")
    lines.extend(["", "完整權重與來源版本見 loaded-model.json；逐次輸入、預測及後續收盤對照分別在 inputs、predictions、settlements。錯誤詳見 status.json。", ""])
    report = BASE / "report.md"
    temp = report.with_suffix(".tmp")
    temp.write_text("\n".join(lines), encoding="utf-8")
    temp.replace(report)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "once", "watch"])
    args = parser.parse_args()
    config = validate_config(read(ROOT / "config/model-research.json"))
    BASE.mkdir(parents=True, exist_ok=True)
    # Windows byte lock is released by the OS after a crash; no stale-PID file
    # deletion and no second model worker can silently duplicate forecasts.
    import msvcrt
    with (BASE / "worker.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            predictor, identity = load_model(config)
            if args.command == "check":
                print(json.dumps({"status": "loaded", "model": identity["model"], "parameters": identity["parameters"],
                                  "fingerprint": identity["fingerprint"], "seconds": identity["loadSeconds"], "usedForOrders": False}))
                return
            while not (BASE / "STOP").exists():
                print(json.dumps(run_once(predictor, identity, config)), flush=True)
                if args.command == "once":
                    break
                time.sleep(5)
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "at": utc(now_ms()), "reason": safe_error(error)}), file=sys.stderr)
        raise SystemExit(1)
