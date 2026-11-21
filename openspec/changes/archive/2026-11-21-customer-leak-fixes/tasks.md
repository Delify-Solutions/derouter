## 1. Request details

- [x] 1.1 `generateDetailId` in `src/lib/db/repos/requestDetailsRepo.js` drops the model part (D1)
- [x] 1.2 Opaque detail id (now `src/lib/crypto/sealedIds.js`, see 7.2); scrub/lookup moved to `src/lib/usage/publicRequestDetails.js` (testable); `/api/usage/key/receipts/detail` returns no `connectionId` and an opaque `id` for a customer key, and resolves `?id=` by that id or a timestamp (D1)

## 2. Response mask

- [x] 2.1 `createSseMaskStream` / `maskResponse`: an SSE-typed body starting with `{` or `[` is buffered (capped at `STREAM_MAX_BUFFER_BYTES`) and masked as a JSON document or JSON lines; error status rebuilt by `maskErrorBody`; overflow fails closed (D2)
- [x] 2.2 `maskModelFields`: provider-identifying fields removed, usage allow-listed per format, chat/Claude/Gemini ids rewritten consistently per response, Responses and tool-call ids untouched; `maskJsonText` masks top-level arrays (D5)

## 3. Paths around the mask

- [x] 3.1 `src/lib/auth/apiKeyExtract.js` shared by `dashboardGuard.js`, `src/sse/services/auth.js` and the Gemini route (D4)
- [x] 3.2 Gemini native TTS refuses a customer key (`refuseCustomerEndpointSync` / `refuseCustomerEndpoint`) (D3)

## 4. Catalogs and settings

- [x] 4.1 `/api/usage/key` `allowedModels` holds combo names only for a customer key (D6)
- [x] 4.2 `/api/settings/require-login` drops `tunnelUrl` / `tailscaleUrl` (D6)
- [x] 4.3 `/v1beta/models` lists combos only for a customer key; `/v1/models/info` answers 404 to a customer key (D6)
- [x] 4.4 `/v1/audio/voices` refuses a customer key; `buildModelPriceList` drops `modelsCount` (D6)

## 5. Verification

- [x] 5.1 `test/customer-leak-fixes.test.js` covers every finding (relative imports, temp `DATA_DIR`)
- [x] 5.2 `npm test`, `npm run lint`, `npm run build` pass; `openspec validate customer-leak-fixes --strict` passes

## 6. Verify round 1

- [x] 6.1 CRITICAL-1: `open-sse/utils/responseIds.js` `newResponseId()`; the Responses stream translator, the Codex transform stream, both non-stream converters and the translator state use router ids; item ids derive from them; tool-call ids kept (D7)
- [x] 6.2 WARNING-1: `prompt_tokens_details.cache_creation_tokens` allowed; allow-lists audited against every router-emitted usage field (D5)
- [x] 6.3 WARNING-2: non-JSON / broken-JSON `data:` lines scrubbed with `scrubUpstreamText`; proxy-transparency delta updated (D8)
- [x] 6.4 WARNING-3: image-generation usage allow-listed and provider fields stripped; embeddings detection widened (D5)
- [x] 6.5 WARNING-4: detail ids sealed (`sealId` / `openSealedId`) and looked up by primary key + `apiKey` (`getRequestDetailForKey`, `lookupDetail`) (D1)
- [x] 6.6 Suggestions: D2 documents buffered arrays/NDJSON; `/v1/audio/voices` calls the voices handlers in-process (no network, no 401); `/v1beta/models/[...path]` catch answers a generic message and logs the detail; a BOM never hides a line (D2, D3, D6, D8)
- [x] 6.7 Behavioural route tests in `test/customer-leak-routes.test.js` (route handlers loaded through `test/helpers/src-alias-hook.mjs` + new `test/helpers/next-server-hook.mjs`); source-text checks removed except the guard's import (the guard cannot load in plain Node)

## 7. Verify round 2

- [x] 7.1 W1: the customer SSE mask works per event (`createSseEventMasker` / `maskSseEvent` / `maskSseText`): multi-line data joined, JSON masked once, only non-JSON scrubbed, other lines and terminators kept, per-event cap fails closed (D8)
- [x] 7.2 W2 + W3: sealed ids move to `src/lib/crypto/sealedIds.js`: fixed 256-byte padding (every id 379 chars, too-long values fall back to the timestamp), keys from a dedicated random `DATA_DIR/auth/sealed-id-secret` (0600, atomic create), `secrets.js` restored unchanged (D1)
- [x] 7.3 `/v1/audio/voices` serves only a valid admin key; keyless and unknown keys get 401 whatever `requireApiKey` says (D6)
- [x] 7.4 Image stream events (`image_generation.*`, `image_edit.*`) allow-listed, `output_tokens_details` kept (D5)
- [x] 7.5 Design/spec: D2 buffering risk, known gap for Responses-format upstream ids, D7 `previous_response_id` wording
- [x] 7.6 Tests: multi-line JSON / text events, chunk boundaries mid-line and mid-event, CRLF, per-event cap, stored SSE, image events, equal sealed-id lengths, wrong purpose, deterministic forged id, secret file, second customer key, voices keyless/unknown

## 8. Verify round 3

- [x] 8.1 C1: the SSE mask releases data as soon as it is complete (JSON bracket scan, text at once, pending data on `event:` / blank / end), never waits for a blank line; per-line fallback masks JSON lines as JSON; the cap fails one value closed and the stream goes on; stored copies through the same masker (D8)
- [x] 8.2 W3: the sealed-id secret is created with `O_EXCL` on the final path and read back from disk by every process; invalid files replaced and re-read (D1)
- [x] 8.3 S1: SSE `id:` lines scrubbed of hidden ids and hosts for customer keys (D8)
- [x] 8.4 Design D2/D8 and the model-privacy wording describe the release rule and the split-value lag
- [x] 8.5 Timing tests (released in the same step for blank-less `data:` lines, Anthropic pairs, keepalive comments, standard streams), split JSON across chunks, overflow on blank-less and standard streams, complete over-cap line, stored blank-less copy, per-line JSON fallback, `id:` lines, concurrent secret creation

## 9. Verify round 4

- [x] 9.1 C1: `truncateField` keeps a string `model` as its own field beside the cut preview; `maskStoredResponse` never returns `_preview` to a customer key; stored strings are masked as JSON when they are JSON documents (D1, D8)
- [x] 9.2 W1: incremental JSON grammar check (`src/lib/models/jsonPrefix.js`); data that can no longer become JSON is released at once line by line and the offending line starts afresh (D8)
- [x] 9.3 W2: the drop after an overflow follows the dropped value with the grammar and ends exactly where it does; no fragment is released; `scrubUpstreamText` also covers quoted JSON forms (`scrubJsonForms`) (D8)
- [x] 9.4 W3 + S1: joined line indexes in a `Set`; lines cut from each new chunk only (D8)
- [x] 9.5 S3: bare JSON string data kept as upstream text, justified in D8; S5: sealed-id secret published by hard link of a complete temp file, never-rewritten slots, half-written slots waited for (D1)
- [x] 9.6 Tests: `test/customer-leak-sse.test.js` (grammar, escapes/brackets in strings, never-closing line, text and split values after an overflow, nested-valid line inside a dropped value, quoted-form scrub, 200k-line and 3.5 MiB-line cost, partition fuzz for OpenAI/Claude/Gemini streams), truncated chat/Responses requests, stored JSON with "data:", corrupted and stalled secret creation

## 10. Verify round 5

- [x] 10.1 W1: a half-written sealed-id slot is waited for only while young by mtime (< 1 s, wait bounded by its youth); older empty/short slots are skipped at once (D1)
- [x] 10.2 S1: a bare JSON string payload is parsed, scrubbed and re-quoted, staying valid JSON (D8)
- [x] 10.3 S2: one `console.warn` (no secret) when the sealed-id secret falls back to memory (D1, Risks)
- [x] 10.4 S3: D8 states that a line over the cap from a network stream fails closed
- [x] 10.5 Tests: old empty slot skipped fast and agreed across processes on every start; young stalled slot still waited for; in-memory fallback warns once; bare JSON string with a URL stays valid
