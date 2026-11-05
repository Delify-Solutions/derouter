## 1. Masking core

- [x] 1.1 `src/lib/models/publicModel.js`: hidden ids, field mask, SSE line/stream mask, error rebuild, stored-payload mask
- [x] 1.2 `src/lib/models/customerModels.js`: switch, customer-key check, combos-only, mask context

## 2. Wiring

- [x] 2.1 `chat.js`: split handler, mask customer responses, refuse non-combo models for customer keys
- [x] 2.2 `chatCore.js`: record upstream ids; error rows keep `requestedModel`
- [x] 2.3 `platformError.js`: `X-Derouter-Error: platform` marker
- [x] 2.4 Public usage API: drop `resolvedModel`, mask stored payloads, relabel non-combo names in history and summary
- [x] 2.5 Setting `hideUpstreamModels` (default on) and the Endpoint page switch

## 3. Follow-up from /verify

- [x] 3.1 Ledger: combo name for customers, both for the admin
- [x] 3.2 Stored error rows rebuilt like live errors; provider prefix hidden; "no credentials" and provider-account texts → `model_unavailable` at any status
- [x] 3.3 Errors inside 200 bodies and streams rebuilt (no upstream code or metadata); 200 text bodies untouched; host names removed; literal replacer
- [x] 3.4 Combos-only after the bypass, with a denial log entry; mask fails closed
- [x] 3.5 Embeddings and image generation masked for customer keys

## 4. Second /verify follow-up

- [x] 4.0a Responses error → chat text passes through the customer's `errorTextFilter` (translator state); top-level `{type:"error"}` events rebuilt
- [x] 4.0b One-pass whole-token id replacement; provider ids kept apart and removed only as `provider/` or `provider: X`
- [x] 4.0c Router 401 (missing/invalid key) and the image "no per-image price" 403 platform-marked
- [x] 4.0d Admin ledger shows combo and upstream model; `/account/usage` shows combo names only
- [x] 4.0e Narrower provider-account hints; any `json` content type; image wrapper checks the key first

## 5. Check

- [x] 5.1 `test/model-privacy.test.js`: formats, SSE split across chunks, error rewording and codes, platform marker, combos-only, admin keys untouched
- [x] 5.2 Live run against a mock upstream: OpenAI JSON/stream, Claude stream, Responses, upstream 400 through a combo, public receipts with raw payloads (customer: no upstream id anywhere; admin: unchanged)
- [x] 5.3 `npm test`, `npm run lint`, `npm run build` ← (verify: no upstream id or provider id reaches a customer key on any path above; admin keys unchanged)
