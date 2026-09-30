# JEV host-ranked candidate selection prompt

The JEV prompt previously asked whether a fee-inclusive opportunity was
“sufficiently supported” without defining that test. That gave the reviewer a
subjective second gate after the host had already built the eligible candidate
pool, contributing to discretionary HOLD decisions.

The new `jev-host-ranked-choice-v1` rule makes that choice explicit:

- The host remains responsible for hard eligibility, evidence freshness,
  common-window signal agreement, cost, capacity, quote, risk and protection.
- JEV receives the same ordered, eligible candidate list. It selects `q0` by
  default because that is the existing auditable cost/flow rank. It may move to
  the next candidate only when the supplied evidence contains a concrete
  blocker for a higher-ranked option.
- HOLD is reserved for explicit missing, stale, internally inconsistent,
  directly contradictory or named failed-gate evidence across every offered
  candidate. General uncertainty, uncalibrated probabilities, lack of a profit
  guarantee, hypothetical target scenarios or a request for more confirmation
  do not create an extra gate.
- The JEV-only notional/exit context now explains risks without suggesting that
  unproven target geometry is a reason to reject an already eligible entry.

The prompt revision is included in every TypeSafe request as
`reviewerDecisionPolicyVersion=jev-host-ranked-choice-v1`; the untouched request,
response, model/provider identity and selection revision remain in the audit.
The JEV protocol and choice/probability schema are unchanged. Kev prompt text,
host eligibility thresholds, entry signal, costs, risk, native guard, stops,
targets, time limits, goal, historical approvals, fills and losses are unchanged.

This change reduces vague HOLD criteria; it does not guarantee that JEV will
select an entry, increase fills, or improve win rate/net PnL. Continue to assess
future closed fills by original reviewer policy, actual fees/funding and net
PnL; report explicit HOLD details separately from upstream no-candidate and
service/data failures. Synthetic tests check the transmitted prompt and guards,
not live JEV behavior or profitability.
