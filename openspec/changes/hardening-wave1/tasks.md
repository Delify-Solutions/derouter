## 1. Process

- [x] 1.1 Anchor `T0` in `test/admin-users-list.test.js` and `test/model-discounts.test.js` to the real clock (D1) ← (verify: whole suite passes with the clock shifted to 2026-11-29, 2027-07-01, 2028-03-01)
- [x] 1.2 `docker-publish.yml` calls `ci.yml`; `build-and-push` needs it; `ci.yml` drops `push: main` (D2)

## 2. Revenue on the proxy

- [x] 2.1 `floorAbortedOutput` in `usageTracking.js`, applied in `finalizeStream("aborted")` (D3); tests for passthrough and translated Anthropic streams, and a complete stream unchanged
- [x] 2.2 `request.signal` into `handleChatCore` and `enforceKeyAccess`; abort short-circuit in the account loop; no account marking on abort; abort-aware TPM wait; error log skips client aborts (D4) ← (verify: on the built server a client that disconnects before the first byte stops the upstream call and is not charged; a normal request is unaffected)
- [x] 2.3 `open-sse/utils/embeddingUsage.js` and its use in `src/sse/handlers/embeddings.js` (D5); `test/embedding-usage.test.js`
- [x] 2.4 Executor and engine classify an abort by the caller's signal state, not the error name (Next aborts with its own reason); executor test in `test/upstream-errors.test.js`

## 3. Payments and limits

- [x] 3.1 `decideSync` revives an expired order paid in its window; `allowExpired` passed to `approveOrderSync` (D6); reconcile tests ← (verify: sweep-then-poll approves once; late or untimed payments still go to review)
- [x] 3.2 RPM/TPM count served rows only; TPM deadline at queue join (D7); `test/tpm-wait-abort.test.js`, RPM test in `test/unbilled-requests.test.js`
- [x] 3.3 Token statistics count every non-served row as an error

## 4. Guard

- [x] 4.1 `src/lib/auth/obfuscatedPath.js` and the 400 at the top of `proxy()` (D8); test in `test/security-hardening.test.js` ← (verify: encoded variants answer 400 on the built server; normal admin, customer and LLM paths unchanged)

## 5. Verify follow-ups

- [x] 5.1 Revival only when the voucher is still active/unheld and the monthly purchase limit allows it (`purchaseLimitBlockerSync`); tests
- [x] 5.2 499 rows count toward RPM/TPM; body-read aborts (non-stream SSE read, SSE-to-JSON) return 499 and record one row; a non-ok answer after the client left is a 499
- [x] 5.3 Error log skips any response of an aborted request; test in `test/error-log.test.js`
- [x] 5.4 TPM: queued requests leave on abort; one last read before a 429; test
- [x] 5.5 `/v1/responses/compact` and `/v1beta` chat pass `request.signal`
- [x] 5.6 Executor resend delay ends on abort; pending counter decremented once; failed attempts detach their abort listener; `test/client-abort.test.js` ← (verify: chat engine against a slow local upstream: 499 within the abort, one upstream hit cancelled, pending +1/−1)
- [x] 5.7 Output floor skipped once the closing count arrived; embedding media items counted; token stats do not count 499 as errors

