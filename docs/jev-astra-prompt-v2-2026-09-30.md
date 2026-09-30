# Astra-reviewed JEV selection prompt v2

The v1 prompt called every offered q candidate the top-ranked default. With
multiple candidates that contradicted the host's q0-first instruction. V2 gives
q0 a unique first-priority criterion and later candidates an ordered fallback
criterion. HOLD still requires a concrete blocker for every offered candidate.

The context now distinguishes intentionally partial recent tape samples from
full-window metrics, intentional null forecast fields from missing required
inputs, rejected-candidate diagnostics from offered candidates, and negative
unchanged-quote cost scenarios or harvest geometry from failed eligibility.
It applies only declared validity/freshness constraints and accounting bases.
Choice probabilities are selection outputs, not profitable-trade probabilities.

This implements the requested gpt-6-astra audit in
local/jev-astra-prompt-audit-2026-09-30/. Only the JEV prompt branch and its
regression tests change. The Kev prompt, candidate rank, hard eligibility,
fee models, risk limits, native exits/protection, active goal and historical
evidence remain bound to their existing policies. No manual order is needed
for deployment. Native engines stay running during the host-only reload.

Validation and source fingerprints are recorded in
local/jev-astra-prompt-v2-2026-09-30/checks.json. Deployment and fresh original
request evidence are recorded in that directory as they are verified. Offline
tests use mocked network/account/order I/O and do not establish model behavior
or improved profitability. Actual future filled closes, after fees and funding,
must be evaluated by their original request version and source fingerprint.
Do not treat more entries or a lower HOLD rate as evidence of a higher win rate.

Primary response-contract reference:
https://docs.typesafe.ai/primitives/choice
