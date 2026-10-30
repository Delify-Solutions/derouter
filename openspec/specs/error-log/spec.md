# error-log Specification

## Purpose
Defines the admin error log: which failed proxy requests are kept, what is stored with each (the error, the upstream attempts, the prompt), what is deliberately left out, how the log is bounded, and the admin page and API that read it.
## Requirements
### Requirement: Every failed proxy request is kept as one error log entry
The router SHALL store one entry for each request to a proxied model endpoint (chat completions, messages, responses, embeddings, image generation, search, fetch, speech, video creation) that ends with HTTP status 400 or above, and for each streamed response that fails after its headers were sent. An entry SHALL record the time, endpoint, final status, error code and message, the model the client asked for (the string the client sent, not the id the router resolved), the provider, upstream model and connection of the last failed upstream call, the key id and an owner label (the owner's email, or the key name), whether the request streamed, the request size in bytes, an estimated token count and number of turns, the latency, and every failed upstream attempt (provider, model, connection, status, error text, time since the request started). Not logged: audio transcription (multipart upload), a video status lookup, and the Gemini-native `/v1beta` forwarding to Google (the `/v1beta` calls that go through the chat engine are logged). Recording SHALL happen after the response is returned and SHALL NOT delay, change or fail the request it describes.

Each entry SHALL carry a source: `upstream` (at least one upstream call failed), `stream` (the response failed after it started; the status is 200), `router` (no upstream call was made and the status is 5xx: no credentials, every account cooling down, an internal error), `request` (no upstream call and a 4xx other than 401, 402, 403, 429: invalid body, unknown model), or `platform` (the router's own verdict on the key, group or plan: 402, 403, 429).

#### Scenario: Upstream refuses the context length
- **WHEN** a client calls `GLM-5.3` with a prompt over the context window and the upstream answers 400 `context_length`
- **THEN** one entry exists with source `upstream`, status 400, the requested model `GLM-5.3`, the upstream provider, model and connection, the error message, the prompt, the body actually sent upstream, and one attempt with status 400

#### Scenario: Combo falls through two models
- **WHEN** a combo request fails on its first model with 502 and on its second with 400
- **THEN** the entry lists both attempts in order; its provider, upstream model and connection are those of the last attempt, and its status is the one the client received

#### Scenario: Stream dies half way
- **WHEN** a streamed response stops after 12 chunks because the upstream stalls
- **THEN** an entry with source `stream` and status 200 is stored with the number of chunks and bytes received before the failure

#### Scenario: Successful requests are not logged
- **WHEN** a request returns 200 and streams to the end
- **THEN** no entry is created

### Requirement: Some failures are not logged
The router SHALL NOT log an HTTP 401 the router itself produced before any upstream call (unauthenticated traffic carries attacker-controlled bodies and cannot be attributed) nor HTTP 499 (the client went away). A 401 relayed from an upstream (an expired provider credential) SHALL be logged. The router SHALL NOT keep the prompt of a `platform` entry; it keeps only the size facts.

#### Scenario: Missing key
- **WHEN** a request without a valid API key is answered 401 by the router
- **THEN** no entry is created

#### Scenario: Provider credential expired
- **WHEN** an upstream answers 401 and the router relays it after a failed token refresh
- **THEN** an entry with source `upstream` and status 401 is stored

#### Scenario: Rate limit
- **WHEN** a key exceeds its RPM limit and the router answers 429 `rate_limit`
- **THEN** an entry with source `platform` is stored with the error and the key owner, and without prompt text

### Requirement: Secrets never reach the log
An entry SHALL NOT contain a raw API key, request headers or the upstream URL. The owner is identified by key id and a label only. Text stored in the entry (error messages, attempt errors, prompt text) SHALL have bearer tokens, key-shaped strings (`sk-…`, `ak_…`), `key=`/`token=` query values and the values of credential-named fields (`api_key`, `authorization`, `password`, …) replaced by `[redacted]`. This masking is heuristic: a secret of another shape is stored as written.

#### Scenario: Key pasted in a prompt
- **WHEN** a failed request's last user message contains `Bearer sk-6920ba17c2ee1d17-9bod82-05263e46`
- **THEN** the stored prompt, preview and error text show `Bearer [redacted]` and nothing of the key

### Requirement: The stored prompt is bounded and keeps its structure
When prompt storage is on, an entry SHALL keep the client request exactly as the client sent it (the router's own rewrites of the model id, roles, injected prompts and compressed tool results are not applied to it) and, separately, the body that was actually sent upstream, as JSON with roles, parameters and tool calls intact. Strings longer than the limit lose their middle (marked with the number of characters cut), inline `data:` URIs become a description, and when the body still exceeds the per-entry limit (default 64 KB) the limit on strings is lowered stepwise and finally only the first 8 and last 40 turns are kept with an omitted-turns marker. The entry SHALL record that the prompt was truncated. A body over 8 MB, or one that still exceeds the limit after compaction (for example a huge numeric array), SHALL be replaced by a short description with its size, model and stream flag. The request size, turn count and estimated tokens SHALL be recorded from the original request whether or not the prompt is stored.

#### Scenario: Very long history
- **WHEN** a failed request has 4000 turns
- **THEN** the stored prompt keeps the first turns and the last turns, marks how many were omitted, and fits the per-entry limit

#### Scenario: The engine rewrites the request
- **WHEN** the router maps the model `GLM-5.3` to `glm-5.3:pre`, turns a `developer` message into `system` and injects a system prompt before the upstream call
- **THEN** the entry's `requestedModel` is `GLM-5.3`, its stored client request has the original roles and text, and only the stored upstream body carries the rewrites

#### Scenario: Prompt storage switched off
- **WHEN** an admin turns off "Lưu nội dung prompt" and a request fails
- **THEN** the entry has the error, model, size, turn count and attempts, and no prompt, no upstream body and no preview

### Requirement: The log is bounded by age and count
The log SHALL delete entries older than the retention period (default 14 days) and, past the maximum entry count (default 1000), the oldest entries. Pruning SHALL run automatically while entries are written. An admin SHALL be able to change the retention (1–365 days), the maximum count (100–20000), the per-entry prompt limit (4–1024 KB), logging on or off and prompt storage on or off; out-of-range values are clamped. An admin SHALL be able to delete one entry, all entries, or entries older than a number of days. With logging off no entry is written.

#### Scenario: Cap exceeded
- **WHEN** the log holds the maximum number of entries and another request fails
- **THEN** the oldest entries are removed so the count does not grow without bound

### Requirement: Admin page and API
The router SHALL provide an admin-only page `/dashboard/errors` ("Nhật ký lỗi") and the API `GET /api/error-logs` (list, filters `source`, `status` (a class digit or a code), `model`, `q`, `range` (`1h`, `24h`, `7d`), keyset pagination `before`), `GET` and `DELETE /api/error-logs/{id}`, `DELETE /api/error-logs` (optionally `olderThanDays`) and `GET`/`PUT /api/error-logs/settings`. These paths SHALL NOT be public. The list SHALL NOT load the stored prompt. The page SHALL show counts per source, a filterable table, and a detail drawer with the error, the upstream attempts, the prompt turn by turn, the body sent upstream and copy controls; every status and source SHALL be shown as text as well as colour. When the log is empty, filtered to nothing, switched off or failing to load, the page SHALL say so and offer the matching action.

#### Scenario: Filter by source and search
- **WHEN** an admin selects source `upstream`, range 24 hours, and searches `context_length`
- **THEN** only upstream entries of the last 24 hours whose message, owner or code contains `context_length` are listed, newest first

#### Scenario: Open an entry
- **WHEN** an admin opens an entry
- **THEN** the drawer shows the error, each attempt, and the prompt with its roles, and says when the prompt was truncated or not stored
