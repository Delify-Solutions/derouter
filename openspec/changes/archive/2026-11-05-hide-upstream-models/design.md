## Decisions

### D1. One choke point
Every chat endpoint (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, and the Gemini-native route, which calls the same handler) goes through `handleChat`. The handler is split in two:
- the inner part fills a small context: the public name (the model string the customer sent, `[1m]` marker removed), the API key, the combo members, and a `Set` the engine fills with the upstream ids it used;
- the outer part masks the finished `Response` when the key is a customer's and the setting is on.

No engine handler changes its output format.

### D2. What is masked
- **JSON bodies and SSE `data:` events:** `model`, `message.model`, `response.model` and `modelVersion` become the public name, and a top-level `provider` string is dropped.
- **SSE masking:** done line by line in a byte `TransformStream`. A line split across network chunks is held until its newline; `event:` lines, comments and `[DONE]` are untouched.
- **Content is never touched.** A model naming itself inside its own reply cannot be fixed here; the system-prompt route is out of scope.

### D3. Errors
`platformErrorResponse` adds `X-Derouter-Error: platform`, so router decisions (credit, plan limits, key and model denials) keep their customer-facing message. Every other error status is treated as upstream-derived and rebuilt:
- 400/404/422 keep the cleaned explanation. Cleaning removes `[…]` prefixes, the `(reset after …)` suffix, an embedded JSON body (only its inner message is kept), URLs, and hidden ids.
- Size problems (413, or the text matches the size hints of `REQUEST_ERROR_RULES`) become `context_length_exceeded`.
- 401/402/403/407 become `model_unavailable`. The upstream's `invalid_api_key` must never reach a customer, who would think their own key is wrong.
- 408/504 → `model_timeout`; 429 → `model_overloaded`, with `Retry-After` kept; 5xx → `model_error`.
- A combo that ran out of models answers 503 but keeps the cause's `[NNN]:` in the text, so classification uses that inner status.

The HTTP status is never changed.

Hidden ids are the combo members (`provider/model` and the bare model), plus what `chatCore` recorded: the upstream id, the model, `provider/model`, `alias/model`, the provider and the alias. Ids shorter than 3 characters are not scrubbed. Replacement is longest first.

Errors inside a 200 body or a stream event are rebuilt by their text, since there is no status. Texts about the provider account (API key, quota, billing, "no active credentials") read `model_unavailable` whatever the status: Gemini reports a bad key as 400. A 429 is classified before the size hints, so "Request too large … tokens per min" stays a rate limit. The size hints come from the engine's `REQUEST_ERROR_RULES`. Bare host names are removed along with URLs. The public name is inserted with a function replacer, so `$&` in a combo name stays literal.

If the customer check itself throws, the handler masks anyway: it fails closed.

**Errors that become content.** The Responses → chat translator turns an upstream error event into `[Error] <text>` message content, where no response mask can reach it. For a customer key, the chat handler puts an `errorTextFilter` on `clientRawRequest`; `streamingHandler` passes it into the stream state, and the translator runs the text through it. Admin keys have no filter and keep the text.

**Replacement.** Model ids are replaced in one pass with a single alternation regex: longest first, case-insensitive, on whole tokens (not inside a word), and taking any variant suffix (`glm-5.3:pre-0905`). A match after `/` is allowed on purpose, so `models/gemini-2.5-pro` and nested `openrouter/zai/…` are scrubbed; a full `zai/glm-5.3:pre` still wins at its own start. Cloud resource paths (`projects/<id>/…`) are removed with URLs and host names. Replacing them one after another had compounded ("glm-5.3:pre" → "glm-5" → "glm-5-5"). Provider ids are a separate list (`hiddenProviderIds`) and are only removed where they name a provider (`zai/…`, `provider: zai`), because many are ordinary words ("together"). Only the model part of what the customer typed (`openai/<id>` → `<id>`) is exempt from hiding.

**Router 401/403 texts.** The missing/invalid key 401s and the image no-price 403 keep their original text and format; `markPlatform` only adds the platform header. Switching the setting off therefore restores the previous responses byte for byte.

### D4. Combos only
`customerMayCallSync` runs in `handleChat` after key enforcement and after the local bypass. Running after the bypass means Claude Code's naming and warmup requests, sent with its default haiku id, are still answered locally. A refusal is written to the denial log like any platform denial. It is deliberately not in the shared enforcement, because image, TTS, STT and embeddings models are not sold as combos.

### D5. Stored data
`requestDetails` keep the engine's request and response; the router reads them, it does not change what is stored. The public usage API masks them on the way out for customer keys.

The two error paths in `chatCore` now record `requestedModel`, like the success paths. The history and the per-model summary relabel names that are not combos.

### D5b. Embeddings, images, ledger
- `/v1/embeddings` and `/v1/images/generations` wrap their handler with the same mask. The public name is the model asked for; the hidden ids are the provider and model it resolved to, plus the combo members for image combos.
- The credit ledger reads `meta.requestedModel` from `usageHistory`. Customers get only that; the admin also gets `upstreamModel`.

### D6. Switch
`hideUpstreamModels` lives in settings with a default of `true`. It is read from the settings object the handler already loads, and in the receipts routes. Switching it off restores the previous behaviour exactly.
