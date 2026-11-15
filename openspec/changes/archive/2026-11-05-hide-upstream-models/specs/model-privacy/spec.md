## Purpose

Customers buy combos. This capability keeps the upstream model behind a combo, and the provider serving it, out of everything a customer key can call, receive or read.

## ADDED Requirements

### Requirement: One switch, customer keys only
A setting `hideUpstreamModels` (default `true`) SHALL govern this capability, editable from the admin Endpoint page ("Ẩn model gốc với khách"). It SHALL apply only to keys that belong to a customer account. Admin keys and keyless local use SHALL receive the engine's output unchanged. Turning the setting off SHALL restore the previous behaviour.

#### Scenario: Admin key unchanged
- **WHEN** an admin key calls combo `glm-5`
- **THEN** the response carries the upstream's own `model` value and error text

### Requirement: Customers call combos only
With the setting on, a customer key SHALL be able to call a chat endpoint only with the name of a combo. Any other model string SHALL be refused with HTTP 403, code `model_not_allowed`, before any upstream is contacted. Non-chat endpoints (images, speech, embeddings) SHALL keep their existing model rules.

#### Scenario: Upstream id refused
- **WHEN** a customer key calls `/v1/chat/completions` with `zai/glm-5.3:pre`
- **THEN** the response is 403 `model_not_allowed` and no upstream request is made

### Requirement: Responses name the combo
For a customer key, every chat response SHALL name the model the customer asked for: the top-level `model` (OpenAI bodies and chunks, Claude messages), `message.model` (Claude `message_start`), `response.model` (Responses API events) and `modelVersion` (Gemini). This SHALL hold for JSON bodies and for every event of a stream, including events split across network chunks. A top-level `provider` field SHALL be removed. Message content SHALL NOT be changed.

#### Scenario: Streamed OpenAI reply
- **WHEN** a customer key streams combo `glm-5` and the upstream's chunks carry `"model":"glm-5.3:pre"`
- **THEN** every chunk the customer receives carries `"model":"glm-5"`

#### Scenario: Claude and Responses formats
- **WHEN** the same combo is called through `/v1/messages` or `/v1/responses`
- **THEN** `message.model` and `response.model` read `glm-5`

### Requirement: Errors never name the upstream
For a customer key, on the chat endpoints, `/v1/embeddings` and `/v1/images/generations`:
- An error the router itself decided SHALL keep its message.
- Every other error SHALL be returned as `{ error: { message, type, code } }` only, with no other fields.
  - A request problem (status 400, 404 or 422, or the status inside a combo's error text) SHALL keep its explanation, without `[…]` prefixes, URLs, model ids or provider ids.
  - A size problem SHALL read code `context_length_exceeded`.
  - An upstream authentication or quota failure SHALL read `model_unavailable`. This covers 401, 402, 403 and 407, and any status whose text is about the provider account: an API key, quota, billing, or "no active credentials".
  - A timeout (408, 504) SHALL read `model_timeout`.
  - A rate limit (429) SHALL read `model_overloaded` and keep `Retry-After`.
  - Any 5xx SHALL read `model_error`.
  - Each of these SHALL carry a Vietnamese message.
- The HTTP status SHALL be unchanged.
- An error carried inside a 200 body or a stream event SHALL be rebuilt the same way, classified by its text. This includes a top-level `{type:"error"}` event and an upstream error a translator turns into message text.
- Replacing an id SHALL happen in one pass on whole tokens, so a replaced name is never replaced again. Provider ids SHALL be removed only where they name a provider (`provider/…`, `provider: …`), never inside ordinary words.
- An authentication refusal of the customer's own key SHALL keep its message.

#### Scenario: Provider key failure
- **WHEN** the upstream answers 401 "Incorrect API key provided … platform.openai.com"
- **THEN** the customer receives 401 with code `model_unavailable` and a message naming neither the provider nor a key

#### Scenario: Combo member list hidden
- **WHEN** every member of a combo fails
- **THEN** the customer's error body has no `cycleGuard` (or any other) field besides `error`

#### Scenario: Provider key reported as 400
- **WHEN** an upstream answers 400 "API key not valid. Please pass a valid API key."
- **THEN** the customer receives code `model_unavailable`, not a message about a key

#### Scenario: Request problem explained
- **WHEN** the upstream rejects the request with 400 "max_tokens too large for glm-5.3:pre" inside a combo
- **THEN** the customer reads "max_tokens too large for glm-5" with code `invalid_request`

### Requirement: Usage data never shows the upstream model
For a customer key, neither the public usage API (`/api/usage/key/receipts` and `/receipts/detail`), the customer credit ledger (`/api/account/ledger`) nor the account usage page (`/account/usage`) SHALL return the upstream model: no `resolvedModel` and no `upstreamModel`, and every model shown SHALL be the combo name. Stored request and response payloads, when requested, SHALL be masked as in "Responses name the combo"; a stored error SHALL be rebuilt as in "Errors never name the upstream". The admin ledger SHALL show the combo name and the upstream model. Error rows SHALL record the combo name like success rows. A row without a recorded combo name SHALL show "—" in the history and be grouped under "Khác" in the per-model summary.

#### Scenario: Raw payloads
- **WHEN** a customer key reads its receipts with `includeRaw=1`
- **THEN** no field of the response contains `glm-5.3:pre` or the provider id

#### Scenario: Ledger
- **WHEN** a customer opens Nhật ký credit after calling `glm-5`
- **THEN** the charge row reads `glm-5`
