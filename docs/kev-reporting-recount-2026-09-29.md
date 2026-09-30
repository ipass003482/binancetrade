# Fresh Demo accounting cohort, 2026-09-29

The user asked to clear the current count and recalculate. A new 30-day
reporting goal began at `2026-09-29T07:39:22.441Z` and ends at
`2026-10-29T07:39:22.441Z` (Asia/Taipei 15:39:22). It retains the established
target of 100 Spot plus 100 Futures. The verified starting count is zero in
both modes, with complete fill, approval, journal and PnL evidence.

The reset excludes all pre-start exchange trade IDs: Spot 1–538 and Futures
1–131. It does not delete or rewrite exchange records, journals, approvals,
fills, losses, or the execution session. They remain available for a separate
all-history reconciliation. The previous 200-entry reporting goal is retained
in full. No positions were open and no orders were pending or unknown during
the reset. No order was submitted.

Kev remains active at `gpt-6-luna`. The Jev installation remains ready for a
local API key and later explicit user switch. The new goal carries the same
reviewer allowlist, effective from the new start time, so an explicit switch
can qualify future Jev approvals without resetting the new count. Real Jev
inference is not yet verified.

The controlled reset used `scripts/reset-kev-reporting.mjs` with each-mode,
100 entries per mode, and a 720-hour window. Its reset helper now carries the
current reviewer allowlist forward with the new start time. The fresh goal's
initial review recorded 0/200; a second read verified complete evidence, zero
Spot and Futures entries, all historical data preserved, no outstanding
submissions, and no remaining pause markers. The continuous Demo supervisor
was started again and operates with Kev.

Verification artifacts are in `local/kev-reset-2026-09-29-recount/`; the
previous cohort remains in `local/trade-goals/kev-demo-200-each-reset-20260928071100/`.
