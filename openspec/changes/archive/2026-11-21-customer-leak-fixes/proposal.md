## Why

An audit of what a customer key or session can read found eight places where the
upstream behind a combo still reaches the customer, although model-privacy promises
that a customer never learns the upstream model, the provider or account serving it,
the operator's cost price or internal error text. Some leak on every request
(provider-specific response fields, usage extras with the operator's cost), others
open a path around the protection entirely (a key sent as `?key=`, the Gemini native
TTS route).

## What Changes

- Request details shown to a customer carry no `connectionId`; each row gets an
  opaque id that reveals nothing. New detail ids no longer embed the upstream model.
- A JSON document answering a streamed request (forwarded with SSE headers) is masked
  as a JSON document for a customer key: model fields, provider fields and errors,
  exactly like the JSON path, within the existing retained-copy cap.
- The Gemini native TTS path (`/v1beta/models/<tts-model>:generateContent`) refuses a
  customer key up front with a platform denial, like the other TTS/STT/search/fetch/video
  endpoints. Admin keys are unchanged.
- One API-key extractor (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`,
  `?key=`, in that order) is shared by the guard and every handler, so a key the guard
  accepted is never treated as "no key" by the handler.
- For a customer key, chat responses (JSON and every SSE event shape) lose
  provider-identifying fields (`system_fingerprint`, `x_groq`, `native_finish_reason`,
  Azure filter results) and keep only the standard usage fields of their format (drops
  OpenRouter `cost`/`cost_details`/`is_byok`, DeepSeek cache hit/miss counts, Vertex
  `trafficType`, ...). Chat-completion ids, Claude message ids and Gemini response ids
  become a router-generated id, the same for every chunk of one response. Responses
  API ids and tool-call ids are not touched. Message content never changes.
- Responses objects the router builds itself (a Responses client on a non-Responses
  upstream) get a router-owned `resp_<random>` id, with item ids derived from it, for
  every caller: they used to embed the upstream's id (`resp_gen-…`, `resp_msg_bdrk_…`).
- Non-JSON `data:` lines of a customer stream are scrubbed like error messages; image
  generation usage is allow-listed; the router's own cache-write count stays visible.
- `/api/usage/key` returns only combo names in `allowedModels` for a customer key.
- The unauthenticated `/api/settings/require-login` no longer returns `tunnelUrl` or
  `tailscaleUrl`.
- For a customer key, `/v1beta/models` lists combos only and `/v1/models/info` reveals
  no built-in catalog entry; `/v1/audio/voices` refuses a customer key (TTS is closed to
  them) and reads the voices in-process instead of fetching the caller's Host; the
  price list no longer sends `modelsCount`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-privacy`: responses also lose provider-identifying fields and non-standard
  usage, ids are router-generated, an SSE-typed JSON document is masked; usage data
  carries no connection id; new requirements for provider-native paths, catalog
  listings and unauthenticated settings.
- `proxy-transparency`: the customer-key exception of the byte-for-byte stream and JSON
  requirements now covers the provider fields, usage extras, ids and non-JSON data
  lines; new requirement for router-owned Responses ids.
- `api-access-enforcement`: one key extraction shared by the guard and the handlers.

## Impact

- `src/lib/models/publicModel.js` (mask), `src/lib/models/customerModels.js`
- `src/lib/auth/apiKeyExtract.js` (new), `src/dashboardGuard.js`, `src/sse/services/auth.js`
- `src/lib/auth/unmeteredEndpoints.js`, `src/lib/crypto/sealedIds.js` (new; `secrets.js` unchanged)
- `src/lib/db/repos/requestDetailsRepo.js`
- New pure modules (testable without the `@/` alias): `src/lib/usage/publicRequestDetails.js`
  (detail scrub/lookup, moved out of the route), `src/lib/auth/publicSettings.js`,
  `src/lib/models/geminiModelList.js`
- Engine (D7): `open-sse/utils/responseIds.js` (new), `open-sse/translator/index.js`,
  `open-sse/translator/response/openai-responses.js`,
  `open-sse/transformer/responsesTransformer.js`,
  `open-sse/handlers/chatCore/nonStreamingHandler.js`,
  `open-sse/handlers/chatCore/sseToJsonHandler.js`
- `src/lib/models/jsonPrefix.js` (new: incremental JSON grammar check for the SSE mask)
- `test/customer-leak-fixes.test.js`, `test/customer-leak-routes.test.js`,
  `test/customer-leak-sse.test.js`,
  `test/helpers/next-server-hook.mjs`
- Routes: `src/app/api/usage/key/receipts/detail/route.js`, `src/app/api/usage/key/route.js`,
  `src/app/api/settings/require-login/route.js`, `src/app/api/v1beta/models/route.js`,
  `src/app/api/v1beta/models/[...path]/route.js`, `src/app/api/v1/models/info/route.js`,
  `src/app/api/v1/audio/voices/route.js`
- `src/lib/models/priceList.js`
- Admin keys and keyless local use: unchanged, except that the handlers now also read a
  key sent as `x-goog-api-key` or `?key=` (the guard already did).
- No schema change, no billing or pricing change.
