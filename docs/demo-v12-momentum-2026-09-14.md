# v12 observed-price confirmation — 2026-09-14

The user requested an immediate effort to improve win rate in actual Binance Demo trading. This revision introduces one prospective entry hypothesis, `closed-price-momentum-v1`, under the existing `kronos-direction-v12` trial. It does not claim that a higher future win rate has been established.

## Evidence and rationale

The immutable review at 2026-09-14 13:55:12.202 UTC contains 14 closed v12 trades: 4 wins and 10 losses. Eight of the ten losses entered when the latest observed 5-minute close change was flat or opposed the order direction. Two of the four wins also had opposed 5-minute changes. The combined 5m/15m confirmation would classify only 3 of these historical entries as eligible: 2 wins and 1 loss. This was an exploratory inspection of the same small sample used to formulate the hypothesis; it is NOT independent validation, a simulated portfolio, an estimated future win rate, or recovered profit. New entry timing, positions and subsequent choices would differ.

The exact review, entry plans and snapshots are copied with hashes under `local/v12-momentum-2026-09-14/audit-inputs/`; `entry-audit.json` records the last four completed closes for every inspected trade. We did not search a numerical threshold grid. The 15-minute observed comparison matches the unchanged three-5m-bar model horizon; the 5-minute comparison asks whether the latest completed move still agrees.

## Executed contract

All existing model pin, same-cycle evidence, quality review, three-forecast direction, favorable executable quote, original full costs plus 30 bps, ATR exits and risk checks remain required.

Additional entry confirmation: use the four latest contiguous, completed 5-minute candle closes. For long, the final close must be strictly above both the previous close and the close three bars earlier. For short, it must be strictly below both. Flat, missing, invalid, future or conflicting data rejects entry. No forming candle is used. The intermediate close is preserved as evidence but is not required to be monotonic.

The host re-evaluates this condition in selection and immediately before creating an order plan. The plan records `entryPolicyVersion` and `entryConfirmation.priceConfirmation`. Native guard `kronos-native-entry-v3` requires the same policy, exact timestamps, positive closes, matching model origin and directional comparisons at callback, order context and wire validation. Native readiness must attest guard v3 before new entries are authorized. This prevents an old loaded engine from accepting the new host contract.

The fixed Kronos model fingerprint remains `0bc0a246933d625d8c7724347a0dcc8cf8619d3646f46565558607b6a0cf96d1`. The quality gate still applies; a HOLD does not stop model inference. Five-minute cadence and unlimited daily entry count remain. This extra confirmation can reduce entry frequency.

## Forward evaluation and operation

The original 30-per-mode goal, baseline, shared capital and all losses remain unchanged. Historical entries are reported under `direction-only-v12`; new entries are attributed through the immutable pending journal to `closed-price-momentum-v1`. Review output separates `entryPolicyCohorts`, alongside risk cohorts. Only confirmed actual Demo fills count. Prior open trades retain their entry-time exit plans unchanged.

Assess new actual closed trades by win rate together with fee-adjusted net PnL, average win/loss and drawdown. A higher win rate with lower net profit is not a success. No historical rows are relabeled as new-policy trades. No promotion to real money is authorized.

Deployment records and source hashes: `local/v12-momentum-2026-09-14/running.json`. Test logs, source backup and new-cycle verification are in the same directory. They establish software behavior and activation, not profitable performance.

Research method references: [Freqtrade strategy testing](https://www.freqtrade.io/en/stable/strategy-101/) and [lookahead analysis](https://docs.freqtrade.io/en/latest/lookahead-analysis/) support separating forward results from biased historical evaluation. [Kronos paper](https://arxiv.org/abs/2508.02739) describes the forecasting model; its forecasting benchmark does not establish this bot's fee-adjusted profitability.
