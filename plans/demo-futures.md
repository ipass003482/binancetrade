# Demo futures

Scope: user-requested Binance USDT perpetual long/short support, isolated margin, maximum 3x, BTC/ETH/SOL/BNB. Preserve spot and no real-money execution. Owner: [operations](../docs/operations.md).

Decision: a separate `demo-futures` mode (port 18084, local/demo-futures) isolates accounts, configuration and ledgers. Reusing the spot Demo mode would risk interpreting old positions/proposals as contracts. Futures actions are explicit open-long/open-short/close-long/close-short; no hedge/reversal in one action. Keep 50 USDT margin per entry, 50 total margin, 150 entry notional and 150 total notional, existing loss/rate/position limits. No new released-data migration: new mode and separate schema.

- [x] Policy, futures market evidence, schema, risk, execution and reconciliation.
- [x] Guarded Demo futures adapter, strategy, setup and local key entry.
- [x] Analyst and read-only UI support with direction/leverage labels.
- [x] 77 Node tests, 40 native Python contract tests for the futures implementation; the 50-USDT increment additionally passed all 17 targeted futures Python tests; 41-module syntax and policy check; PowerShell credential-entry parser check (not executed). Actual CCXT sync books for all four pairs and 32 async candles passed without keys/orders. Actual CLI setup and runner selection passed. Browser verified futures selection, four contract symbols, sample long/short 3x labels, margin/notional limits, live public quote and truthful missing-key/offline state; 390px mobile dialog has no overflow. Browser error log empty; DOM/interaction verification, no screenshot capture claimed.
- [ ] Credentialed acceptance on destination machine; no keys configured here.

User selected 3x and requested BTC, ETH, SOL, BNB. Public Demo exchangeInfo confirms all four PERPETUAL/TRADING. Earlier user instruction limits further order testing on this computer: no engine order smoke or scheduler is authorized for this increment. Keep feature branch uncommitted/unpushed during iteration.

No native order smoke or model-generated futures proposal was run in this increment. No exchange credentials were read. No scheduler is running. Local read-only dashboard remains on port 18100.
