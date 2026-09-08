# Trading modes and operations

## Ownership
Node owns research, Codex proposals, deterministic limits and submission journals.
Freqtrade is the only order/position ledger and owns stoploss/ROI exits.
OpenAlice, UTA, Docker and system startup services are outside this project.

Default dry-run uses local/ and loopback18080. Explicit --mode demo uses local/demo/
and loopback18082, a distinct bot/strategy, credentials, SQLite database and journals.
There is no real-money mode. Separate API keys on one exchange account do not isolate funds.

## Demo adapter
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
It proposes one hold/buy/sell. No autonomous strategy-code changes are accepted.

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
