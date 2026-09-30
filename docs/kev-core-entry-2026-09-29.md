# Kev coherent core entry, 2026-09-29

The user explicitly requested a core entry strategy change after repeated
direction-conflict HOLDs. This prospectively replaces the old directional
gate for new Demo snapshots. It is not a promise of higher win rate.

## Exact new contract

`kev-coherent-flow-v1` first validates every trade in the original complete
60-second tape, all three five-level books, sources, sequential trade IDs,
timestamps, freshness and sample gaps. Nothing is re-timestamped after review.

The directional window starts at the first book and ends at the original
tape end; the middle book splits it into two intervals. Require at least
15 seconds, three trades overall, and one trade in each interval. Directional
notional must be at least 55% overall and strictly above 50% in both intervals.

Both best bid and best ask must be non-adverse in both book intervals, and
both final quotes must strictly advance in the proposed direction. The signed
midprice change must be at least 0.25bps. Absolute five-level depth imbalance
must remain at most 0.7. Static standing-depth sign is context, not a separate
directional veto: large opposing resting depth and advancing prices can coexist.

These two local tape/quote intervals replace the old disconnected two-minute
confirmation. The new workflow does not read or rewrite the retired confirmation
state. Legacy snapshots retain their recorded rules for reproducibility.

The fresh executable entry ask (long) or bid (short) must still be strictly
favorable relative to the first book's same side. Original approval quote drift,
freshness, clock, shock, spread, cost, net margin, risk, position, portfolio,
exchange minimum, cooldown and one-use approval guards remain mandatory.

## Review and native execution

New snapshots include the exact full policy object. Original Kev request v5
includes this policy, each candidate's policy version and common-window
diagnostics, and all three original books. The complete original tape remains
in the immutable snapshot; the public recent trade sample is explicitly partial.
The full 60-second summary is marked as longer context, rather than a competing
same-window direction signal. Candidate ranking uses common-window pressure,
not standing-depth sign. Kev may select one qualified candidate or HOLD.

New immutable plans bind the reviewed policy. Native guard v3 independently
recomputes raw signal evidence with Decimal precision 40 / HALF_EVEN and checks
the plan, snapshot, original review and candidate policy at callback, context
and wire. Missing policy, relabeling or stripping to v2 fails closed. Native
engines must advertise v3 and the new signal capability before entries resume.

Existing stop 0.5%, gross target 1.5%, net-harvest exits, net trailing,
900-second cap and 1 USDT stress-risk sizing remain unchanged. The original
200-entry active goal, execution session, approvals, fills and losses remain
unchanged. A prospective amendment records the activation boundary; no count
reset or manual order is part of this deployment.

## Evaluation limits

The frozen rule was compared against immutable 2026-09-29 01:45–05:45 UTC
observations, with the last hour held apart in reporting. This verifies
admission behavior; historical executable-depth markouts include original fees
and slippage allowances but are hypothetical quantities, not actual fills.
Missing quote coverage and unknown funding/account state remain explicit.
The comparison does not demonstrate positive expectancy or improved actual
win rate. Judge the prospective version by actual net closes, retaining losses.

Operational source hashes, tests, before/after process identities, preserved goal
hashes and fresh-cycle verification are recorded under
`local/kev-core-entry-2026-09-29/`. The detached comparison script is
`scripts/kev-core-entry-review.mjs`; its report is retained with deployment evidence.

Binance defines aggregate trades as executions from a single taker order and
`m` as whether the buyer is the maker; this implementation retains that mapping:
<https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-streams/~>.
The sampled rule is a prospective engineering hypothesis, not a conclusion
established by exchange documentation or microstructure research.
