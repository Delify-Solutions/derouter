## Why

Customers buy combos ("glm-5"). The upstream model behind a combo (e.g. `glm-5.3:pre`) and the provider serving it are the operator's business, but a customer could see both:
- the `model` field of every response, streamed or not, came straight from the upstream;
- upstream error texts named the model, the provider id (`[openai-compatible-…/glm-5.3:pre]`) and provider URLs;
- error bodies carried a `cycleGuard` field listing the combo's members;
- the public usage API returned `resolvedModel` and the stored request/response;
- a group with no allow-list let a customer key call `provider/model` directly.

## What Changes

- A setting `hideUpstreamModels` (default on), with a switch on the admin Endpoint page. Admin keys and keyless local use are never affected.
- **Combos only:** on the chat endpoints a customer key may call only a combo name; anything else is refused with 403 `model_not_allowed`. `/v1/models` already listed combos only.
- **Responses name the combo:** the chat handler rewrites, for customer keys, the model fields of JSON bodies and of every SSE event to the name the customer asked for: `model`, `message.model`, `response.model` and `modelVersion`. An aggregator's top-level `provider` field is dropped. Message content is never touched.
- **Errors:**
  - A denial the router decided (marked with an `X-Derouter-Error: platform` header) keeps its message.
  - An upstream error is rebuilt as `{ error: { message, type, code } }`. Request problems keep the explanation, with prefixes, URLs and hidden ids removed. Provider-side problems (auth, quota, rate, timeout, 5xx) get a fixed Vietnamese sentence and a neutral code (`model_unavailable`, `model_overloaded`, `model_timeout`, `model_error`, `context_length_exceeded`).
  - A combo's 503 is classified by the status inside its text.
- **Embeddings and image generation** get the same response mask for customer keys. Their errors read "[provider/model] …" otherwise; the combos-only rule does not apply to them.
- **Customer credit ledger:** charge rows name the combo (`usageHistory.meta.requestedModel`), never `usageHistory.model`. The admin ledger shows both.
- **Public usage API:**
  - `resolvedModel` is no longer returned to customer keys.
  - Stored raw request/response payloads are masked.
  - Error rows now record the combo name (`requestedModel`), as success rows already did.
  - Rows older than that read "—" in the history and "Khác" in the per-model summary.
- **BREAKING for customers who called upstream ids directly:** those calls now get 403 while the setting is on.

## Capabilities

### New Capabilities
- `model-privacy`: what a customer may call and see of the models behind combos.

### Modified Capabilities
- `proxy-transparency`: byte-for-byte forwarding gains one exception: the model fields and errors of a response to a customer key, per model-privacy.

## Impact

- **Code:**
  - `src/lib/models/publicModel.js` and `customerModels.js` (new);
  - `src/sse/handlers/chat.js` (mask + combos-only), `open-sse/handlers/chatCore.js` (records upstream ids; error rows keep requestedModel);
  - `src/lib/auth/platformError.js` (marker header);
  - `/api/usage/key/receipts` and `/receipts/detail`, `accountPlansRepo.getAccountLedgerSync` and `/api/account/ledger`;
  - `src/sse/handlers/embeddings.js`, `src/sse/handlers/imageGeneration.js`;
  - `settingsRepo` (default) and the Endpoint page switch.
- No schema change.
