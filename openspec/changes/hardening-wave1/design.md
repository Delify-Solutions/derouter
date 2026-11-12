## Context

Findings come from the four-area review (billing, health, proxy, security). Each
item here is a root-cause fix that does not need a schema change.

## Decisions

### D1. Test clocks
`T0 = floor(now to the hour) − 8 days` replaces `Date.UTC(2026, 9, 29, 10)`. The
code under test compares stored times with `Date.now()`, so fixtures must move
with it. Verified by running the whole suite with a shifted clock (late 2026,
2027, 2028).

### D2. CI gates the image
`ci.yml` gains `workflow_call`; `docker-publish.yml` calls it as job `ci` and
`build-and-push` needs it. `ci.yml` keeps `pull_request` (the PR checks) and
drops `push: main` to avoid a duplicate run. Tags and manual dispatch are gated
the same way. Branch protection on `main` is a repository setting, applied
outside the code.

### D3. Cut streams
`finalizeStream("aborted")` raises the output side to
`max(reported, estimateOutputTokens(streamed text))` and flags the row
`estimated` when the estimate wins (`floorAbortedOutput`), unless the closing
count already arrived (`isClosingUsageChunk`). Input and cache
figures stay as reported. A normal close keeps the upstream's numbers. This
covers Anthropic (`message_start` says `output_tokens: 1`) and any upstream that
reports partial usage before the end.

### D4. Client abort
`request.signal` is passed to `handleChatCore` (`requestSignal`, already wired
to the upstream fetch) and to `enforceKeyAccess`. The account loop returns 499
without trying another account or combo member when the signal is aborted, and
an aborted attempt never marks the account unavailable. The TPM wait returns a
`clientGone` result that `enforceKeyAccess` turns into a bare 499 without a
denial row. The error-log wrapper skips any response whose request signal is
aborted (a fusion or combo may settle on 503). The executor's resend delay ends
on abort; a non-ok answer seen after the client left (resend, token refresh) is
a 499. Aborts during a body read return 499 (also on the SSE-for-JSON path) and
record a 499 row. The pending counter is decremented once per attempt. The abort
listener of a failed attempt is removed (`handleChatCore` wraps the attempt), so
long fallbacks do not pile listeners on one signal. `/v1/responses/compact` and
the `/v1beta` chat route pass `request.signal` into the Request they rebuild.

Next aborts a disconnected request's signal with its own reason, so `fetch`
rejects with that reason rather than an `AbortError`. Found on the built
server: the executor took it for a network error and retried for ~10 s, then
the engine answered 502. The executor and the engine therefore treat "the
caller's signal is aborted" as the abort test, not the error's name.

### D5. Embeddings
`embeddingUsage(raw, input)`: the exact upstream count when `prompt_tokens > 0`
and no completion (a missing `total_tokens` is accepted), otherwise an estimate
from `input` (string, string array, token-id array, token-id arrays), flagged
`estimated`; nothing for an empty input.

### D6. Expired orders
`decideSync` treats an `expired` order like a pending one when the transaction's
`occurredAt` is at or before `expiresAt`; the decision carries `allowExpired` and
`approveOrderSync` (which already supports it for admin assignment) re-checks the
status inside the write. Without `occurredAt` the admin decides. Same rule for
webhook, poll and dry run.

Expiry released what the order held: its voucher could be taken by another
order and its monthly purchase slot reused. Revival is automatic only when the
voucher is still active and not held elsewhere and `purchaseLimitBlockerSync`
(extracted from `planPurchaseBlocker`, counted in the order's month) allows it;
otherwise the transaction goes to review as `order_expired`.

### D7. What rate limits count
Served and abandoned rows: `COALESCE(status, 'ok') IN ('ok', 'success', '499')`
(chat writes `ok`; embeddings, images and the Gemini route write `success`;
failures write the HTTP status). An abandoned request (499) reached the upstream,
which was already working on it; counting it keeps a connect-and-hang-up loop
held to the rate, since such a request is not billed. Every abort path records
exactly one 499 row (before headers, during a body read, after a resend), so the
count is complete. Applies to per-user and per-key RPM/TPM and to the oldest-row
lookup of the TPM wait. The TPM deadline is computed when the request joins the
queue, so N queued requests all give up within one budget; a request reaching
the front after its deadline reads once more before a 429; a queued request
leaves as soon as its client does.

Trade-off: a client whose requests all fail upstream is no longer slowed by RPM.
Those requests are not billed and cost the upstream little; a provider outage
no longer locks customers out.

### D8. Encoded paths
`isObfuscatedPath` matches `%3X` digits, `%41–%5A`/`%61–%7A` letters, `%2D %2E
%2F %5C %5F %7E`, and a raw backslash. Standard clients never send these; the
guard answers 400 before any rule. Spaces, Vietnamese text, `%25` and `:` stay
valid. On the real standalone server the reported bypass returned 404, so this is
defence in depth that does not depend on router internals.

## Risks

- D4 relies on Next aborting `request.signal` on client disconnect and not on a
  normal finish; verified on the built standalone server.
