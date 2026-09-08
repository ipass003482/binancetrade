# Trading dashboard — modern Research Desk

## Scope and reference

Owner contract: [operations](../docs/operations.md#local-research-desk). Read-only UI for the independent Binance/Codex/Freqtrade project. No automatic engine startup, orders, scheduler or browser credential entry.

The maintainer rejected earlier generic dark and BLACKBOX prototypes, then supplied https://x.com/qkl2058/status/2096983438314397773 and explicitly clarified the request is to **modernize that quantitative interface**, not reproduce its layout unchanged. The earlier warm smart-home image is superseded. Correct reference thumbnail was viewed: white research desk, ridges, handoff diagram, multidimensional graph and role tiles.

Chosen modernization: bright layered surfaces, clearer typography and spacing, a compact account strip, market/decision hierarchy, a price landscape, simplified workflow diagram, and meaningful multidimensional data. Native dialogs reveal transactions, positions, decisions, risk and connection steps. Four real subsystem roles replace unsupported ten-agent claims. This revision is implemented for review, not recorded as maintainer-accepted.

Graphs use actual available candle data and disclose semantics. Price landscape = twelve overlapping 21-candle close windows; multidimensional view = eight OHLC/volume rows normalized independently. Workflow topology is fixed, with data-availability status labelled separately. Demo fixtures never appear as real account data.

User said exchange setup is incomplete: complete UI and connection flow first. Connection instructions therefore detect configuration/key-file presence and matching engine reads; they do not start or trade on an account. No native order smoke is required for this iteration, consistent with the prior request to reduce trading tests on this PC.

## Progress and verification
- [x] Modernized reference style and implemented responsive desktop/mobile layout.
- [x] Domain store cancellation, partial-load errors and native-fetch receiver fix.
- [x] Sanitized current account/positions, complete-history summary, latest 50 closed trades and proposal data.
- [x] Connection dialog with mode-specific setup, local encrypted-key entry, engine startup and read-only verification.
- [x] Actual browser request verified API/setup state: Demo workspace exists, encrypted key file missing, engine not connected. No actual engine or order was started.
- [x] Browser verified preview, Demo selection and command changes, real read-only connection attempt, transaction dialog, and 390px layout without page overflow.
- [x] npm test: 63/63 passed, including sanitized data mapping, history failure semantics, identity failure propagation, cross-site/static allowlist guards and fetch receiver regression.
- [x] npm run check: 36 modules, policy valid; git diff --check passed.
- [ ] Maintainer reviews the modernized visual result.

## Remaining acceptance boundaries

Demo key setup and a running configured Freqtrade are still required before an actual exchange account can be shown; this has not been claimed connected. Existing native trading acceptance remains a separate lane on the intended computer. The browser's screenshot-capture command repeatedly timed out; layout dimensions and rendered/interactive browser state were inspected, but pixel-level screenshot inspection is unverified.
