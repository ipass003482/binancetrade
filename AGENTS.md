# 2026-09-22 Multi-agent loss audit — current execution amendment

# 2026-09-22 Kev Demo reporting cohort — current goal

The user requested a fresh 100-entry observation round after the prior goal
closed at 84/100. The active reporting goal is
`local/trade-goals/2026-09-22-kev-demo-100-reset-20260922050238/goal.json`,
started `2026-09-22T05:02:38.831Z` (13:02:38 Asia/Taipei) and ending
`2026-09-23T05:02:38.831Z`. It is a combined Spot + Futures target of 100,
using `kev-order-flow-v1` and requiring the current Kev/Codex approval record.
The verified initial count is 0/100, Spot 0 and Futures 0. Existing Spot IDs
1–311 and Futures IDs 1–76 are baseline exclusions; the previous goal, all
exchange history, journals, losses, and execution session
`3918fa60-59d6-413c-af06-ff62919dddc8` remain preserved. This is a reporting
scope change only: no order was submitted and no strategy, model, risk, or
protection setting was reset. The hourly report automation must read
`active.json` dynamically rather than hard-code this goal's dates.

The user requested identifying and fixing the Demo losses with multiple agents.
Independent trade and SQLite reconciliation found 84 closed entries, net
-8.12596627 USDT. Using actual filled-order weighted prices, the gross price
component was +2.94440910; price-to-net drag was 11.07037537. Fee-rate equivalents
explain the drag within rounding precision. Cost accounting
and native stop/time/net-trailing exits were not found broken. Balanced decisions
remain valid HOLDs when evidence cannot support a fee-adjusted opportunity.

Fix the reproduced approval-price anchor gap: every Kev execution boundary must
use the same original snapshot/review quote, with one absolute drift budget
derived from the existing per-side slippage, policy, stop and remaining net target
space. Never replenish that budget at the bridge or native callback. This limits
decision quote drift; it does not guarantee a market-order fill price or profit.
Native exits, historical plans, Demo-only routing, model, risk limits, session,
goal and full losses remain intact. Do not change thresholds to fit 84 outcomes.

Read docs/kev-loss-audit-2026-09-22.md. Deployment evidence belongs under
local/kev-loss-fix-2026-09-22/; require tests and fresh-cycle native reload proof
before claiming activation. scripts/kev-loss-review.mjs is a read-only audit.

# 2026-09-21 Kev fee-aware review — retained execution amendment

The user approved withdrawing the aggressive entry preference and requested
correct cost accounting. Kev remains autonomous on order flow, now balanced.
Each candidate includes executableCostEconomics from src/trading-costs.mjs:
normalized 100 USDT entry notional, side-specific fees, two-sided slippage,
reserved funding, break-even exit quote, buffer exit quote and net exit scenarios.
Spot budgets an undiscounted BUY fee in received base and SELL fee in quote;
no unverified BNB discount. Executable ask-to-bid / bid-to-ask scenarios include
the spread once. Existing conservative spread-inclusive risk costs remain.
The prompt must allow HOLD when a cost-adjusted case is weak or missing; a
fixed target is not a return forecast or evidence of positive expected profit.

Native Kev entry validation independently recomputes costs from cost facts,
the persisted fresh execution quote and config/costs.json at all three entry
boundaries. Missing, stale, inconsistent or understated costs reject entries.
This hardening does not show prior realized PnL was misreported or guarantee
profitability. Existing exit plans, stops, risk budgets, session, full historical
losses and active 100-entry goal are preserved. No flow-exit change is included.
Deployment evidence: local/kev-net-cost-2026-09-21/; require completed tests,
native reload and new-cycle proof before claiming activation.

# 2026-09-21 Kev order-flow authority — supersedes Kline/Kronos entries

The user explicitly rejected the five-minute Kline path and requested Kev to
select pairs and sides directly from order flow. The active configuration uses
marketData=order-flow, decisionMode=autonomous, policy/rule kev-order-flow-v1.
Collection and execution quote retrieval use no candle, ATR or forecast data.
All data-valid/cost/risk-eligible whitelist pairs are offered; Futures offers
both sides. Kev chooses one pair/action or HOLD. No deterministic direction
threshold, Kronos candidate gate or first-five-minute-candle gate remains on
this route. Missing/expired/mismatched decisions still block entries.

Raw depth is sampled every 10 seconds; three five-level books and a rolling
60-second trade tape feed one bounded Codex request per minute. Spot starts
at second 5 and Futures at second 30 to share the single CLI worker. This is
minute-scale sampled order-flow trading, not millisecond/event-feed HFT.
Native engine timeframe metadata remains for compatibility with historical
positions; it is not an input or entry gate of the Kev contract.

New fixed exits: stop 0.5%, target 1.5% (3:1 gross planned geometry), maximum
900 seconds, original net-profit trailing, maximum 1 USDT estimated stress
risk including full fees and native reserve. The target is a fixed experiment,
not a return forecast; reject if costs or net reward/risk do not fit. Do not
change target per candidate to manufacture eligibility. Actual spot costs of
roughly 30-34bps were checked before choosing this geometry. Native guard
kev-native-entry-v1 verifies exact persisted review bytes, selection, raw proof,
snapshot, costs, clocks, risk and one-use intent at callback/context/wire.
No live, UTA, OpenAlice or automatic commits/pushes are authorized.

Existing plans, stops, histories, execution session and active 100-entry goal
are preserved. A prospective kev-order-flow-amendment.json binds the existing
goal hash and deployment time; older entries retain their original attribution.
Operational evidence: local/kev-order-flow-2026-09-21/; source authority mirrored
in local/adaptive-minute-2026-09-16/. Read plans/current-v12.md and
docs/kev-order-flow-2026-09-21.md. Older sections below are historical.

# 2026-09-21 Kev autonomous selection + minute cadence — historical execution authority

The user authorized the Demo test machine to let Kev choose how an eligible
entry is handled and help select the candidate. `config/kev-entry.json` and both
per-mode activation files now use `decisionMode: autonomous`. For each snapshot
with any native-eligible candidate, one bounded Codex CLI request receives the
complete candidate pool—even when the deterministic ranker currently shows
HOLD—and chooses at most one existing Kronos candidate or HOLD. Kev cannot
invent a pair or direction, reverse the pinned direction, change price, size,
leverage, stop, target or time, bypass quote/cost/risk/clock/protection checks,
or submit an order. The bridge and native engines remain the execution and
protection authorities; native exits never wait for Kev.

The high-frequency component is the existing `flow-minute-v1` Demo cadence:
fresh observation every 60 seconds, with model entry windows still constrained
to the complete 5m candle's first minute by the native guard. This is the
fastest safe cadence for the Codex CLI path; it is not a 300ms block-level
executor. No live, UTA or OpenAlice configuration changed and no native engine
was restarted. Deployment evidence is `local/kev-autonomous-2026-09-21/`, with
the operational source authority mirrored in
`local/adaptive-minute-2026-09-16/`. The active 100-entry reporting goal and
existing positions/history remain intact; future receipts carry
`decisionMode: autonomous` so the cohort can be evaluated by actual fills.

# 2026-09-21 Kev-only 100-entry reporting cohort — current goal authority

The user explicitly requested recounting 100 entries from Kev activation. The
active reporting goal is now local/trade-goals/2026-09-21-kev-demo-100-20260921060503/goal.json,
starting 2026-09-21T06:05:03.356Z (Taiwan 14:05:03), combined 100 actual entries.
It includes the original Kev-approved Spot UNI/USDT trade 247 as entry 1;
Spot IDs 1-246 and Futures IDs 1-57 are count baselines only. The original
approval, entry plan, journal and actual fill were verified. Existing positions,
history, losses, execution session and running services were not reset or closed.
The new goal follows the existing reset convention of a 24-hour observation
window, ending 2026-09-22T06:05:03.356Z. The prior goal and its deadline are archived
unchanged. Missing a deadline never authorizes changing it or manufacturing fills.

Hourly reports must follow active.json and the entire current entry cohort,
including across midnight, with actual fill and original Kev approval evidence.
The today-pnl endpoint alone is day-scoped and must not replace cumulative goal
accounting. Initial verified state was 1/100 at 2026-09-21T06:26:44.671Z; this is
historical evidence, not a current-count claim. Read the goal's pre-reset.json,
initial-review.json and reset-verification.json. All trading safety and model
authority in the next section remains in force. No runtime source was changed.

# 2026-09-21 Kev/Codex Demo entry approval — current execution authority

The user explicitly requested adding the running Kev-format Codex CLI service to
orders. Both Demo modes now require kev-codex-entry-v1 approval of existing
Kronos-eligible candidates, activated by local/<mode>/kev-entry.json. The model
remains gpt-6-astra through the local API on 127.0.0.1:8009; no Kev weights load.
No candidate means no CLI call. Up to eight candidates share one bounded request.
Unknown, unavailable, declined, tied or expired approval means HOLD, without retry
or a fallback entry. Approval binds the snapshot, mode, pair, direction and config.
Its expiry matches the existing native first-minute model deadline. Bridge checks
before quote and before send; native model/cost/risk/clock/protection checks remain.
Native exits and old plans never depend on the added reviewer. No risk, cost,
position, leverage or entry-count limits were relaxed. This is not profit evidence.

Read docs/kev-entry-2026-09-21.md and local/kev-entry-2026-09-21/ for deployment
and verification. Current operational source manifests are also mirrored under
local/adaptive-minute-2026-09-16/. The source checker permits only the two named
activation JSON files under local, never local credentials. The execution session,
historical losses and Kronos model pin remain unchanged; the reporting goal was
subsequently replaced by the user-authorized Kev cohort above. Demo only;
no live/UTA, automatic commits or pushes. The sole plan remains plans/current-v12.md.

# 2026-09-20 AI entry repair and model comparison — retained authority

The user requested multiple-agent evaluation, then explicitly said "做啊" to
implement it. Both Demo modes now use the existing pinned Kronos forecast as
entry direction authority, subject to all native quote, cost, ATR, clock, risk,
cooldown and protection checks. Older flow-only / futures-veto descriptions below
are historical. The sole current plan remains plans/current-v12.md.

The AI bridge no longer adds flow minute-cadence fields rejected by the model
native guard. Observation still runs each minute, while AI entry evaluation runs
only in the first minute after a complete 5m candle. Other minutes record
MODEL_NEXT_CANDLE_WAIT without waiting for an impossible new prediction. The
60-second native deadline and exact snapshot binding remain enforced.

New AI plans use a fixed maximum 1 USDT estimated stress-risk budget, 2 ATR target,
1 ATR stop capped at 2%, native profit protection and a four-hour time exit.
Historical flow adaptive sizing and flow exits do not apply to new AI plans;
existing positions retain their entry-time plans. Fees and costs are mandatory.
No research result is permission to relax guards or manufacture fills.

Deployment evidence is local/ai-entry-repair-2026-09-20/. The original session,
combined 100-entry goal, journals and model pin are preserved. Trading remains
Demo only; no live/UTA/OpenAlice configuration changes and no automatic commits.
Independent shadow v2 and local/model-comparison/ are research only. They cannot
promote a model or send orders. Missing costs/labels remain unknown; quote
markouts and cost scenarios are not realized PnL. The model comparison currently
has insufficient independent evidence to select a replacement. Read
docs/model-comparison.md for its conditional coverage and fixed-time replay.

# 2026-09-16 13:56 fast volatility sizing — historical authority
User explicitly requested implementation, superseding observe-only ATR notes.
live-flow-adaptive-v2/native guardv12 is deployed; Demo resumed13:56 and UNIspot#8
truly filled13:57 onv2. See docs/demo-fast-atr-2026-09-16.md.
Authority paths/checker remain local/adaptive-minute-2026-09-16/. Upgrade evidence
and prior manifest backups: local/fast-atr-2026-09-16/.115sources verified,
686JS/797Python/syntax174/isolatednative smoke passed;19crosslanguage cases equal.
Latest15closed5mHLC derive fast7TRmean(35min),slow14TRmean(70min).
Multiplier=min(1,slow/fast),fastzero=>1; finalrisk=max(.25,baseRisk*multiplier),
40-digit intermediates then12dpdown. Each minute reevaluates; newbars arrive5m.
No new direction gate.15m/210min ATR exitdistances unchanged. Persist rawbars,
native rederive atall3boundaries. v11/v1legacyexitplans stayvalid andimmutable.
ETH#3 originalplanhash and sameexchange stop preserved acrossreload.
Goal/session/modelpin/restartbudget/history unchanged.Each50before16:00UTC,
Demoonly,no live/UTA/noautocommits. Existingcontinuousauthorization persists.
Historical observe-only andv1/v11 descriptions below cannotoverride thisversion.

Prompt review wording was revised to v14 after this deployment: the four analyst
files share an explicit authority order, untrusted-data delimiters, dynamic
parameter handling, and a capability-driven Spot/Margin short boundary. v14 also
clarifies that missing entry-only cost data must not suppress a justified native
exit. This is review text only; deterministic order-flow rules, risk limits,
native exits, goals, history and Demo-only routing are unchanged.
`src/analyst.mjs` exposes `PROMPT_VERSION=14`; reload the watchers through the
controlled maintenance procedure before treating a new prompt hash as loaded.

# 2026-09-16 13:39 adaptive minute Demo and negative receipts — historical authority
User explicitly requested multiple agents, dynamic parameters, one-minute decisions,
all prior positions closed and a new each-mode50 target today. Existing positions
are terminally closed; session/history/losses retained. Current sources and runtime:
local/adaptive-minute-2026-09-16/{running,source-deployment,validation,resumed,rejection-paused-check}.json.
114 deployed sources verified before resume2026-09-16T05:39:41.5829719Z;
native spotPID19508/futuresPID22540 at that deployment, not timeless PID claims.
Read docs/demo-adaptive-minute-2026-09-16.md; use only plans/current-v12.md.
Current read-only checker: node local/adaptive-minute-2026-09-16/check-running.mjs.
It reuses the original session validations with the new deployment authority.
New goal: local/trade-goals/2026-09-16-adaptive-minute-50-each/goal.json,
starts2026-09-16T05:29:39.077Z; original deadline2026-09-16T16:00:00.000Z.
Spot oldIDs1-7/futures1-2 excluded only from this goal; losses remain in history.
flow-minute-v1 uses fresh decisions each60s, completed5m candles for15m ATR,
one-minute exclusive expiry. Model observer remains5m. live-flow-adaptive-v1
recomputes spread/cost/depth pressures: risk0.25-1USDT, taker55-60%, buffer30-40bps.
Native guardv11 independently validates all3 boundaries; immutable exits remain.
No quota-induced loosening or fake fills. Futures1x isolated; Demo only, no live/UTA.
Model weights unchanged; implementation selector changed and controlled new pin is
26648aab59dd5b993f35385993cbcd6e8911f8ba45a819973dfd83ebd2788af6.
Restart budget attempts and old forecasts retained.682 JS/761 Python/syntax174
and isolated native smoke passed, with0 real orders in smoke. Durable exact
pre-wire native callback rejection receipts are deployed: valid matching evidence
records rejected/filtered and allows a later fresh minute, never resend that intent.
Missing/contradictory receipts or potentially transmitted orders remain unknown
and blocked. Old XRP intent1e5c816feff35e221f15c50b45581959 was independently
reconciled as rejected/no order; never backfill a new receipt or resend it.
Retain15m ATR: real1/5/15m fourteen-pair comparison is documented in
local/adaptive-minute-2026-09-16/atr-horizon-review.md. Spot fee inputs exceeded
freshness, so those numbers are explicitly scenario-only, not entry eligibility.
One-minute decision speed does not require one-minute ATR. New forward PnL must
establish efficacy; tests, planned price space and target count prove no profit.
Broad modify/test/deploy/continuous Demo authorization persists. No auto commits/push.
Earlier5m/pin/manifests below are historical and do not override this section.

# 2026-09-16 10:18 fresh Demo session — historical deployment
The user explicitly confirmed: close old positions, clear old local Demo records,
then complete EACH mode 50 actual strategy entry fills today, before the exclusive
2026-09-16T16:00:00.000Z deadline (Taiwan midnight). No new approval is needed for
ordinary guarded Demo testing, defect fixes, controlled deployment or recovery.
This supersedes all older preserve-history/old-goal/maintenance-pause instructions.
Old SOL85 and BTC64 have terminal exit fill proof.295 active old-data targets were
removed only after all writers stopped and full exchange positions/orders were
reconciled. Exchange-side history and technical source archives were not deleted.
Spot residual seed/dust inventory was retained and recorded, not new strategy PnL.

Session local/demo-session.json:3918fa60-59d6-413c-af06-ff62919dddc8,
startedAt2026-09-16T02:15:45.203Z. Native history/positions and new portfolio net PnL
were verified0 in both modes before resume. Shared configured budget remains2000.
Authority: local/demo-reset-2026-09-16/running.json (70 strategy sources),
source-deployment.json (30 supplemental files),initial-check.json and reset-status.json.
Read-only operational checker: node local/demo-reset-2026-09-16/check-session.mjs;
requires exact expected session and checks94 unique source files, native protection,
model pin, no old-session contamination and unresolved submissions. Never invoke
old goal30 checks/manifests as current authority after the authorized reset.
New goal: local/trade-goals/2026-09-16-fresh-flow-50-each/goal.json.
Review: node scripts/trade-sprint-review.mjs --goal <that path>.
Goal natively uses order-flow-only-v1/modelFingerprint:null (no fake amendment).
Each mode/trade_id with true attributed fill counts once; closes, split fills,
probes, old trades and fills at/after deadline never count. Do not shift deadline.

644 JS,syntax169 and65 dedicated read-only account tests passed; independent58
flow-goal tests and session checker cross-review passed.18 reset/report/goal files
applied plus the prior12 profit improvements. Entry rules/risk/cost thresholds unchanged.
Native engines, watches, supervisor, dashboard, model and horizon workers restarted;
model pin remains0bc0a246933d625d8c7724347a0dcc8cf8619d3646f46565558607b6a0cf96d1.
Missing new model forecasts immediately after reset are warmup, not permission to
restart or disable the model. Flow entry stays observation-independent.
Use only plans/current-v12.md. No live funds, OpenAlice/UTA or automatic commits/push.
Actual profit is the goal; a reset/test/count does not prove improved profitability.

# 2026-09-16 08:32 latest 22-agent review deployment
Current authority supersedes earlier manifests/descriptions below:
local/v12-team-2026-09-16/running.json (75 strategy sources), source-deployment.json
(19 changed files, including read-only reporting/UI) and validation.json.
See docs/demo-team-review-2026-09-16.md for the 22 actual participants and fixes.
603 JS / 631 Python / syntax163 / isolated native smoke passed. New08:30 cycles:
spot ADA90 truly filled337.2 at65.95632USDT gross, protected; futures HOLD.
Unknown intents0. Original entry plans, all goals/losses and $2000 baseline remain.
Flow policy/order/risk thresholds unchanged. Fixes reject regressed/negative IDs
and align host/native55% precision; sampled-quote cohorts stay observation-only,
not cost/capacity-qualified entries. Version PnL and stop slippage are read-only.
Missing/unknown/contradictory evidence cannot become complete zero profits.
New spot quality remains flow-confirmed-exit-v2; legacy plans remain unchanged.
No profitability improvement proven; current v2 has0closes/2open at08:32.
Continuous Demo authorization remains. User explicitly requested22 agents this
turn, overriding ALL earlier no-agents restrictions below;22 completed in batches.
Future multi-agent work may follow the user's current scope and available slots;
recurring quiet health checks need not recreate22 agents. No live/UTA or automatic
commits/push. Use only plans/current-v12.md; retain immutable historical evidence.

# 2026-09-16 07:33 latest spot flow exit experiment
Current authority supersedes ALL earlier manifests/policy descriptions below:
local/v12-flow-confirmed-2026-09-16/running.json (75 sources), validation.json
and docs/demo-flow-confirmed-exit-2026-09-16.md. New spot plans use
flow-confirmed-exit-v2 / rolling-opposite-flow-v2: at least3 fresh60s opposite
rolling windows spanning20s, advancing tape IDs, max20s observation gap.
Overlapping windows prove persistence, not statistical independence.20s follows
collector cadence, not optimized profit evidence. Existing flow-strength-exit-v1
positions KEEP their original two nonoverlapping60s-window rule. Futures exits,
entry conditions, costs, risk, stops, goals and original capital are unchanged.
Failure reasons now distinguish the FIRST unmet tape/depth/price/data condition;
reason-change logs are not independent sample counts. All564 JS /624 Python,
syntax158 and isolated native smoke passed. No profitability improvement claimed.
Both Demo engines and watches restarted; native stops and model preserved.
Continuous Demo authorization remains; no live/UTA, agents or automatic commits.
Do not restore old exit rules for NEW plans from historical text below.

# 2026-09-16 04:43 latest host batch protection sequencing
Current authority supersedes the04:36 manifest below:
local/v12-batch-protection-2026-09-16/running.json and validation.json,75 sources.
See docs/demo-batch-protection-2026-09-16.md. After a confirmed Demo fill, wait
for full native protection evidence before selecting another candidate. Only
POSITION_UNPROTECTED gets a10s retry budget; unknown/pending/bad/stale proofs
still fail. No order resend or protection bypass.59 relevant JS checks pass.
Only watch/supervisor restarted; native engines, model and observers untouched.
ADA82 was truly filled04:40 and protected04:40:16; preserve its original plan.
RPC session cleanup remains loaded in both engines. No profitability claim.

# 2026-09-16 04:36 current RPC session cleanup deployment
Current authority: local/v12-rpc-session-2026-09-16/running.json (75 sources),
validation.json and docs/demo-rpc-session-cleanup-2026-09-16.md. Earlier74-source
manifests below are historical. API custom-data request session leakage reproduced
with real RPC/dependency and disposable SQLite; process-local cleanup is installed
in both Demo engines for entry/exit/cancel RPC. 91 Python and29 JS checks pass.
Model/dashboard/observers untouched; original plans/goals/capital/losses preserved.
No entry/risk thresholds changed and no profitability improvement established.
Operation-check verifies this manifest and current PID cleanup startup hash.
SOL intent7f43cbea84a69e4a89f8dc00babf85d7 was exact-tag callback-denied and
proven empty exchange window; rejected proof in local/v12-reconcile-2026-09-16/
sol-native-rejection/. Never resend. Generic callback negative receipts and
strict automatic reconciliation remain pending; never clear unknown on502/absence.

# 2026-09-16 04:20 reconciliation repair
See docs/demo-reconcile-schema-2026-09-16.md and local/v12-reconcile-2026-09-16/.
src/reconcile.mjs accepts absent ft_is_entry only via exact entry side and all
existing unique tag/order/fill/precision/cost proof checks. Explicit bad flags reject.
SUI81 intent2c72a5c36d09e33b16bca75017b0de38 is reconciled to order1065635601;
never resend. Six tests pass. Original74 strategy sources unchanged; operational
source-deployment.json separately checked by local/goal30-v12-operation-check.mjs.
SQL pool exhaustion and automatic/negative-outcome reconciliation remain unresolved.
ETH61 net-1.48125012 exceeded1USDT planned risk via stop fill2417.99->2434.74;
retain actual loss and study slippage; the risk budget is not a hard loss cap.

# 2026-09-16 midnight operational addendum
Yesterday each100 goal settled at12 spot/11 futures, original deadline unchanged.
See docs/demo-midnight-recovery-2026-09-16.md and local/v12-midnight-recovery-2026-09-16/.
UNI intent847e319c4f269736b1d1746d8b4f7109 was exact-tag callback-denied, proven
by empty guarded exchange window and full history; append-only rejected, never resend.
BTC56 trailing-stop replacement was immediately fillable; native emergency exit
filled +0.2967366 net, API exit_reason null. Both modes resumed after native proof;
strategy/model/engine sources unchanged. Generic RPC outcome classification is
NOT permanently fixed; never clear unknown merely from an error or absent trade.
No new deadline, no quota-induced stop; continue Demo and retain all losses.

# Current v12 order-flow-only experiment — 2026-09-15 Taipei
22:00 capital observer runtime repair: independent-history-recovery-v1, docs/
capital-recovery-2026-09-15.md, local/capital-recovery-2026-09-15/validation.json.
History reconciliation is single-inflight background work, never blocks samples.
First-seen trades recover their actual pre-entry journal window after outages;
stream bounded dates and reject torn journals. Existing attribution files remain
immutable. No retrospective provider backfill. UI now shows the actual Demo
flow and separates history freshness. Trading/model source manifests unchanged.
21:03 dashboard addendum: capital-flow-observer-v1 continuously joins public
DefiLlama nominal USD stablecoin supply background to prospectively recorded
Demo order flow and actual trade PnL. See docs/capital-flow-integration-2026-09-15.md
and local/chain-flow-2026-09-15/validation.json. Observation/advisory ranking only,
usedForEntries=false. Exchange netflows and labeled whale data are NOT connected.
Never claim supply changes are exchange buying/selling, backfill old trades, or
activate ranking without a prospective evidence-based experiment. Existing
trading/model source manifests, risk, goals and authorization remain unchanged.
18:14 signed-strength repair is current: local/v12-signed-strength-2026-09-15/
running.json and validation.json (74 sources). A signed ranking delta was wrongly
parsed as nonnegative by native v10; only that field now permits negative values,
with finite/type/range-via-original-proof checks retained. Negative delta ranks a
candidate; it is not an eligibility gate. Policy/quality/native versions unchanged.
544 JS / 596 Python pass; docs/demo-signed-strength-2026-09-15.md.
The exact cb13a6865aa2602944c935e3c349d2c2 intent was callback-denied before wire,
confirmed by empty Demo NEAR order history, and appended as rejected with proof.
Never resend it or count it as a fill. Earlier manifests below are historical.
Runtime addendum: local/v12-health-queue-2026-09-15/{running,validation,source-deployment}.json
records same-process health/event serialization after 17:05 and 17:10 status-lock
collisions skipped spot cycles. Strategy fingerprints were unchanged by the health-only repair; src/health.mjs is separately hashed in this runtime addendum.
Do not clear external locks or change trading gates; see docs/demo-health-queue-2026-09-15.md.
The sole active work plan is plans/current-v12.md (index PLANS.md). Keep the latest
work plan, migrate applicable unfinished work and references, remove superseded
work plans. Preserve this rule in replacements. Immutable per-trade plans, goals,
losses, orders and evidence are never removed by work-plan cleanup.
Read docs/demo-flow-strength-exit-2026-09-15.md for current spot ranking/exits,
and docs/demo-flow-continuation-2026-09-15.md for the retained entry quote check,
docs/demo-flow-quality-2026-09-15.md for collector/observer behavior, and
docs/demo-flow-only-2026-09-15.md for base entry rules. Authoritative manifest:
local/v12-flow-strength-exit-2026-09-15/running.json and validation.json, 74 sources.
Collector per-pair-clock-v2 uses per-pair dispatch windows and actual depth receipt
times, fixed cadence with 5s recovery floor. Spot-flow-observer-v1 runs research
asynchronously without entry gates; 1/5/15m quote reactions are not filled PnL.
Read scripts/spot-flow-review.mjs --date YYYY-MM-DD (UTC anchor date) for research;
respect recordId dedupe, missing outcomes, non-overlap and unknown costs.
The original flow-only deployment remains historical evidence.
Active entry policy order-flow-only-v1, entrySignalEngine sampled_order_flow,
native guard kronos-native-entry-v10. Main ruleVersion kronos-direction-v12 is an
exit/history compatibility identifier; current orders do NOT require Kronos.
Spot executionQualityVersion flow-strength-exit-v1 retains continuation-v1: offered
buying ask strictly above the first flow-book ask, on snapshot and fresh host
quote recheck. Native rechecks callback reference rate, not a guaranteed market
fill or a new wire quote. A rejection cancels only this entry; next cycle remains
active. Futures omit the quality field. Reports split executionQualityCohorts;
legacy-unrecorded and not-applicable are not backfilled into the new cohort.
Eligible spot candidates rank by last minus first depth imbalance, then original
planned net reward minus stressed risk. Ranking does not reject candidates.
New spot plans carry flowExit sustained-opposite-flow-v1: two disjoint 60s
post-entry opposite windows, 60-90s apart, continuous valid observations <=20s
apart. Same snapshot cannot confirm twice; neutral/invalid/gaps reset pending
confirmation. Native rules_flow_invalidated exit persists confirmed raw proof
in spot_flow_exit trade custom data. Existing stop/target/time/trail have priority.
Old plans and all futures retain original exits. Do not enlarge targets or stops.
Both ranking and exit are prospective hypotheses, not demonstrated improvement.
Observer quote markouts still describe base flow eligibility, not this new filter.
All entries use Demo taker flow >=55%, three same-side top-five depth samples,
and favorable mid change. No model wait/read, SMA, trend, pullback or candle
momentum gate or fallback. Model/lab/watchdog continue as observers; missing,
stopped or contrary model does not block this policy. Trading STOP still blocks.
Keep 5m cadence (+5s spot, +15s futures), first-minute entry expiry, original flow
data validity, costs +30bps, $1 risk including costs/native reserve, 3x closed15m
ATR target and 1x stop capped2% divided by executable quote, 1x isolated futures,
net reward/risk>=1, native stops/trailing/4h exits. Daily entry cap stays zero.
No zero-fill/HOLD/quota-triggered model stop/restart. No real money or OpenAlice/UTA.
Today's each100 goal is unchanged: local/trade-goals/2026-09-15-flow-100-each/goal.json.
Its order-flow-only-amendment.json prospectively admits this policy from
2026-09-15T02:56:33.575Z until original midnight Taipei deadline. Separate policy
cohorts and honest non-model evidence; no backfill. Original model each30 excludes
flow-only trades by design; retain all history/losses and original $2000 baseline.
Broad Demo modify/test/deploy/recover/continuous-operation authorization remains.
No repeated asks, no new subagents, no automatic commits/push. Check actionable
changes and actual fills; do not claim profitability based on tests or ATR space.
Older strategy instructions below are historical and cannot override this contract.

# Historical deployment notes (only nonconflicting operational safeguards remain current)

# Binance trade
Current collection timing repair: docs/demo-futures-candle-delay-2026-09-15.md.
Authoritative current loaded manifest is local/v12-delay-2026-09-15/running.json;
verification is validation.json in that directory. Futures collection now starts
15 seconds after each 5m close, spot remains 5 seconds. Model/native first-minute
expiry, exact OHLCV matching, model pin, entry policy and risk gates are unchanged.
Use the current delay manifest for source hashes; batch/net-edge manifests below
are historical. The delay improves data availability, not a claim of profit.
Current execution update (2026-09-15 Taipei): docs/demo-v12-batch-2026-09-15.md.
Authoritative deployment is local/v12-batch-2026-09-15/running.json and validation.json
once present. Native guard v5 supports per-pair-cycle-v1 serial distinct-pair
entries per immutable 5m snapshot; all prior strategy/cost/risk/clock gates remain.
New sprint local/trade-goals/2026-09-15-net-edge-100-each-0800/goal.json starts
2026-09-14T16:54:52Z and counts each mode toward 100 actual new fills strictly
before 2026-09-15T00:00:00Z. Run scripts/trade-sprint-review.mjs --goal <path>.
Keep original each30 goal and shared capital/losses. Deadline/target never stops
Demo/model automatically or licenses forced entries. Net profit remains the objective.
The net-edge v4 loaded-source references below are now historical after batch activation.
Independent Windows-native Binance spot and isolated USDT perpetual research / Demo project. No Docker.

Current entry update (2026-09-15 Taipei): read docs/demo-v12-net-edge-2026-09-15.md.

Authoritative loaded sources: local/v12-net-edge-2026-09-15/running.json;

validation.json plus validation-addendum.json record verification and one

maintenance-skipped trading cycle. New policy forecast-net-edge-v1, native

guard kronos-native-entry-v4. Historical revisions below do not override it.

User requested a read-only OpenAliceFlow code/results comparison; see

docs/openaliceflow-comparison-2026-09-15.md. No OpenAlice broker/config writes.

Retained execution repair: docs/demo-stop-stability-2026-09-14.md and

local/v12-stop-stability-2026-09-14/running.json record the historical stop-stability

loaded-source manifest. Native stopPriceVersion stable-unarmed-stop-v1 is

required before new entries. An unarmed existing tighter ATR stop is retained

without repeated float/ratio conversion; old plans/stops/realized losses persist.

Historical entry revision: docs/demo-v12-momentum-2026-09-14.md and

local/v12-momentum-2026-09-14/running.json record the prior momentum deployment.

Current new entries retain closed-price-momentum-v1 confirmation inside forecast-net-edge-v1: model direction must match

both completed 5m and 15m close changes (strict comparisons, four closed bars).

Native guard v4 rechecks the plan proof; old exit plans remain unchanged.

Keep direction-only-v12, closed-price-momentum-v1 and forecast-net-edge-v1

entryPolicyCohorts separate, original v12 30-per-mode goal and all losses.

Do not interpret this small-sample exploratory filter as proven higher win rate.

Historical execution risk revision: docs/demo-v12-risk-2026-09-14.md and

local/v12-risk-2026-09-14/running.json supersede the earlier recheck manifest.

New v12 entries require native-stop-risk-v1 in both host and native guards.

Spot adds 0.005 of entry notional to original stop-plus-cost sizing to cover the

existing 0.995 native stop-limit interval conservatively; original costs are

unchanged. Futures reserve is zero (stop-market has no bounded-fill guarantee).

Keep per-plan/journal risk attribution, separate risk-cohort PnL and original

v12 30-per-mode goal/baseline. Old exit plans remain readable and immutable.

User's renewed broad Demo authorization covers implementation, testing,

controlled deployment/recovery and continuous operation without repeated asks.

It does not activate real-money trading. Complete the authorized work through

loaded-process and new-cycle verification; tests alone are not deployment.

The staged/current-source strategy is kronos-direction-v12, with native exits

demo-rule-exits-v12 and native model guard v4 / kronos-direction-atr-v1 plus closed-price-momentum-v1. Deployment

and loaded-process evidence must establish activation; staged files are not proof.

The user explicitly authorized connecting model outputs to Demo entry decisions.

Keep the same frozen Kronos-small fingerprint

0bc0a246933d625d8c7724347a0dcc8cf8619d3646f46565558607b6a0cf96d1.

Require all three forecast closes strictly on the same side of the observed last

close, and the last forecast still favorable versus executable ask/bid (edge > 0).

The separate 2x completed 15m ATR target must cover the ORIGINAL full round-trip

cost plus 30 bps buffer. The forecast amplitude versus executable ask/bid must also STRICTLY exceed

that same required cost plus buffer. Reject equality/shortfall, including native

callback/context/wire. Rank forecast movement minus required cost space, never

call it calibrated expected profit. This explicitly supersedes the earlier v12

direction-only removal of the forecast cost gate; costs/buffer are unchanged.

Host rules still enforce fresh immutable same-cycle evidence, pinned model,

costs, risk, positions and native exits. Missing/suppressed model means HOLD; never

fall back to v10 technical entries. Old SMA/volume/breakout/retest entry filters

are not active in v12. Keep 5m cadence and the first-minute model entry deadline.

The predictor itself cannot submit orders; its usedForOrders=false refers only

to the producer. Actual downstream usage is recorded in model-decision, entry

plans and journals with modelFingerprint/predictionSha256. Do not confuse forecast

diagnostics with filled-trade PnL. The unchanged producer's v11_demo_rule_entry

consumer label is historical; the actual host decision/plan/journal version is

authoritative. Preserve old forecasts, losses and fingerprints.

Continuous Demo/model operation is authorized; zero entries or zero fills must

never be a model shutdown condition. Honor both trading and model STOP. Forecast

quality may suppress entry advice while the model continues inference/observation.

Preserve the original shared capital/losses and v11 trial/goal. New v12 filled

entries are tracked separately toward 30 per mode, with no deadline or daily cap.

Do not backfill, count HOLD/probes/unfilled intents, or transfer v11 fills to v12.

Keep 1x ATR stop capped at 2%, $1 risk including estimated costs, 2x ATR target,

four-hour maximum hold and net trailing activation/giveback of $0.50/$0.25.

Existing v10/v11 trailing plans/state and v7-v9 breakeven plans retain their rules.

Historical v11 entry contract and deployment: docs/demo-model-v11-2026-09-14.md.

Historical v10 exit update: read docs/demo-forward-v10-2026-09-14.md.

v10 keeps v9 entries and initial ATR/risk limits but replaces new trades' fixed

breakeven with net-profit-trail-v1: activate at 0.50 net USDT, persist the observed

peak, and tighten the native stop to cover peak minus 0.25 USDT after fees/funding.

The floor is a desired stop price, not guaranteed realized PnL. Existing v7/v8/v9

plans keep their original breakeven. The v9 instructions below are historical;

never roll back current entry versions or reset shared capital/losses from them.

Do not read, modify, import configuration from, or connect to OpenAlice / its UTA.

Reject real-money execution. Demo is allowed only through the guarded project

adapter, dedicated Demo identity and Demo-only wire destinations. Futures is a distinct demo-futures mode, isolated margin,

maximum 3x, and the BTC/ETH/SOL/BNB USDT perpetual whitelist. Never route it through spot. Dry-run stays default.

Demo keys are entered locally and encrypted for the Windows user; never log them

or expose them to research agents. Do not read stored credentials during development.

Research agents run in the nested research repository, without trade-control tools.

Only the bridge may request orders after deterministic checks. Never retry an

ambiguous order response: persist it and reconcile against Freqtrade first.

Do not weaken limits or activate live trading as a way to make a test pass.

Run npm test, npm run check, and the native Freqtrade contract smoke after changes.

Do not leave a scheduler running unless the user explicitly asks for continuous operation.

Do not automatically commit/push or change the user's global Git/Codex settings.



User trading priorities and continuing Demo authorization are recorded in

docs/trading-objective.md. Use actual fee-adjusted Demo results and drawdown to

evaluate changes; preserve the shared 2,000 USDT experiment and monetary/position risk limits.

The user explicitly removed the daily entry-count cap for both Demo modes on

2026-09-10: maxEntriesPerDay=0 means unlimited daily entries. Do not restore a

daily count quota without a new user instruction.



Prompt/strategy alignment (2026-09-11): the user's objective is actual fee-adjusted

profit and controlled drawdown, including calendar-month evidence. More entries

or passing software tests do not establish a trading edge. Current Demo entries

use deterministic rules, not an LLM. Keep src/strategy-contract.mjs, executable

parameters and review prompts aligned; record the decision engine and whether a

model was actually invoked. Read docs/demo-forward-v9-2026-09-11.md for the historical

next-closed-bar retest/reclaim entry experiment, retained by v10. Preserve 5m cadence and unlimited daily

entry counts. Change one identifiable strategy hypothesis per version where

practical; never claim saved-snapshot reclassification is realized profit.



The v8 volume experiment was terminated early on 2026-09-11 at the user's renewed

request to improve the losing strategy. Its config is disabled; preserve its

original start, archived results and per-arm attribution. Do not restart its

rotation from older instructions. v9 uses the original base volume minimum 0.8

and adds confirmation-bar retest/reclaim. Comparing v9 against the immediately

preceding vol-10 arm changes both entry condition and volume; do not call that

a single-variable comparison. Keep historical v8 results separate from v9 and

preserve the shared portfolio baseline and losses. Existing v8 exit plans remain

valid. The v8 day-35 goal is recorded separately; v9 trades cannot fill its quota.



Restoration update: on 2026-09-13 the user explicitly authorized restarting Demo.

The wait-for-Sunday-restart condition below is historical and has been satisfied.

Read docs/demo-restart-and-strategy-review-2026-09-13.md for restoration evidence,

the day-35 audit and the current decision to continue v9 with operational fixes.

Keep outage-affected spot trade 52 and futures trade 31 in aggregate PnL, while

identifying them separately when assessing normal strategy holding/exit behavior.



Planned power outage: the user reported a home outage on 2026-09-12 Taipei time;

the user will only restart the bot on Sunday 2026-09-13, exact hour unknown.

Do not proactively restart it on Saturday even if power returns. Wait for the

user's actual Sunday restart; the date alone is not proof of restoration.

Read docs/planned-power-outage-2026-09-12.md before

interpreting related missing heartbeats or restarting after this interruption.

Do not classify every error that day as an outage or bypass order reconciliation.
