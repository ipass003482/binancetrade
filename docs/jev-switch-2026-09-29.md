# Kev / Jev reviewer switching

Open http://127.0.0.1:18100/settings. The initial reviewer remains Kev through
the existing local Codex adapter (gpt-6-luna / max). Enter a TypeSafe API key
in the password field, select Save and verify, then select Jev when ready.
Saving a key does not change the reviewer. Select Kev to switch back.

Jev is a hosted service. No local weights or separate model server are needed.
Requests go directly to the official https://api.typesafe.ai/v1/systemone
endpoint with pinned model jev-1.13.0. The original TypeSafe response is retained
alongside clearly labelled host-generated request ID and receipt time.
This is independent from the old local adapter's jev-latest alias, which still
means its Codex backend and is never used for this integration.

## Credentials and switch semantics

Credentials are stored under ignored local/decision-provider/credentials as
Windows DPAPI CurrentUser ciphertext. Plaintext keys only travel through the
same-origin local settings request, private process pipes and the authenticated
official HTTPS request. Keys are not returned by settings APIs, written to
browser storage, included in command-line arguments, sent to Codex, or attached
to trading evidence.

The API-key check uses authenticated GET /v1/models and validates the response.
It does not submit a trade or a paid model decision. It verifies credential
access, not future inference availability, latency, or profitability.
Credential replacement creates a new ID. Already selected credentials remain
unchanged until an explicit switch applies the verified new credential.

One atomically written selection controls both Demo modes. Each new cycle
captures the provider, pinned model and selection revision. A changed selection
between review and bridge admission invalidates that original approval.
Already admitted native plans retain their original approval, costs and exits.
Switches do not restart services, reset the target, close positions or send an
order. There is no silent provider fallback, queued retry or deadline extension.
Invalid credentials, unavailable service, overload, malformed responses, model
mismatch and expired evidence do not grant entry approval.

## Strategy and audit

The coherent common-window flow signal, candidate ranking, balanced selection,
all costs, quote checks, risk, native stops and exits remain unchanged. Jev gets
the same bounded public candidate evidence with equivalent English decision
instructions. No account credentials, balances or unrelated private fields
are sent as model state. Model probabilities are not strategy win rates.

Kev receipts retain kev-codex-entry-v1 / codex-cli. Jev receipts use
jev-typesafe-entry-v1 / typesafe-api / jev-1.13.0 and the selection revision.
The native callback, order context and exchange wire independently bind
snapshot, review, upstream answer, receipt and original policy. A new loaded
native decisionProviders capability is mandatory before any Jev entry.

The active goal is read dynamically. Its additive reviewerPolicy permits
original Jev approvals prospectively from installation; startedAt, deadline,
target, excludedTradeIds, old approvals, fills and losses are retained.
Progress still requires distinct actual filled entry trade IDs and original
valid approval. Test calls, HOLDs and unfilled orders do not count.

## Verification limits

Offline tests use synthetic API replies and simulated order I/O. They verify
integration and rejection paths, not Jev inference quality or profitable fills.
Live Jev inference remains unverified until the user provides a valid key and
chooses Jev. The current live reviewer remains Kev.

Official API documentation: https://docs.typesafe.ai/api

Pinned model documentation: https://docs.typesafe.ai/models
