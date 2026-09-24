# Offline model comparison

This research process cannot place orders, read credentials, restart workers or
change an entry gate. It imports no trading modules. All output is confined to
`local/model-comparison/`; the existing trading and model environments are not
modified. The existing model Python environment already contains NumPy, SciPy
and LightGBM. All native scientific thread pools and LightGBM use one thread.

## Run and replay

From the project root in PowerShell:

```powershell
& '.\.venv-model\Scripts\python.exe' 'scripts\model-comparison.py' --start '2026-09-16T00:00:00Z' --as-of '2026-09-20T15:37:00Z'
# Use the dataset path returned by that command to replay exactly the same data:
& '.\.venv-model\Scripts\python.exe' 'scripts\model-comparison.py' --dataset '<absolute path under local/model-comparison/.../dataset.json>'
& '.\.venv-model\Scripts\python.exe' -m unittest discover -s test -p test_model_comparison.py
```

The cutoff is mandatory; it does not silently move each time the script runs.
An input artifact records source-file SHA256 values, row and configuration
fingerprints, opportunity coverage, excluded/unknown evidence and the exact
chronological split. Replaying does not refetch data or retrain a trading worker.
The source-code fingerprint in the report identifies implementation changes.
The result directory includes the complete dataset, source-code and dependency
fingerprints in its identity. Changed code/data/dependencies create a new
directory, preserving earlier research results; repeating the identical version
may refresh its timing metadata. Old trading/model artifacts are never edited.
`latest.json` only points to the latest research report. Nothing consumes it as
order authority.

## Evidence and costs

The extractor verifies the stored prospective Kronos prediction, exact input
hash, source snapshot hash, model fingerprint and later settlement identity.
The original candle settlement only proves that the prospective forecast was
subsequently observed; it is not used as a fictitious fill price.

Entry is the first valid quote **received after prediction issuance**, available
within 90 seconds. Its snapshot must have completed; quote retrieval age at that
time must be at most 15 seconds. Exit is the first fresh quote available at or
after entry plus 15 minutes, no more than 30 seconds late. Quotes received before
the target cannot stand in for observations after it. A missing or late quote
is unknown, not a zero return. REST receipt timestamps do not prove exchange
event freshness or executable capacity.

The target is exactly 15 minutes from the research entry, within the explicit
late tolerance. Kronos's original candle target is 15 minutes from its candle
boundary, so it precedes this label target by collection and entry delay. This
known horizon mismatch is reported; no historical forecasts are regenerated.

Long gross quote return is `(exit bid / entry ask - 1) * 10000`. Short return is
`(entry bid - exit ask) / entry bid * 10000`, for a fixed unit position. Spread
is already included. Only known entry-time fee-rate totals, twice per-side
slippage and the recorded funding reserve are subtracted. Fee decomposition,
provenance and freshness must be valid; missing fees remain unknown. Entry-time
fees held constant at exit, estimated slippage and absolute funding reserve are
scenarios, **not actual commissions, funding, fills or realized profit**.
No bid/ask spread is subtracted again. A +5 bps per-side stress is reported.

## Candidates and split

The pinned Kronos model is held fixed. Duplicate forecasts for one mode and
candle window use the first issuance, selected before reading outcomes. Every
candidate is scored on the same eligible pair/windows. Missing model outputs
and unusable quotes are explicitly counted, not silently turned into profit.
This is a **conditional matched-forecast comparison**. The without-Kronos arms
remove its features but still condition on the presence of its validated
prospective artifacts. They cannot establish the operational gain from removing
the Kronos dependency. Coverage separately reports all observed first-minute
source pair/windows, missing pinned forecasts, unavailable matching evidence,
and final eligible quote labels. A source snapshot with no prediction remains
in that denominator; no missing result becomes a zero return. Detailed exclusion
counters are file/window counts for prediction errors and market-row counts for
quote errors, not a single mixed-unit failure rate.

Chronological windows are split 60% training, 20% calibration, 20% test. All
symbols and both modes in the same original five-minute window share a split.
Training and calibration rows whose 15-minute label crosses the next partition
start are purged. Nothing is shuffled. Feature scaling, class payoff estimates
and coefficients fit training only; sigmoid probability calibration fits only
the later calibration partition. No test thresholds or hyperparameters are
tuned. Thirty/fifteen/fifteen windows are computational floors, not statistical
proof. At least 30 calendar days would be required before considering promotion,
alongside an independent forward trial and actual trade evidence.

Candidates: hold; frozen Kronos directional/cost screen; logistic regression
without/with Kronos; LightGBM without/with Kronos.
Kronos-frozen freezes forecasts and weights, not the entire production strategy:
its close forecast is scored against the entry quote and shared cost scenario,
then evaluated with this research 15-minute exit. No ATR/trailing/flow exit,
exchange fill or native guard behavior is simulated by that comparison arm.
The anticipated exit spread is not known in advance; actual observed exit bid/
ask pays it in the outcome, so forecast edge is not a guaranteed execution edge.
LightGBM has 60 rounds, seven
leaves and depth three; no hyperparameter sweep. Common features are completed
candle returns/volatility/volume, direction, fresh entry spread, non-spread cost,
sampled depth imbalance with missing flag, and time of day. Returns and depth
imbalance are multiplied by trade direction for the linear baseline as well as
the tree models; it does not have to infer nonlinear side interactions. Kronos variants add
forecast edge, all-three-closes direction and prediction age. Existing records
contain only the average of four sampled paths, so **no fabricated forecast
dispersion or calibrated Kronos confidence feature** is supplied.

The classifier target is positive net cost-scenario return. A fixed probability
floor of 0.6 plus positive expected scenario return using training-only average
win/loss determines signals. Net labels already include costs; they are not
subtracted again. Futures selects at most one direction per pair/window. Each
candidate forbids overlapping signals in the same pair. Across pairs there is
no portfolio capital or market-impact simulation, so results are signal-level
quote diagnostics, never portfolio returns. Hold contributes zero per eligible
opportunity. Brier/log loss use all eligible directional test rows.

Hourly blocks retain within-block dependence for descriptive bootstrap
intervals; fewer than ten blocks gives no interval. These are not significance
certificates or multiplicity-adjusted champion selection. The report always
keeps `promotionAuthorized=false` and `status=inconclusive`: retrospective
training on prospectively recorded evidence is not a new forward champion trial.

Chronos-2 is explicitly `not_evaluated`: the package and weights are absent.
No dependency installation, weight download, invented benchmark or automatic
replacement happens. Its future comparison must reuse the frozen opportunity
set and cost contract, first with common OHLCVA inputs, before additional
features are assessed separately.

References: [LightGBM parameters](https://lightgbm.readthedocs.io/en/latest/Parameters.html),
[Chronos-2 official model card](https://huggingface.co/amazon/chronos-2),
[Kronos official implementation](https://github.com/shiyu-coder/Kronos).
