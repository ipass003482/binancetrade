# Demo spot profit protection — 2026-09-09

User approved changes 1 (profit protection) and 3 (analyst position context),
followed by an automatic restart. This is an experiment, not a proven edge.
No holding-time exit, entry signal, sizing, or futures policy was changed.

## Engine behavior

Only CodexDemoSpot enables native Freqtrade trailing stoploss. Above 0.8%
fee-adjusted profit, it tightens the stop to 0.4% below observed prices and
subsequently only raises it. Before activation the existing -2% stop remains.
The threshold is net profit, not a 0.8% gross price move. Native engine polling
manages this independently of the analyst's 15-minute cycles.

The original ROI table remains 3% initially, 1.5% after 120 minutes and 0.5%
after 360 minutes. ROI, model exits and stoploss may exit first; after six hours
the 0.5% ROI threshold can exit before trailing activates. Stops are local,
not exchange-hosted. Network availability, price gaps and market-order slippage
mean a stop price does not guarantee a fill or profit. Existing positions use
the reloaded rules from then onward, without simulating exits at past highs.

Fresh Demo setup writes the four trailing options via makeEngineConfig.
The existing local Demo config was updated without regenerating authentication
or databases. Disable trailing_stop in that config and reload to roll back
future trailing adjustments; already tightened position stops must not be
silently loosened.

## Analyst context, prompt version 4

Positions now include holding minutes, engine-reported entry fees, estimated
exit fees, engine cost basis, estimated spot break-even price, observed high,
estimated peak net PnL, price drawdown from that high and active stop price.
Break-even = engine open_trade_value / (current amount * (1 - exit fee rate)).
This excludes future slippage and uses the engine's current accounting; it is
not a separate exchange fee ledger. Futures do not use this spot estimate.

Entry reasoning is joined using the journal's entry tag and pair, validated
snapshot UUID, and matching saved proposal. Missing historical reasons remain
null; prose cannot create orders or override instructions. Each cycle persists
the selected context in local/<mode>/runs/<snapshot>.account.json. Raw account
credentials are not included. Existing engine net PnL must not have fees deducted
a second time.

## Validation

- npm test: 81 passed.
- npm run check: 43 syntax files, valid policy.
- npm run test:python: 41 passed, including installed Freqtrade trailing logic
  before/after activation, rising stop and no downward reset.
- npm run test:native: isolated dry-run entry, exit, reconciliation and report
  passed; no real orders. Evidence in local/native-smoke/
  084ea9e0-478a-438c-8e3f-97217a695b69/result.json.

Further validation should compare new trades against the original version,
separating manual exits and fee-adjusted results. No claim of improved future
returns follows from these functional tests.
