"""Prospective frozen Kronos horizon lab. CLI: check / once / watch.

Reads only pinned local model artifacts and current archived Demo market evidence.
No network, credentials, account clients, training, order calls or v11 mutations.
All output and the process lock live in local/horizon-lab.
"""
import argparse
from copy import deepcopy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from horizon_lab import (SCHEMA, HORIZONS, UUID, config, digest, millis, utc, validate_bundle,
                         forecast_prefixes, issue_bounds, settle_horizon, review, require_hash)
from pretrained_model import MODES, MS, model_cycle_snapshot, validate_config, validate_snapshot
from setup_kronos import SOURCE_HASHES, CHECKPOINTS, COMMIT

BASE = ROOT / "local/horizon-lab"
PRODUCER = ROOT / "local/model-research"
CONFIG_HASHES = {"model": "5e0f6a605d5f81b5c9b559fe5cf716a1acb041c744e6f41bd05b097b7a685396",
                 "tokenizer": "2366e7ccfec76cbc19cf3c4c1b9c5d901be336ca1e83f2d2292c9bff381b77a2"}


def now_ms():
    return time.time_ns() // 1_000_000


def safe_error(error):
    value = str(error)
    return value if re.fullmatch(r"(?:HORIZON|MODEL)_[A-Z_]+", value) else "HORIZON_OPERATION_FAILED"


def read_raw(path, limit=8_000_000):
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError("HORIZON_FILE_INVALID")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise ValueError("HORIZON_FILE_INVALID")
    return raw, json.loads(raw.decode("utf-8"))


def read(path):
    return read_raw(path)[1]


def write(path, value, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, indent=2, allow_nan=False) + "\n"
    if exclusive:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    else:
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        temporary.write_text(data, encoding="utf-8")
        temporary.replace(path)


def archive_bytes(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError("HORIZON_ARCHIVE_CONFLICT")
        return
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def file_digest(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1_048_576), b""):
            value.update(chunk)
    return value.hexdigest()


def stopped(mode=None):
    return ((BASE / "STOP").exists() or (PRODUCER / "STOP").exists()
            or mode is not None and (ROOT / "local" / mode / "STOP").exists())


def producer_identity():
    loaded = read(PRODUCER / "loaded-model.json")
    core = {key: value for key, value in loaded.items() if key not in ("fingerprint", "loadSeconds", "parameters", "loadedAt")}
    if (loaded.get("fingerprint") != digest(core) or loaded.get("model") != "kronos-small-pretrained-v1"
            or loaded.get("pretrained") is not True or loaded.get("fineTuned") is not False
            or loaded.get("sourceCommit") != COMMIT):
        raise ValueError("HORIZON_PRODUCER_IDENTITY")
    validate_config(loaded.get("config"))
    execution = read(ROOT / "config/model-execution.json")
    if execution.get("modelFingerprint") != loaded["fingerprint"] or execution.get("model") != loaded["model"]:
        raise ValueError("HORIZON_PRODUCER_PIN_MISMATCH")
    return loaded


def verify_local_assets():
    loaded = producer_identity()
    expected = {"vendor/Kronos/" + path: value for path, value in SOURCE_HASHES.items()}
    for role, (_, _, value) in CHECKPOINTS.items():
        expected[f"weights/{role}/model.safetensors"] = value
        expected[f"weights/{role}/config.json"] = CONFIG_HASHES[role]
    manifest = read(PRODUCER / "artifacts.json")
    if (manifest.get("sourceCommit") != COMMIT or len(manifest.get("files", [])) != len(expected)
            or {row["path"]: row["sha256"] for row in manifest["files"]} != expected
            or loaded.get("artifactHashes") != expected):
        raise ValueError("HORIZON_ARTIFACT_MANIFEST")
    for path, value in expected.items():
        if file_digest(PRODUCER / path) != value:
            raise ValueError("HORIZON_ARTIFACT_CHANGED")
    implementation = loaded.get("implementation", {})
    names = {"src/pretrained_model.py", "scripts/kronos-worker.py", "scripts/setup_kronos.py", "config/model-research.json"}
    if set(implementation) != names or any(file_digest(ROOT / name) != implementation[name] for name in names):
        raise ValueError("HORIZON_PRODUCER_SOURCE_CHANGED")
    return loaded, expected


def load_frozen():
    """Own loader: never invokes the original worker's output-mutating loader."""
    began = time.perf_counter()
    loaded, artifacts = verify_local_assets()
    for key, value in {"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}.items():
        os.environ[key] = value
    sys.path.insert(0, str(PRODUCER / "vendor/Kronos"))
    import torch
    from safetensors.torch import load_model as load_weights
    from model import Kronos, KronosTokenizer, KronosPredictor
    torch.set_num_threads(1)
    model = Kronos(**read(PRODUCER / "weights/model/config.json"))
    tokenizer = KronosTokenizer(**read(PRODUCER / "weights/tokenizer/config.json"))
    load_weights(model, str(PRODUCER / "weights/model/model.safetensors"), strict=True)
    load_weights(tokenizer, str(PRODUCER / "weights/tokenizer/model.safetensors"), strict=True)
    model.eval()
    tokenizer.eval()
    predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=512)
    names = ["src/horizon_lab.py", "scripts/kronos-horizon-lab.py", "src/pretrained_model.py", "scripts/setup_kronos.py"]
    source_bytes = {name: (ROOT / name).read_bytes() for name in names}
    identity = {"schemaVersion": 1, "experiment": SCHEMA, "checkpoint": loaded["checkpoint"],
                "producerModelFingerprint": loaded["fingerprint"], "artifactHashes": artifacts,
                "sourceCommit": COMMIT, "implementation": {name: digest(raw) for name, raw in source_bytes.items()},
                "config": config(), "forwardStage": "exploration", "holdoutValidated": False,
                "environment": {name: importlib.metadata.version(name) for name in
                                ["torch", "numpy", "pandas", "einops", "huggingface_hub", "safetensors"]},
                "pretrained": True, "fineTuned": False, "usedForOrders": False, "promotionAuthorized": False}
    identity["labFingerprint"] = digest(identity)
    identity["loadedAt"] = utc(now_ms())
    identity["loadSeconds"] = time.perf_counter() - began
    archive = BASE / "implementations" / identity["labFingerprint"]
    for name, raw in source_bytes.items():
        archive_bytes(archive / name, raw)
    archive_bytes(archive / "configuration.json", (json.dumps(config(), sort_keys=True, indent=2) + "\n").encode())
    producer_core = {key: value for key, value in loaded.items() if key not in ("loadSeconds", "parameters", "loadedAt")}
    archive_bytes(archive / "producer-identity.json", (json.dumps(producer_core, sort_keys=True, indent=2) + "\n").encode())
    write(BASE / "loaded-model.json", identity)
    write(BASE / "configuration.json", config())
    return predictor, identity


def latest_closed_snapshot(mode):
    files = sorted((ROOT / "local" / mode / "runs").glob("*.snapshot.json"),
                   key=lambda path: path.stat().st_mtime_ns, reverse=True)
    for path in files[:12]:
        raw, value = read_raw(path)
        if value.get("mode") != mode or value.get("purpose") == "execution_probe" or not model_cycle_snapshot(value):
            continue
        validate_snapshot(value, mode, millis(value["completedAt"]))
        return raw, value
    return None


def source_observation(snapshot, mode, now):
    from pretrained_model import clock_range
    completed = millis(snapshot["completedAt"])
    boundary = validate_snapshot(snapshot, mode, completed)
    low, high = clock_range(snapshot["clock"], mode, completed)
    if now < completed:
        raise ValueError("HORIZON_SOURCE_CLOCK_REVERSED")
    age_low, age_high = now + low - completed - boundary, now + high - completed - boundary
    return {"status": "stale_source" if age_low > 2 * MS else "awaiting_fresh_cycle" if age_high >= 60_000 else "current",
            "snapshotId": snapshot["id"], "lastSourceBoundary": boundary, "lastSourceBoundaryAt": utc(boundary),
            "sourceAgeLowerMs": age_low, "sourceAgeUpperMs": age_high,
            "clockBasis": "Archived offset bounds only describe feed age; inference still requires a fresh first-minute snapshot."}


def current_bundle(mode, identity):
    pointer_raw, pointer = read_raw(PRODUCER / f"latest-{mode}.json")
    sid = pointer.get("snapshotId", "")
    if UUID.fullmatch(sid) is None:
        raise ValueError("HORIZON_SNAPSHOT_ID")
    prediction_raw, producer = read_raw(PRODUCER / "predictions" / mode / (sid + ".json"))
    if digest(pointer_raw) != digest(prediction_raw):
        raise ValueError("HORIZON_PRODUCER_POINTER_CHANGED")
    snapshot_raw, snapshot = read_raw(ROOT / "local" / mode / "runs" / (sid + ".snapshot.json"))
    input_raw, inputs = read_raw(PRODUCER / "inputs" / mode / (sid + ".json"))
    if producer.get("modelFingerprint") != identity["producerModelFingerprint"]:
        raise ValueError("HORIZON_PRODUCER_PIN_CHANGED")
    freshness = source_observation(snapshot, mode, now_ms())
    if freshness["status"] != "current":
        return {"snapshot": snapshot, "deferred": {**freshness, "lastProducerIssuedAt": producer.get("issuedAt")}}
    validated = validate_bundle(snapshot, producer, inputs, mode=mode, pin=identity["producerModelFingerprint"],
                                snapshot_sha=digest(snapshot_raw), producer_sha=digest(prediction_raw),
                                input_sha=digest(input_raw), now=now_ms())
    return {"snapshot": snapshot, "producer": producer, "inputs": inputs, "validated": validated,
            "raw": {"snapshot": snapshot_raw, "producer": prediction_raw, "input": input_raw}}


def infer_current(predictor, identity, mode):
    if stopped(mode):
        return {"mode": mode, "status": "stopped"}
    bundle = current_bundle(mode, identity)
    if "deferred" in bundle:
        return {"mode": mode, **bundle["deferred"]}
    snapshot, validated = bundle["snapshot"], bundle["validated"]
    sid, boundary = snapshot["id"], validated["boundary"]
    target = BASE / "predictions" / mode / (sid + ".json")
    attempt = BASE / "attempts" / mode / (sid + ".json")
    if target.exists():
        previous = read(target)
        if previous.get("labFingerprint") != identity["labFingerprint"]:
            return {"mode": mode, "status": "cycle_belongs_to_previous_lab", "snapshotId": sid}
        return {"mode": mode, "status": "awaiting_next_cycle", "snapshotId": sid}
    if attempt.exists():
        return {"mode": mode, "status": "previous_attempt_incomplete", "snapshotId": sid}
    for previous_path in (BASE / "attempts" / mode).glob("*.json"):
        previous = read(previous_path)
        if previous.get("candleBoundary") == boundary:
            return {"mode": mode, "status": "boundary_already_attempted", "snapshotId": sid}
    import numpy as np
    import pandas as pd
    import torch
    started = now_ms()
    started_monotonic = time.perf_counter()
    validate_bundle(snapshot, bundle["producer"], bundle["inputs"], mode=mode,
                    pin=identity["producerModelFingerprint"], snapshot_sha=digest(bundle["raw"]["snapshot"]),
                    producer_sha=digest(bundle["raw"]["producer"]), input_sha=digest(bundle["raw"]["input"]), now=started)
    for role, raw in bundle["raw"].items():
        archive_bytes(BASE / "inputs" / mode / (sid + "." + role + ".json"), raw)
    write(attempt, {"schemaVersion": 1, "experiment": SCHEMA, "labFingerprint": identity["labFingerprint"],
                    "mode": mode, "snapshotId": sid, "candleBoundary": boundary, "startedAt": utc(started), "usedForOrders": False,
                    "sourceHashes": {role: digest(raw) for role, raw in bundle["raw"].items()}}, exclusive=True)
    items = validated["inputs"]
    frames = [pd.DataFrame(item["ohlcva"], columns=["open", "high", "low", "close", "volume", "amount"]) for item in items]
    x = pd.Series(pd.to_datetime([boundary - (96 - i) * MS for i in range(96)], unit="ms", utc=True))
    y = pd.Series(pd.to_datetime([boundary + i * MS for i in range(12)], unit="ms", utc=True))
    seed = (config()["seed"] + int(digest(mode + sid)[:8], 16)) % (2**31)
    torch.manual_seed(seed)
    np.random.seed(seed)
    if stopped(mode):
        raise ValueError("HORIZON_STOPPED_BEFORE_INFERENCE")
    began = time.perf_counter()
    with torch.inference_mode():
        values = predictor.predict_batch(frames, [x.copy() for _ in frames], [y.copy() for _ in frames],
                                          pred_len=12, T=1.0, top_p=.9, sample_count=4, verbose=False)
    elapsed = time.perf_counter() - began
    issued = now_ms()
    issued_low, issued_high = issue_bounds(snapshot["clock"], mode, started, issued,
                                          time.perf_counter() - started_monotonic)
    reasons = []
    if not boundary <= issued_low <= issued_high < boundary + 60_000:
        reasons.append("HORIZON_ISSUED_LATE")
    if stopped(mode):
        reasons.append("HORIZON_STOPPED_DURING_INFERENCE")
    if producer_identity()["fingerprint"] != identity["producerModelFingerprint"]:
        reasons.append("HORIZON_PRODUCER_PIN_CHANGED")
    if len(values) != len(items):
        raise ValueError("HORIZON_OUTPUT_PARTITION")
    rows, errors = [], []
    for item, value in zip(items, values):
        try:
            rows.append(forecast_prefixes(validated["markets"][item["pair"]], value.to_numpy().tolist(), mode, boundary, issued))
        except Exception as error:
            errors.append({"pair": item["pair"], "reason": safe_error(error)})
    if not rows:
        reasons.append("HORIZON_NO_VALID_OUTPUTS")
    missing = sorted(set(validated["expectedPairs"]) - {row["pair"] for row in rows})
    record = {"schemaVersion": 1, "experiment": SCHEMA, "labFingerprint": identity["labFingerprint"],
              "producerModelFingerprint": identity["producerModelFingerprint"], "mode": mode, "snapshotId": sid,
              "sourceHashes": {role: digest(raw) for role, raw in bundle["raw"].items()},
              "candleBoundary": boundary, "startedAt": utc(started), "issuedAt": utc(issued),
              "issuedExchangeLowerAt": issued_low, "issuedExchangeUpperAt": issued_high,
              "clock": snapshot["clock"], "generationBars": 12, "horizons": list(HORIZONS),
              "seed": seed, "sampleCount": 4, "temperature": 1.0, "topP": .9,
              "inferenceSeconds": elapsed, "totalSeconds": (issued - started) / 1000,
              "expectedPairs": validated["expectedPairs"], "missingPairs": missing,
              "sourceMissingPairs": validated["missingPairs"], "rows": rows, "errors": errors,
              "eligible": not reasons, "ineligibleReasons": reasons, "usedForOrders": False,
              "forwardStage": "exploration", "holdoutValidated": False, "strategyRealizedPnl": None,
              "promotionAuthorized": False, "legacyH3ComparableByIdentity": False}
    write(target, record, exclusive=True)
    return {"mode": mode, "status": "predicted" if record["eligible"] else "ineligible_prediction",
            "snapshotId": sid, "eligible": record["eligible"], "missingPairs": missing,
            "inferenceSeconds": elapsed, "totalSeconds": record["totalSeconds"], "reasons": reasons}


def collect_scores(identity, snapshots):
    predictions, settlements = [], []
    for mode in MODES:
        current = snapshots.get(mode)
        for path in sorted((BASE / "predictions" / mode).glob("*.json")):
            raw, prediction = read_raw(path)
            if prediction.get("labFingerprint") != identity["labFingerprint"]:
                continue
            predictions.append(prediction)
            if prediction.get("eligible") is not True:
                continue
            sid = prediction.get("snapshotId", "")
            if UUID.fullmatch(sid) is None or path.name != sid + ".json" or prediction.get("mode") != mode:
                raise ValueError("HORIZON_PREDICTION_FILE_IDENTITY")
            if set(prediction.get("sourceHashes", {})) != {"snapshot", "producer", "input"}:
                raise ValueError("HORIZON_ARCHIVED_INPUT_PARTITION")
            archived = {}
            for role, expected in prediction["sourceHashes"].items():
                if role not in ("snapshot", "producer", "input") or digest((BASE / "inputs" / mode / (sid + "." + role + ".json")).read_bytes()) != require_hash(expected):
                    raise ValueError("HORIZON_ARCHIVED_INPUT_CHANGED")
                archived[role] = read(BASE / "inputs" / mode / (sid + "." + role + ".json"))
            validate_bundle(archived["snapshot"], archived["producer"], archived["input"], mode=mode,
                            pin=identity["producerModelFingerprint"], snapshot_sha=prediction["sourceHashes"]["snapshot"],
                            producer_sha=prediction["sourceHashes"]["producer"], input_sha=prediction["sourceHashes"]["input"],
                            now=millis(prediction["startedAt"]))
            for horizon in HORIZONS:
                target = BASE / "settlements" / mode / (sid + "-h" + str(horizon) + ".json")
                if target.exists():
                    item = read(target)
                    if (item.get("predictionSha256") != digest(raw) or item.get("predictionContentSha256") != digest(prediction)
                            or item.get("labFingerprint") != identity["labFingerprint"]
                            or item.get("snapshotId") != sid or item.get("mode") != mode or item.get("horizonBars") != horizon):
                        raise ValueError("HORIZON_SETTLEMENT_IDENTITY")
                elif current and not stopped(mode):
                    source_raw, source = current
                    if source["candleBoundary"] < prediction["candleBoundary"] + horizon * MS:
                        continue
                    rows = []
                    markets = {m["pair"]: m for m in source["markets"]}
                    for row in prediction["rows"]:
                        if row["pair"] not in markets:
                            continue
                        value = settle_horizon(prediction, row, horizon, markets[row["pair"]]["candles"], source["candleBoundary"])
                        if value:
                            rows.append(value)
                    if len(rows) != len(prediction["rows"]) or not rows:
                        continue
                    archive_bytes(BASE / "label-inputs" / mode / (source["id"] + ".snapshot.json"), source_raw)
                    item = {"schemaVersion": 1, "experiment": SCHEMA, "mode": mode, "snapshotId": sid,
                            "labFingerprint": identity["labFingerprint"], "predictionSha256": digest(raw),
                            "predictionContentSha256": digest(prediction),
                            "horizonBars": horizon, "candleBoundary": prediction["candleBoundary"],
                            "expectedPairs": prediction["expectedPairs"], "rows": rows,
                            "settledAt": utc(now_ms()), "evidenceSnapshotId": source["id"],
                            "evidenceSnapshotSha256": digest(source_raw), "usedForOrders": False,
                            "strategyRealizedPnl": None}
                    write(target, item, exclusive=True)
                else:
                    continue
                evidence_id = item.get("evidenceSnapshotId", "")
                if UUID.fullmatch(evidence_id) is None:
                    raise ValueError("HORIZON_LABEL_IDENTITY")
                label_raw, label = read_raw(BASE / "label-inputs" / mode / (evidence_id + ".snapshot.json"))
                if digest(label_raw) != item.get("evidenceSnapshotSha256") or label.get("id") != evidence_id:
                    raise ValueError("HORIZON_LABEL_CHANGED")
                validate_snapshot(label, mode, millis(label["completedAt"]))
                if not millis(label["completedAt"]) <= millis(item["settledAt"]) <= now_ms():
                    raise ValueError("HORIZON_LABEL_CHRONOLOGY")
                label_markets = {market["pair"]: market for market in label["markets"]}
                expected_rows = [settle_horizon(prediction, row, horizon, label_markets[row["pair"]]["candles"], label["candleBoundary"])
                                 for row in prediction["rows"] if row["pair"] in label_markets]
                if None in expected_rows or expected_rows != item.get("rows") or len(expected_rows) != len(prediction["rows"]):
                    raise ValueError("HORIZON_LABEL_ROWS_CHANGED")
                settlements.append(item)
    return review(settlements, predictions, identity["labFingerprint"], utc(now_ms()))


def run_once(predictor, identity):
    started, mono = now_ms(), time.perf_counter()
    if producer_identity()["fingerprint"] != identity["producerModelFingerprint"]:
        raise ValueError("HORIZON_PRODUCER_PIN_CHANGED")
    if any(file_digest(ROOT / name) != sha for name, sha in identity["implementation"].items()):
        raise ValueError("HORIZON_IMPLEMENTATION_CHANGED_RESTART_REQUIRED")
    snapshots, states = {}, []
    for mode in MODES:
        if stopped(mode):
            states.append({"mode": mode, "status": "stopped"})
            continue
        try:
            value = latest_closed_snapshot(mode)
            if value:
                freshness = source_observation(value[1], mode, now_ms())
                if freshness["status"] == "current":
                    snapshots[mode] = value
                else:
                    states.append({"mode": mode, "stage": "labels", **freshness})
        except Exception as error:
            states.append({"mode": mode, "stage": "labels", "status": "waiting_current_closed_snapshot", "reason": safe_error(error)})
        try:
            states.append(infer_current(predictor, identity, mode))
        except Exception as error:
            states.append({"mode": mode, "stage": "prediction", "status": "unavailable", "reason": safe_error(error)})
    if abs((now_ms() - started) - (time.perf_counter() - mono) * 1000) > 250:
        raise ValueError("HORIZON_CLOCK_JUMP")
    try:
        result = collect_scores(identity, snapshots)
    except Exception as error:
        result = {"schemaVersion": 1, "experiment": SCHEMA, "labFingerprint": identity["labFingerprint"],
                  "asOf": utc(now_ms()), "status": "unavailable", "reason": safe_error(error),
                  "usedForOrders": False, "promotionAuthorized": False, "recommendedHorizon": None}
    write(BASE / "review.json", result)
    status = {"pid": os.getpid(), "at": utc(now_ms()), "experiment": SCHEMA,
              "labFingerprint": identity["labFingerprint"], "producerModelFingerprint": identity["producerModelFingerprint"],
              "usedForOrders": False, "orderAuthority": "none", "forwardStage": "exploration",
              "holdoutValidated": False, "promotionAuthorized": False, "states": states}
    write(BASE / "status.json", status)
    lines = ["# Kronos 期限前向研究", "", f"資料時間：{status['at']}。階段：exploration；尚無保留樣本驗證。",
             "", "使用相同凍結權重與四樣本平均路徑，比較第 3／6／12 根；原成本與買賣報價完整保留。",
             "", "這是單一十二根路徑的前綴，與 v11 原三根推論分開。没有下單權限、不更動 v11、不把收盤誤差算成成交損益。",
             "", "每小時共同起點且商品完整配對才算一個窗口；至少三十個窗口只是比較門檻，不會自動選勝者。",
             "", "| 模式 | 狀態 | 配對小時窗口 | 已存預測 | 過期／停止預測 | 缺少商品输出 |", "|---|---|---:|---:|---:|---:|"]
    for mode, value in result.get("modes", {}).items():
        lines.append(f"| {mode} | {value['status']} | {value['independentMatchedWindows']} | {value['predictions']} | {value['lateOrStoppedPredictions']} | {value['missingPairOutputs']} |")
    if result.get("status") == "unavailable":
        lines.extend(["", "評分暫不可用：" + result["reason"]])
    lines.extend(["", "完整配對誤差、原成本覆蓋診斷及延遲見 review.json；逐次来源與結果在 inputs、predictions、settlements、label-inputs。",
                  "", "後續若用這份探索選參數，須另開固定版本的全新前向驗證。不能把探索資料重用為保留樣本。", ""])
    report = BASE / "report.md"
    temporary = report.with_name(report.name + f".{os.getpid()}.tmp")
    temporary.write_text("\n".join(lines), encoding="utf-8")
    temporary.replace(report)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "once", "watch"])
    args = parser.parse_args()
    BASE.mkdir(parents=True, exist_ok=True)
    import msvcrt
    with (BASE / "worker.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            if stopped():
                print(json.dumps({"status": "stopped", "at": utc(now_ms()), "usedForOrders": False}))
                return
            predictor, identity = load_frozen()
            if args.command == "check":
                print(json.dumps({"status": "loaded", "labFingerprint": identity["labFingerprint"],
                                  "producerModelFingerprint": identity["producerModelFingerprint"],
                                  "loadSeconds": identity["loadSeconds"], "usedForOrders": False}))
                return
            while not stopped():
                print(json.dumps(run_once(predictor, identity)), flush=True)
                if args.command == "once":
                    break
                time.sleep(2)
            write(BASE / "status.json", {"pid": os.getpid(), "at": utc(now_ms()), "status": "stopped",
                                          "labFingerprint": identity["labFingerprint"], "usedForOrders": False}) if stopped() else None
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "at": utc(now_ms()), "reason": safe_error(error)}), file=sys.stderr)
        raise SystemExit(1)
