# Trading modes and operations

## Ownership
Node owns research, Codex proposals, deterministic limits and submission journals.
Freqtrade is the only order/position ledger and owns stoploss/ROI exits.
OpenAlice, UTA, Docker and system startup services are outside this project.

Default dry-run uses local/ and loopback18080. Explicit --mode demo uses local/demo/
and loopback18082. Explicit --mode demo-futures uses local/demo-futures/ and loopback18084.
Each has a distinct bot/strategy, credentials, SQLite database and journals.
There is no real-money mode. Separate API keys on one exchange account do not isolate funds.

## Spot Demo adapter
scripts/demo-engine.py is a process-local subclass installed into the Freqtrade resolver;
installed packages are unchanged. Freqtrade 2026.8 deliberately disables Binance Demo
in its normal adapter. This project enables it only in this dedicated runner.

The launcher validates mode, strategy, bot, spot market, per-trade size, max positions,
stoploss, position adjustment, pair whitelist and loopback port. The adapter replaces
exchange configuration with fixed spot/demo options and disables currency SAPI,
delisting, futures and WebSocket paths. Both CCXT sync/async fetch methods and actual
requests/aiohttp transports reject destinations outside HTTPS demo-api.binance.com/api/.
Redirects are disabled. This remains a project-specific adapter, not upstream acceptance.

The Demo strategy requires the guarded exchange marker. The bridge independently checks
show_config: dry_run=false, runmode=live, demo_trading=true, matching bot/strategy and limits.
Freqtrade's runmode=live means exchange-side orders; here the destination guard restricts
them to the virtual Demo environment. Merely setting dry_run=false is rejected.

Demo key/secret are entered locally by scripts/configure-demo.ps1 and stored under local/demo/
using Windows-user DPAPI. Only the Python runner/read-only account checker decrypt them.
No secret goes into CLI arguments, tracked configuration or research prompts.
Dependency request errors and logger records are redacted. This is not an OS security
boundary against an arbitrary process running as the same Windows user.
Use a dedicated Demo account/environment; do not share its trading management with other bots.

## Research and execution
Research snapshots explicitly identify mode. Demo quotes/candles come from Demo endpoints.
The quote retrieval time is captured when that response arrives, not after slower candles.
After Codex returns, the bridge refreshes the buy quote and account state. It validates
snapshot/quote age, source/mode, spread, price drift, whitelist, stake/exposure/position
limits, available balance and daily realized plus unrealized loss.
After the final engine identity GET, submit checks the quote/snapshot deadline again.
An expired pre-send deadline is recorded rejected, not unknown.

Codex runs with isolated research cwd, read-only sandbox, disabled shell tools and a
sanitized environment. It receives evidence and position summaries, never broker credentials.
Spot proposes hold/buy/sell. On the current Binance Spot Demo route, a bearish spot hypothesis is
review-only and must return HOLD with `SPOT_SHORT_REQUIRES_MARGIN`; a spot `sell` closes an existing
long and is not a naked short. Actual spot shorting would require a separately verified Margin
execution boundary, which is not exposed by this project's Demo Spot `/api/` transport. Demo futures proposes hold/open-long/open-short/close-long/close-short,
with an integer leverage field (1–3). Closing never opens the opposite side.
No autonomous strategy-code changes are accepted.

The strategy callback compares the incoming amount against Freqtrade's native float
stake/rate representation, avoiding false over-limit rejection from reconstructing a
decimal notional from binary floats. The bridge still caps the requested USDT stake exactly;
the callback rejects amounts above the configured native amount boundary.

## Persistence and uncertainty
Exclusive execution.lock serializes submissions; pending is appended and fsynced BEFORE POST.
Unknown responses and pending crashes freeze new bridge submissions. Never blindly retry.
A successful POST is submitted, not filled. Freqtrade remains the authority on fills and exits.
No journal record is dropped for a partial/torn write.

reconcile checks CLOSED history AND current open positions: Freqtrade /trades contains only
closed trades. It checks pagination totals, unique IDs and the total again after current
status. A changing/incomplete history fails rather than declaring an absent order failed.
A matching unique tag with expected stake can prove an entry; a matching closed position or
open exit order can prove an exit. Partials/canceled/differently sized fills may remain
unresolved and need operator investigation. Recovering a lock never resolves an order.

A normal cycle persists snapshot, proposal and an outcome (completed/failed/aborted).
Reasons use stable error codes; no raw subprocess diagnostics are persisted.
Direct execute may reference externally saved proposals: retain those inputs for audit.

## Health and lifecycle
engine.lock records the launcher PID and Python child PID. cycle/watch/execution locks
remain independent. Ctrl+C cancels ongoing Codex work for cycle/watch; once a POST is sent
it cannot be undone. STOP pauses entries, never liquidates or disables Freqtrade exits.

health.json records stages, failures and success time. watch writes heartbeat every15s;
health flags it stale after45s or if the PID does not match. Three consecutive failed cycles
write STOP and stop the watch loop; a successful cycle resets the counter.
resume requires a matching running engine and no unresolved submissions. It starts no job.
A healthy engine alone does not prove trading performance or current exchange availability.

recover-lock validates a fixed lock name, dead owner/child, unchanged record and Windows
inventory showing no other project processes. Permission uncertainty or PID reuse blocks
recovery. It is conservative and never steals locks based on elapsed time.
No automatic engine restart, time-based order retry or boot service is installed.
events.jsonl rotates at roughly2MB to one retained previous segment. Orders, snapshots,
reports and databases are retained; inspect disk capacity for long-term operation.

## Reporting
Reports join proposal snapshot hashes to entry tags and sell trade IDs. They include
actual order statuses/fills, final exit reason, Freqtrade net realized PnL, fees by currency
and missing-fee disclosure. Never sum unlike fee currencies or subtract fees twice.
Closed-trade cumulative-PnL drawdown is explicitly different from full account equity drawdown.
Open positions have current PnL separately; history/account reads are not one database transaction.
If the engine cannot supply complete data, an older cache can render a clearly stale report.
Do not use it for a new trading decision or to assert positions are flat.

## Research coverage
config/research.json declares explicit per-pair chain token mappings and public wallets.
Tokens require chainId, contractAddress, token/wrapped-proxy relationship, source and note.
Default BTC/ETH has no assumed on-chain mappings. Search candidates are unverified context.
Native spot evidence remains required; wrapped tickers never prove exchange identity.
Optional mapped meta/dynamic/audit queries and watchlisted wallet first-page results are bounded,
source-attributed and report unavailable/partial data. Queries use at most3 concurrent requests.
Technical summaries validate closed contiguous15m OHLCV and report SMA, ATR, returns and volume.
They are descriptive features, not a validated strategy.

## Acceptance
- Offline Node tests: guards, replay, deadline, health, recovery, report arithmetic and research mapping.
- Python tests: installed Freqtrade callbacks, actual CCXT routing, transport redirect rejection.
- DPAPI test: synthetic credentials only, proves encrypt/decrypt with no plaintext at rest.
- Demo public smoke: real sync orderbook and async candles, no credentials or order writes.
- Native smoke: isolated dry-run buy/sell, zero managed trades, HOLD workflow and report joining.
- Credentialed Demo: first run demo-check; then explicitly test:demo-account with running Demo engine,
  empty managed positions and zero exchange open orders. It checks before/after balances and leaves
  the engine running if a submission fails. BTC residual greater than0.00001 requires review.
  It never liquidates existing account balances to force acceptance.

Without local Demo keys, signed account endpoints, exchange-side fills/fees, partial-fill recovery
and uninterrupted long-term operation remain unverified. Local smokes do not demonstrate profit.

## Primary sources
- https://github.com/freqtrade/freqtrade/tree/2026.8
- https://github.com/binance/binance-spot-api-docs/blob/master/demo-mode/general-info.md
- https://github.com/binance/binance-skills-hub

## Local Research Desk

`npm run ui` starts a read-only HTTP server on 127.0.0.1:18100. It must run on the same machine as this project's Freqtrade engine; it does not configure remote access. Host/Origin and cross-site checks protect the local surface, static files use an explicit allowlist, and non-GET methods are rejected. No exchange credentials are decrypted by the dashboard.

`/api/dashboard?mode=dry-run|demo|demo-futures` uses FreqtradeClient's identity-checked snapshot/history reads and returns only selected account, position and closed-trade fields, a realized-PnL summary, recent local proposals, safe health status and configuration-file presence. Raw Freqtrade configuration, auth and order objects never reach the UI. Closed history is limited to the newest 50 rows in the presentation; the summary covers the complete verified history read. A history failure preserves the current account with historyError and unavailable history, rather than claiming no trades. No persisted trade cache is used as a current account fallback.

`/api/market` accepts only policy pairs and the three supported modes. Public data is independent of engine availability. Five-second account and fifteen-second market caching coalesce concurrent reads; the frontend polls every thirty seconds and cancels superseded requests.

The connection dialog detects setup and Demo credential-file presence, shows mode-specific local commands, and checks the running engine. Credential-file presence is not credential validity; a matching engine must still connect. UI connection checks never start an engine, run a cycle or place an order. The operator enters Demo keys only through configure-demo.ps1. The UI makes no real-money mode available.

Preview data is frontend-only and explicitly labelled. Price landscape lines are overlapping 21-candle close windows; they are not probability-density estimates. The multidimensional chart normalizes each OHLC/volume column independently. The four-node workflow depicts actual subsystem responsibilities, not a live multi-agent activity feed.

## Analyst style and audit

`config/analyst.json` selects `active` (default) or `conservative` on the next analysis. Prompt v14 reviews the full style text in `prompts/analyst-active.md` and `prompts/analyst-conservative.md` for spot, or their `analyst-futures-*` counterparts for perpetuals. The host contract in `src/analyst.mjs` adds the allowed mode, capability-driven direction matrix, fixed stake, risk limits, selected account fields and explicitly delimited untrusted market snapshot. It also separates entry-only cost requirements from evidence needed to review a justified native exit. The native Codex process remains research-only and returns the existing proposal schema.

Active may propose an entry with a clear price structure and at least one supporting volume or momentum observation, despite secondary disagreement. Conservative asks for stronger agreement. Neither style imposes a trade quota, guarantees performance, changes deterministic bridge checks or permits real-money trading. Missing/invalid required evidence still blocks a trade; optional unavailable Web3 context is not automatically a blocker or positive evidence.

Each analysis records its style, prompt version, snapshot identity, full prompt hash and style-file hash in the research run's `analysis.json`; a cycle also saves `<snapshotId>.analysis.json` beside its snapshot/proposal in the selected mode's runs directory. This is provenance, not an automatic A/B performance report. Invalidation levels written in `reason` are descriptive and do not create execution orders.

Real-money deployment would require a separately reviewed execution boundary, account/credential isolation, reconciliation and recovery acceptance, and explicit operator authorization. Before considering it, evaluate this fixed prompt version on unseen historical/replayed data and forward Demo runs including fees, slippage, drawdown and failed submissions. A more active prompt alone does not establish a profitable strategy. Live mode remains rejected.

## USDT perpetual Demo contract

The `demo-futures` lane uses `scripts/demo-futures-engine.py` and `CodexDemoFutures`. It is separate from the spot adapter and only permits HTTPS `demo-fapi.binance.com/fapi/` in both CCXT and actual requests/aiohttp transports; redirects are disabled. COIN-M, production FAPI, spot, SAPI and WebSocket paths are rejected. Installed Freqtrade/CCXT packages are unchanged. Futures credentials are entered using `configure-demo.ps1 -Mode demo-futures` and encrypted under the distinct mode directory.

Only BTC/USDT:USDT, ETH/USDT:USDT, SOL/USDT:USDT and BNB/USDT:USDT are configured. The host verifies PERPETUAL/TRADING, USDT quote/margin assets and full symbol identity, collects contract candles, mark price and funding rate, and emits `futures:<pair>` evidence. Spot evidence does not authorize a futures entry. Before entry the bridge refreshes the contract quote and filters; short price drift uses bid, long uses ask. Quantity/min-notional checks use the rounded-down amount and both lot-size filters. Exchange constraints remain authoritative.

`stakeUsdt` is collateral margin, not leveraged position value. Margin stays capped at 50 per entry/50 total USDT, leverage is an integer 1–3, and notional stays capped at 150 per entry/150 total. Existing position notional uses the greater of entry margin times leverage and amount times current price. Two open positions, four UTC-day entry attempts (both directions combined), -20 USDT realized-plus-unrealized entry stop, fresh-quote, spread, drift and unresolved-journal guards still apply. One-way isolated positions only: no simultaneous long/short hedge, automatic reversal or averaging down.

The adapter independently checks entry notional/margin and leverage before native order creation; the strategy permits tagged bridge entries in either direction and produces no autonomous entry signals. `close-long` and `close-short` must match the current side and use Freqtrade forceexit by trade ID. Freqtrade handles reduction-only futures exits. Entry stops and daily-loss stops do not block a matching close. An ambiguous short entry remains frozen until a unique tag, pair, margin and leverage/direction are proven; open short exits reconcile against buy-side exit orders.

Stoploss and ROI remain Freqtrade PnL ratios: -2% at 3x is approximately a 0.67% adverse price move before fees/slippage, not a 2% price stop. These are engine-managed exits, with stoploss_on_exchange disabled. The process must remain running; no guaranteed execution price, exchange-side protective stop, or continuity through an outage is claimed. Funding and net PnL remain owned by Freqtrade rather than recomputed from the model's narrative.

Acceptance here: offline Node and Python contract tests, actual sync CCXT orderbooks for all four Demo perpetuals and async candles, actual CLI configuration/runner selection, and read-only dashboard interaction. No stored exchange credentials read, no scheduler, no contract account orders. Destination acceptance must verify a dedicated account's one-way/single-asset settings, existing positions/orders, signed balance, leverage/margin application, long and short fills, reduction-only closes and recovery; do not call exchange-side execution verified until that happens.

Sources: [Binance USD-M API test environment](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [Freqtrade leverage semantics](https://www.freqtrade.io/en/stable/leverage/), and the installed Freqtrade 2026.8 source inspected for forceenter/forceexit and adapter contracts.
