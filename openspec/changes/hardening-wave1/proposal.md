## Why

The codebase review (Nov 2026) found problems that cost money or block every
merge soon, all small to fix:

- Six tests mix a fixed date (2026-10-29) with the real clock and fail from
  late November 2026 on every branch.
- A push to `main` publishes the production image even when CI is red.
- Requests are served without a full charge: a cancelled Anthropic-format stream
  is billed one output token; a client that disconnects is never noticed, so the
  upstream call runs on and is charged; Gemini embeddings report no usage and
  are free.
- A payment made inside its window lands in review when the expiry sweep ran
  before the poll that brought it in.
- Failed upstream attempts and denials count toward the customer's RPM, so a
  provider outage turns into customer-facing 429s; queued TPM waits add up.
- The guard compares raw paths while the router decodes them; refusing
  encoded letters/slashes removes the class of bypass outright.

## What Changes

- Tests anchor their fixed times to the real clock.
- `docker-publish.yml` runs `ci.yml` (lint, tests, build) as a required first
  job; `ci.yml` no longer runs on its own for pushes to `main`.
- A cut stream bills the larger of the reported output and the estimate of the
  streamed text (flagged `estimated`).
- The client's abort signal reaches the chat engine, the account/combo loop and
  the TPM wait; an abort is not an account failure and is not error-logged.
- Embeddings without an exact upstream count are billed from an estimate of the
  input, flagged `estimated`.
- Reconciliation approves an `expired` order when the money arrived inside its
  window.
- RPM/TPM count served and client-abandoned (499) requests, not failed upstream
  attempts or denials; the TPM wait budget starts when the request joins the
  queue.
- Reviving an expired order is automatic only when its voucher and monthly
  purchase slot were not taken in the meantime.
- The guard answers 400 to paths that percent-encode unreserved characters,
  `/` or `\`, or contain a raw `\`.
- The admin token statistics count every failed row as an error (they only
  counted the literal status `error`, which no writer uses).

## Capabilities

### Modified Capabilities
- `payment-reconciliation`: an expired order is revived by an in-window payment.
- `api-access-enforcement`: what RPM/TPM count; TPM wait budget; abort; encoded paths.
- `usage-accuracy`: cut streams bill the streamed output; embeddings are never free.
- `upstream-error-handling`: a client disconnect stops the request.
- `error-log`: a client that hung up is not logged.

## Impact

- `test/admin-users-list.test.js`, `test/model-discounts.test.js`
- `.github/workflows/ci.yml`, `.github/workflows/docker-publish.yml`
- `open-sse/utils/stream.js`, `open-sse/utils/usageTracking.js`, `open-sse/utils/embeddingUsage.js` (new)
- `open-sse/executors/base.js`, `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/{nonStreamingHandler,sseToJsonHandler}.js`
- `src/sse/handlers/chat.js`, `src/sse/handlers/embeddings.js`, `src/sse/services/auth.js`, `src/lib/auth/keyEnforcement.js`, `src/lib/errorLog/wrap.js`
- `src/lib/payments/reconcile.js`, `src/lib/db/repos/billingRepo.js` (`purchaseLimitBlockerSync`)
- `src/app/api/v1/responses/compact/route.js`, `src/app/api/v1beta/models/[...path]/route.js`
- `src/lib/db/repos/usageRepo.js`, `src/lib/stats/tokenStats.js`
- `src/dashboardGuard.js`, `src/lib/auth/obfuscatedPath.js` (new)
- No schema change.
