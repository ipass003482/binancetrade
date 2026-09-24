# Kev Demo loss audit — 2026-09-22

Audit captured 2026-09-22 12:26:12 Asia/Taipei. Active goal remains
2026-09-21-kev-demo-100-20260921060503, ending 2026-09-22 14:05:03 Asia/Taipei.
No accounting reset or retrospective plan edits.

## Evidence and findings

Three independent agents checked original approvals/journals and live history,
entry reviews/quotes, and native exits against SQLite. All 84 included entries
are closed: Spot 65 (-5.99609219 USDT), Futures 19 (-2.12987408), total
-8.12596627; 28 wins / 56 losses, 33.33% win rate.

Actual order cost divided by filled quantity supplies weighted fill prices;
times trade quantity these imply gross directional price PnL +2.94440910 USDT.
The price-to-net difference is 11.07037537. Two-sided fee-rate equivalents total
11.07037534, with residual -0.000000034683 USDT. An earlier approximation using
rounded trade-level prices differed by 0.000515 USDT. Never sum fee_cost values
in different assets as if all were USDT. Historical PnL already includes fees.

49 time exits net -4.28900965; 32 exchange-stop exits net -6.25294121 (11 of these
are winning trailing exits); two direct profit-trail exits +1.32084638; one
target exit +1.09513821. All 16 observed trail activations ended profitable.
Seventeen eventual losers had some observed positive net PnL, all below the
0.5 USDT trail trigger. This is not a missed-trigger defect. The 1.5% target is
conditional geometry; it is not expected return. Cost-adjusted selection was
insufficient under the prior aggressive profile.

After the prior fee-aware deployment, 1,755 inspected cycles contained 1,738
successful model replies, all HOLD; 16 timeouts and one warmup/no-candidate cycle.
Normal replies contained eligible candidates. No request-size failure, native
rejection or cost mismatch explains the lack of fills in that interval. Replies
do not include a textual reason, so costs cannot be asserted as the model's
stated reason. Context spans three depth books (~20 seconds) and a 60-second
tape; it is not a validated prediction of the roughly 50–61 bps required
15-minute exit move. Preserve valid HOLD and the prior balanced cost fix.

## Confirmed implementation defect and correction

Before this patch, host quote checks allowed up to 100 bps from snapshot to
bridge quote, while native checks allowed a further 100 bps from bridge to
callback price. An isolated reproduction passed callback, context and wire at
180.81 bps cumulative movement on a long and 179.19 bps on a short. Fresh cost
checks did recompute spread: the defect was a moving decision-price anchor.

Every boundary now derives one quote-drift budget from existing assumptions:
minimum of policy max move, per-side slippage, stop distance, and remaining
target space after required costs. The original reviewed snapshot ask (long)
or bid (short) is immutable across checks. Absolute displacement beyond that
single budget rejects the window, including favorable price changes that might
reflect changed evidence. Current normal bound is 5 bps (0.05%), inherited from
the cost configuration, not fitted to observed losing trades. Never reset the
budget at the bridge. Native validation independently binds original review,
snapshot, fresh quote and final attempted price; host audit output is not
execution authority. Market fills can still differ from the final checked quote.

Spot trades 266 and 292 filled 22.13/31.37 bps above their reviewed ask. This
motivated the investigation; their eventual PnL is not an estimate of what the
new guard would save. The majority of historical losses cannot be attributed
to quote drift. No losing stop is removed, no target widened, no hold period
extended and no model switched merely to fit the same 84 trades.

## Validation and ongoing evidence

scripts/kev-loss-review.mjs provides a read-only, original-goal-based report;
missing approval/fill/cost evidence stays unknown/incomplete. It separates
strategy fingerprints and exit groups for future comparison. The operational
test results, original-source backups, native process reload and fresh-cycle
proof are recorded under local/kev-loss-fix-2026-09-22/.

Engineering validation proves the guard enforces its contract, not profitability.
Judge later actual fills using net PnL and cost, drawdown, adverse quote drift,
rejection frequency and stable out-of-sample cohorts. Do not infer a superior
model or optimal exit from this small, overlapping historical sample.
