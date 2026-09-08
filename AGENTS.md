# Binance trade
Independent Windows-native Binance spot and isolated USDT perpetual research / Demo project. No Docker.
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
