# Demo, operations, reports and research upgrade

Scope: user's explicit items1–4; independent Windows-native project, no Docker.
Supersedes the completed first-dry-run plan. Owner contract: docs/operations.md.
User later directed additional testing to another computer; stop further local test runs.

## Design decision
Keep Freqtrade as the only order/position/exits ledger. Use a process-local Demo
adapter with CCXT and actual transport destination guards; installed packages unchanged.
A separate custom broker ledger was rejected because it duplicates lifecycle ownership.
Demo has local/demo/, loopback18082 and separate authentication/state. Dry-run stays default.
No visual UI or continuous system service is in scope.

## Implementation
- [x] Explicit Demo mode, encrypted local credential entry, guarded spot engine, matching bridge/quotes.
- [x] Health stages/heartbeat, persistent three-failure pause, conservative PID/child/lock recovery.
- [x] Decision/proposal/outcome persistence; Markdown/JSON trades, net PnL, fees and stale-data reports.
- [x] Per-pair closed-candle technical summaries, labelled search context and explicit token/wallet mappings.
- [x] Documentation and GitHub source handoff preparation.
- [ ] Credentialed Demo account/virtual buy-sell acceptance on the destination computer.

## Completed local evidence (2026-09-08)
- Last completed Node test run:54 passed (additional history regression was added afterward).
- Last completed Python test run:23 passed.
- Syntax/policy check passed before subsequent small lifecycle/configuration refinements.
- Actual Freqtrade/CCXT sync Demo orderbook and async32 candles passed with no credentials/orders.
- Demo Node research snapshot and all four public Web3 queries passed.
- Windows DPAPI roundtrip passed using synthetic credentials only.
- Native dry-run buy/sell, zero open trades, HOLD workflow and report joining passed.
  Artifact:local/native-smoke/31aaa011-8064-48ec-9596-70172c0462c1/result.json.
- Actual Codex CLI full upgraded workflow produced HOLD; no order submitted.
  Artifact:local/codex-smoke/result.json.
- Real default engine lifecycle/health and report commands verified; flat before stopping.
- All owned trading test processes stopped. No scheduler or Demo credentials configured.

## Findings corrected during implementation
- Native stake/rate float reconstruction could falsely reject an exact25 USDT entry.
  Callback now compares the native amount boundary; above-limit regression remains rejected.
- Freqtrade /trades returns only CLOSED trades. History/reconcile now includes current status,
  checks total changes and duplicate IDs.
- Windows cannot always atomically replace an open lock file. Engine ownership updates use
  the held descriptor; real launcher/health verified the parent and child ownership afterward.
- Windows PowerShell module autoload under npm required explicitly selecting the built-in
  Security module for DPAPI.
- Demo setup builds a fixed fresh configuration, not a copy of arbitrary dry-run settings.

## Destination acceptance
Follow START-HERE.md. Install dependencies locally, enter ONLY Demo credentials on that
computer, run read-only demo-check, start the guarded Demo engine, then a cycle/report.
Explicit test:demo-account is available for a bounded virtual buy/sell, preserving limits.
No credentialed Demo test has been claimed passed. Long-term uptime, exchange-side partial
fill recovery and strategy performance are still unverified.
No further local stress/full-suite runs after the user's handoff instruction.

## GitHub delivery
User requested GitHub upload instead of ZIP handoff. User-selected public repository:
https://github.com/ipass003482/binancetrade . Runtime state, credentials, caches,
installed dependencies and downloaded upstream skills remain excluded.
