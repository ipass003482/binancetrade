"""Run offline-only comparison; all generated files stay local/model-comparison."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

# Set before importing scientific libraries. Never alter trading process envs.
for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[key] = "1"
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from model_comparison import build_dataset, canonical, compare, dependency_versions, sha, stamp, validate_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2026-09-16T00:00:00Z")
    parser.add_argument("--as-of", help="Required frozen UTC cutoff when extracting")
    parser.add_argument("--dataset", help="Replay a previously frozen dataset inside local/model-comparison")
    parser.add_argument("--config", default="config/model-comparison.json")
    args = parser.parse_args()
    source_fingerprint = sha(canonical({str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in [ROOT / "src/model_comparison.py", Path(__file__)]}))
    versions = dependency_versions()
    base = ROOT / "local/model-comparison"
    base.mkdir(parents=True, exist_ok=True)
    if args.dataset:
        path = Path(args.dataset).resolve()
        if not path.is_relative_to(base.resolve()):
            parser.error("dataset must be under local/model-comparison")
        dataset = json.loads(path.read_text(encoding="utf-8"))
    else:
        if not args.as_of:
            parser.error("--as-of is required; no moving final-test cutoff")
        config = validate_config(json.loads((ROOT / args.config).read_text(encoding="utf-8")))
        dataset = build_dataset(ROOT, config, stamp(args.start), stamp(args.as_of), progress=lambda x: print(x, flush=True))
    # Changing code, dependencies, coverage rules or data creates a new report.
    # Earlier research results are never replaced by a later implementation.
    identifier = sha(canonical({"dataset": sha(canonical(dataset)), "implementation": source_fingerprint, "dependencies": versions}))[:16]
    output = base / identifier
    output.mkdir(exist_ok=True)
    dataset_path = output / "dataset.json"
    if not dataset_path.exists():
        dataset_path.write_text(json.dumps(dataset, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    report = compare(dataset)
    report["datasetSha256"] = sha(dataset_path.read_bytes())
    report["sourceCodeFingerprint"] = source_fingerprint
    report_path = output / "report.json"
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    lines = ["# Offline AI model comparison", "", f"Data cutoff: {dataset['asOf']}",
             "", "**INCONCLUSIVE. Research quote scenarios only; no actual fills, PnL or promotion authority.**", "",
             "The fixed 15-minute label starts at a fresh quote received after prediction issuance. Bid/ask already includes spread; only known fee-rate, slippage and funding-reserve scenarios are subtracted.", "",
             "| Mode / candidate | Test pair-windows | Selected signals | Mean selected net scenario bps | Mean per opportunity bps | Brier |", "|---|---:|---:|---:|---:|---:|"]
    split_lines = []
    for mode, result in report["modes"].items():
        for name, metrics in result["candidates"].items():
            def show(key):
                value = metrics.get(key)
                return "unknown" if value is None else str(round(value, 6)) if isinstance(value, float) else str(value)
            lines.append("| " + mode + " / " + name + " | " + " | ".join(show(k) for k in ["eligiblePairWindows", "selectedNonoverlappingSignals", "meanSelectedNetScenarioBps", "meanNetScenarioBpsPerOpportunity", "brier"]) + " |")
        split_lines.extend(["", f"{mode} split counts: `{json.dumps(result['splitCounts'])}`. {result.get('reason', '')}", ""])
    lines.extend(split_lines)
    lines.extend(["", "**Conditional matched-forecast study:** without-Kronos feature arms still require matched Kronos evidence. They do not measure the operational benefit of eliminating model failures.", "",
                  "| Mode | Source pair-windows | Missing pinned forecast | Forecast evidence gaps | Eligible quote pair-windows |",
                  "|---|---:|---:|---:|---:|"])
    for mode, coverage in report["sourceOpportunityCoverage"].items():
        lines.append("| " + mode + " | " + " | ".join(str(coverage[key]) for key in ["sourcePairWindows", "missingPinnedForecastPairWindows", "forecastWithUnavailableMatchingEvidence", "eligiblePairWindows"]) + " |")
    lines.extend(["", "No candidate has been enabled for orders. Chronos-2 was not evaluated; its runtime/weights are absent.", "",
                  "Missing fee or on-time quote evidence is excluded for every candidate and counted explicitly in report.json. These are retrospective exploratory fits on prospectively recorded inputs; the test segment is held out from training, but is not a new prospective champion trial.", "",
                  f"Rows fingerprint: `{dataset['rowsFingerprint']}`", f"Sources fingerprint: `{dataset['sourceFingerprint']}`", "",
                  "Full provenance, splits, unknown reasons, cost basis and descriptive time-block intervals are in report.json and dataset.json."])
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (base / "latest.json").write_text(json.dumps({"researchOnly": True, "usedForOrders": False, "report": str(report_path), "dataset": str(dataset_path), "identifier": identifier}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "dataset": str(dataset_path), "rows": len(dataset["rows"]), "status": report["status"]}))


if __name__ == "__main__":
    main()
