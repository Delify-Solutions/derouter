## MODIFIED Requirements

### Requirement: Responses name the combo
For a customer key, every chat response SHALL name the model the customer asked for: the top-level `model` (OpenAI bodies and chunks, Claude messages), `message.model` (Claude `message_start`), `response.model` (Responses API events) and `modelVersion` (Gemini, also under `response` for Gemini CLI clients). This SHALL hold for JSON bodies and for every event of a stream, including events split across network chunks and a first line preceded by a byte-order mark, and for a JSON document, JSON array or sequence of JSON lines the upstream returned to a streamed request (sent with SSE headers), which SHALL be held and masked as a document (each line on its own for JSON lines). Such a document larger than the retained-copy cap (`STREAM_MAX_BUFFER_BYTES`) SHALL be replaced by a `model_error` error instead of being forwarded unmasked. An event whose data spans several `data:` lines SHALL be read as SSE defines it (its data lines joined with a line break): when the joined data is JSON it SHALL be masked once as JSON, with its content unchanged; only data that is not JSON (or is broken JSON) SHALL have URLs, host names, cloud resource paths and hidden model and provider ids removed, as in an error message. `event:` and comment lines and `[DONE]` SHALL pass unchanged; an `id:` line SHALL have hidden ids and host names removed. The mask SHALL NOT wait for the blank line that ends an event, which many upstreams never send: a data line SHALL be released as soon as its data is complete (not JSON-shaped, `[DONE]`, or a complete JSON value by the JSON grammar), lines without data SHALL be released at once when no data is pending, and data still pending SHALL be released when an `event:` line, a blank line or the end of the stream arrives. Only the first lines of a JSON value split over several data lines are held. When the held data can no longer become valid JSON by the grammar, the held lines SHALL be released at once one by one (a line that is JSON masked as JSON, the rest scrubbed as upstream text) and the line that made it impossible SHALL be treated as the start of the next data. Data pending beyond the retained-copy cap, or one line still arriving beyond it, SHALL be replaced by one `model_error` line; every further line of that value SHALL be dropped, the drop ending exactly where the value ends by the grammar, or at a line that cannot continue it, a blank line or an `event:` line; no fragment of a dropped value SHALL be released, and the stream SHALL go on. Upstream text released this way SHALL also lose quoted provider fields (`"provider":…`, `"system_fingerprint":…`, usage extras), name the combo in quoted `model` values and carry router ids for provider-prefixed response ids. A bare JSON string as data is not content in the chat protocols and is scrubbed as upstream text, staying a valid JSON string.

A response SHALL also carry nothing that identifies the provider:
- a top-level `provider` string, `system_fingerprint`, `x_groq` and `prompt_filter_results`, and `native_finish_reason` and `content_filter_results` inside each choice, SHALL be removed;
- each usage object SHALL keep only the standard fields of its format, as numbers: OpenAI chat `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details` (`cached_tokens`, `cache_creation_tokens`, `audio_tokens`), `completion_tokens_details` (`reasoning_tokens`, `audio_tokens`, `accepted_prediction_tokens`, `rejected_prediction_tokens`) and the router's own `cached_tokens` / `reasoning_tokens`; Claude `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation` and `server_tool_use`; Responses `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`; Gemini `usageMetadata` token counts and their modality details; embeddings `prompt_tokens`, `total_tokens`; image generations and edits, as JSON bodies and as `image_generation.*` / `image_edit.*` stream events, `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details` and `output_tokens_details` (`text_tokens`, `image_tokens`). Every figure the router itself reports (cache reads and cache writes included) SHALL stay; provider extras such as a cost, a BYOK flag or provider-specific cache counters SHALL NOT reach the customer;
- the chat-completion `id`, the Claude message `id` and the Gemini `responseId` SHALL be replaced by an id the router generates, the same in every chunk and event of one response.

The Responses ids of a Responses-format upstream (`response.id`, item ids) and every tool-call id SHALL NOT be changed. Message content SHALL NOT be changed. Known gap: a Responses-format upstream's own ids reach the customer as the upstream wrote them (the client hands them back as `previous_response_id`, which the router forwards to that upstream), so a provider-specific id prefix there is not hidden.

#### Scenario: Streamed OpenAI reply
- **WHEN** a customer key streams combo `glm-5` and the upstream's chunks carry `"model":"glm-5.3:pre"`
- **THEN** every chunk the customer receives carries `"model":"glm-5"`

#### Scenario: Claude and Responses formats
- **WHEN** the same combo is called through `/v1/messages` or `/v1/responses`
- **THEN** `message.model` and `response.model` read `glm-5`

#### Scenario: Aggregator extras
- **WHEN** an upstream chunk carries `"id":"gen-123"`, `"provider":"Fireworks"`, `"system_fingerprint":"fp_x"`, `native_finish_reason` in its choice and `usage` with `cost`, `is_byok` and `prompt_cache_hit_tokens`
- **THEN** the customer's chunk has a router-generated `id`, none of those fields, and `usage` with only the standard token counts

#### Scenario: One id per streamed response
- **WHEN** a customer key streams a reply of 20 chunks
- **THEN** all 20 chunks carry the same router-generated `id`, and every tool-call id is the upstream's

#### Scenario: JSON document answering a stream
- **WHEN** a customer key asks for `stream: true` and the upstream answers with one JSON document carrying `"model":"glm-5.3:pre"` and `"provider":"zai"`
- **THEN** the customer receives that document with `"model":"glm-5"` and no `provider`

#### Scenario: Cache writes stay visible
- **WHEN** a Claude upstream reports cache writes and the customer speaks the OpenAI format
- **THEN** the customer's usage carries `prompt_tokens_details.cache_creation_tokens`

#### Scenario: JSON split over two data lines
- **WHEN** an event arrives as `data: {"id":"gen-1","model":"glm-5.3:pre","provider":"zai",` and `data: "choices":[{"delta":{"content":"see  docs.python.org  for x"}}]}`
- **THEN** the customer receives one data line with `"model":"glm-5"`, a router id, no `provider`, and the content `see  docs.python.org  for x` unchanged

#### Scenario: Stream without blank lines
- **WHEN** an upstream streams `data:` lines (or Anthropic `event:`/`data:` pairs) with no blank line between events
- **THEN** each line reaches the customer as soon as it arrives, masked, with its content unchanged

#### Scenario: Error text inside a stream
- **WHEN** a stream carries `data: upstream glm-5.3:pre failed at https://api.zai.example/v1`
- **THEN** the customer's line names `glm-5`, no URL and no provider

#### Scenario: Admin key keeps the upstream's fields
- **WHEN** an admin key receives the same aggregator chunk
- **THEN** it is unchanged

### Requirement: Usage data never shows the upstream model
For a customer key, neither the public usage API (`/api/usage/key/receipts` and `/receipts/detail`), the customer credit ledger (`/api/account/ledger`) nor the account usage page (`/account/usage`) SHALL return the upstream model: no `resolvedModel` and no `upstreamModel`, and every model shown SHALL be the combo name. Stored request and response payloads, when requested, SHALL be masked as in "Responses name the combo"; a stored error SHALL be rebuilt as in "Errors never name the upstream". A payload stored truncated SHALL keep its `model` as a field of its own (beside the cut preview), and the cut preview of a truncated payload SHALL never be returned to a customer key; a stored string is masked as JSON when it is a JSON document and as SSE only when it holds SSE lines. The admin ledger SHALL show the combo name and the upstream model. Error rows SHALL record the combo name like success rows. A row without a recorded combo name SHALL show "—" in the history and be grouped under "Khác" in the per-model summary.

A request-detail row returned to a customer key SHALL carry no `connectionId` (the provider account that served it) and SHALL be identified by an opaque `id` that reveals neither the stored id, nor its length, nor anything inside it, and that only this server can resolve: every such id SHALL have the same length, and a stored id too long to hide in it SHALL be referenced by the row's timestamp instead, never by a longer id. The secret behind these ids SHALL be a dedicated random value kept in the data directory, never derived from the machine id or the credential encryption key. The single-detail lookup SHALL accept that id for any row of the key, however old, or the row's timestamp, and SHALL only ever read rows of the calling key. Newly stored request-detail ids SHALL NOT contain the model. An admin key keeps `connectionId`.

#### Scenario: Raw payloads
- **WHEN** a customer key reads its receipts with `includeRaw=1`
- **THEN** no field of the response contains `glm-5.3:pre` or the provider id

#### Scenario: Ledger
- **WHEN** a customer opens Nhật ký credit after calling `glm-5`
- **THEN** the charge row reads `glm-5`

#### Scenario: Detail rows carry no account or model id
- **WHEN** a customer key lists its request details and one stored row has id `2026-11-01T10:00:00.000Z-ab12cd-glm-5-3-pre` and a `connectionId`
- **THEN** the row has no `connectionId`, its `id` contains neither `glm` nor the stored id, and requesting `?id=<that id>` returns the same row

#### Scenario: Request over the size cap
- **WHEN** a customer key reads, with `includeRaw=1`, a Responses request stored truncated because it exceeded the payload size cap
- **THEN** the request shows `_truncated`, its size and `"model":"glm-5"`, and no field contains `glm-5.3:pre` or the provider id

#### Scenario: Old row on a later page
- **WHEN** a customer key holds 150 request details and asks for the id of the oldest, listed on page 3 of 50
- **THEN** the detail is returned, and the same id sent with another key is not found

#### Scenario: New detail ids
- **WHEN** a request detail is stored for model `glm-5.3:pre`
- **THEN** its id is a timestamp and a random suffix, without the model

## ADDED Requirements

### Requirement: Provider-native paths are closed to customer keys
With the setting on, a route that calls a provider directly instead of going through the masked chat handler SHALL refuse a customer key before any provider credential is read. The Gemini native TTS path (`/v1beta/models/<model>:generateContent` or `:streamGenerateContent` with a Gemini TTS model or an `AUDIO` response modality) SHALL answer a customer key with the platform denial 403 `endpoint_not_available`, type `permission_error`, message "Endpoint này chưa mở cho API key của khách hàng.", recorded like other platform denials. Admin keys and keyless local use SHALL keep the path.

#### Scenario: Customer calls Gemini TTS natively
- **WHEN** a customer key posts to `/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`
- **THEN** the response is 403 `endpoint_not_available` with the platform error header, and no Gemini credential is used

#### Scenario: Admin key
- **WHEN** an admin key makes the same call
- **THEN** it is forwarded to Gemini as before

### Requirement: Customer catalogs list only what the customer can call
For a customer key with the protection on:
- `/api/usage/key` SHALL return in `allowedModels` only names that are combos (`null` still meaning every model);
- `/v1beta/models` SHALL list the combos `/v1/models` lists for that key, as `models/<combo>`, and nothing from the built-in provider catalog;
- `/v1/models/info` SHALL answer 404 for every id;
- `/v1/audio/voices` SHALL refuse the key like the TTS endpoint does.
The customer price list SHALL NOT carry the number of models behind a combo. `/v1/audio/voices` SHALL read the voices from the router's own voices handlers in-process, never by a network request to a host taken from the request; it SHALL answer only a valid, unexpired admin key (one without an owning account) and SHALL refuse a request without a key or with an unknown key with 401 `invalid_api_key`, whatever `requireApiKey` says.

#### Scenario: Gemini model listing
- **WHEN** a customer key whose group allows combo `glm-5` calls `GET /v1beta/models`
- **THEN** the list is `models/glm-5` only

#### Scenario: Group list with an upstream id
- **WHEN** a customer's group allows `glm-5` and `zai/glm-5.3:pre`
- **THEN** `/api/usage/key` returns `allowedModels: ["glm-5"]`

### Requirement: Unauthenticated settings reveal no host
`/api/settings/require-login`, which answers without a session, SHALL return only `requireLogin` and `tunnelDashboardAccess`: no tunnel URL, Tailscale URL or other host name.

#### Scenario: Anonymous read
- **WHEN** an anonymous client calls `GET /api/settings/require-login` on a server with a tunnel and Tailscale configured
- **THEN** the body has no `tunnelUrl`, no `tailscaleUrl` and no host name
