# 2026-09-29 Demo HOLD recovery and quote-path evidence

The user requested another multi-agent investigation of low win rate, persistent
HOLD and missing entries. Work is staged away from the running watchers before
a controlled reload. Native exit rules, risk, fees, model, market agreement,
freshness gates, the execution session and the active 200-entry goal remain.

## Observed problems

At 2026-09-29 01:26:57 UTC the active goal had 14 verified entries: 13 closed,
4 wins and 9 losses, net realized -1.9990418 USDT, with one open Futures trade.
The fill-price component was -0.26298 USDT; fee-equivalent drag was
1.7360618 USDT. This small cohort does not demonstrate a profitable edge.

Three independent agents inspected the latest raw records and execution code.
Most recent HOLD decisions had no qualified host candidate before Kev was
invoked. Opposing tape/book directions, missing book consensus and bearish
Spot directions remain legitimate blockers. Futures also waits while its
position limit is occupied; a submitted ETH short was verified in this period.

A reproduced collector defect erased a pair's previous healthy book history
when only that pair's next request failed. Recovery then required three new
samples even when the original books still met unchanged age/gap checks.

An actual Spot ETH approval spent 18.287 seconds in Kev before the shared
portfolio guard rejected it because Futures already held ETH short. Reading
current shared positions before selection can exclude this impossible choice,
leaving other qualified candidates available. The final bridge guard remains
authoritative and repeats its locked, fresh reads.

The start-only supervisor was stopped by a maintenance marker. Its exact marker
was preserved in local/kev-flow-diagnostics-2026-09-29/supervisor-STOP.archived;
the recovered supervisor subsequently reported both modes RUNNING.

## Changes and validation contract

Per-pair collector recovery retains raw books only in internal memory. A failed
pair remains unavailable in published data. A recovered sample requires fresh
clock, book and tape data and the full unchanged validation.

The shared-position advisory is an exclusion filter before the Kev request.
Unknown, malformed or stale account evidence cannot make candidates selectable.
It does not authorize an order or replace final portfolio/risk checks.

Both modes archive quantity-aware, five-level book observations with their
clock envelope, collection times and proof hashes. Archive writes are bounded
and independent of order decisions. Dropped, missing and separated observations
remain explicit gaps; no inference fills a gap or claims a market fill from
displayed depth. Tape is not reconstructible from its hash.

The standalone audit uses reconciled engine opening value for its fee scenario,
does not apply eventual funding charges retrospectively, and counts zero-net
closed trades as losses. These audit changes do not alter real trade PnL.

## Remaining research limits

All 13 closed trades had sampled engine net-PnL peaks below the 0.50 USDT trailing
activation. Eight had no positive observed net point. These API observations are
not executable quote paths. There is no demonstrated native exit arithmetic
defect, nor enough evidence to promote a lower or staged target today.

The current one-page 60-second aggregate trade request can saturate at 1000
records. It correctly remains ineligible. A separate complete pagination design
would need bounded requests, continuity proof and matching host/native changes;
accepting truncated tape or relaxing the count check is not a repair.

Prospective archived books can support a cost-aware exit study as coverage
accumulates. Report actual cohort win rate and net PnL separately from simulated
quote scenarios, including missing funding and sampled-path uncertainty.

Deployment and verification evidence belongs in
local/kev-hold-recovery-2026-09-29/. Loaded-process and completed-cycle evidence
is required before describing these changes as active.
