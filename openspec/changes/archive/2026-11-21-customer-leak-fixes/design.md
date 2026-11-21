## Context

`hide-upstream-models` (archived 2026-11-05) put one mask at the end of the chat,
embeddings and image handlers (`maskResponse` in `src/lib/models/publicModel.js`) and
masked the public usage API. An audit found what that mask and the routes around it
still let through. Everything here applies only to a customer key (a key with an owning
account) while `hideUpstreamModels` is on, unless stated otherwise; admin keys and
keyless local use keep the engine's output. D7 is the exception: it changes what the
Responses translator builds for every caller.

## Decisions

### D1. Request-detail ids
- `generateDetailId` becomes `<ISO timestamp>-<12 random base36 chars>`: unique, no
  model. Existing rows keep their stored ids (no migration).
- `/api/usage/key/receipts/detail` returns, for a customer key, no `connectionId` and
  an `id` that is `sealId("request-detail", <stored id>)` (`src/lib/crypto/sealedIds.js`):
  AES-256-GCM with the nonce an HMAC of the value, so the id is deterministic (stable
  across requests and restarts) and the GCM tag rejects a forged one; `purpose` is
  authenticated data, so an id never opens for another use.
- Every plaintext is zero-padded to one fixed size, 256 bytes, so every sealed id has
  the same length (379 characters) whatever it hides: an old id's length followed its
  model name, and padding to blocks still let a long name show. A value longer than
  256 bytes is not sealed; such a row (none the router writes: an id is a timestamp,
  a suffix and at most a model name) is referenced by its timestamp, which the row
  already shows and the lookup accepts.
- The keys (HKDF-SHA256, one for AES and one for the nonce MAC) come from a dedicated
  random secret, `DATA_DIR/auth/sealed-id-secret`: 32 random bytes, created on first
  use, mode 0600. Creation is lock-free and every process uses the value read back from
  disk: the secret is written whole and fsynced to a private temporary file, then
  hard-linked to its final name (atomic and exclusive: the file appears complete or not
  at all; a process that loses the race reads the winner's). Slots are never rewritten:
  the secret is the first of `sealed-id-secret`, `.1` … `.7` that holds a valid one; a
  corrupted slot is skipped, so processes that all find it corrupted all move to the
  next slot, where only one can create. On a filesystem without hard links the file is
  copied with `COPYFILE_EXCL` (still exclusive). A slot that looks half-written (empty
  or a hex prefix) is waited for only while it is young by mtime (under 1 s), so a
  creator still writing is waited for, not raced, and the wait is bounded by what is
  left of that second; an older one is a leftover (a crash, a full disk, a stray
  `touch`) and is skipped at once, so no later process start waits on it (slots are
  never repaired). Residual: on a filesystem without hard links, a creator stalled for
  more than 1 s between creating and finishing the file could leave two processes on
  different slots. It is never derived from the machine
  id: customers hold these ciphertexts, whose plaintext starts with a guessable
  timestamp, and the machine id is low-entropy on some hosts (on node:22-alpine it falls
  back to the host name) and roots the credential encryption key in `secrets.js`; a key
  derived from it would allow offline guessing of that root. `secrets.js` is unchanged.
  If no slot can be written or read (an unwritable `DATA_DIR`, every slot corrupted)
  the process keeps an in-memory secret and logs one `console.warn` (no secret in it):
  its ids stop resolving after a restart and in other workers.
- Sealed ids issued before a reset of `DATA_DIR` (a new secret) answer 404. Ids are
  handed out per listing and reread with it, so that is acceptable.
- Because the server can open the id, the lookup is direct: `lookupDetail` opens it and
  reads the row with `WHERE id = ? AND apiKey = ?` (`getRequestDetailForKey`, primary
  key), so a row on any page resolves and another key's row never does. A timestamp
  (the history link) or an admin's connection/stored id is still matched among the key's
  100 most recent rows in the date range, as before. (An HMAC id, the first version,
  could only be matched by recomputing it over a page of rows: an id from page 3 of the
  list answered 404.)
- Truncated stored payloads. Request details keep payloads up to `maxJsonSize`
  (default 5 KiB); a larger one becomes `{ _truncated, _originalSize, _preview }`, the
  preview being the first 200 characters of the raw JSON. The stored request is
  recorded after combo expansion, so its `model` is the upstream one, and for a
  Responses (Codex) request — no `messages` — or a chat request with a large `tools`
  array it sits inside those 200 characters, where a field mask cannot reach it. Two
  layers: `truncateField` keeps a string `model` as a field of its own beside the
  preview and cuts the preview from the rest (an admin still reads the model, now as a
  field), and `maskStoredResponse` never returns a `_preview` to a customer key (it is
  raw cut text that could hold anything; `_truncated` and the size stay). The receipts
  list and the account usage page never carry payloads; the detail route's summary,
  `includeRaw` and single-detail paths all go through `scrubDetailForList`.
- The scrub and lookup live in `src/lib/usage/publicRequestDetails.js` (relative
  imports, so tests can exercise them); the route keeps the key check.
- The customer page (`/usage`) opens a detail by the history row's timestamp; it never
  read `connectionId` from a history row (history rows do not carry one), so nothing in
  the UI changes.

### D2. A JSON body under SSE headers
`createSseMaskStream` decides the body type on its first non-blank character (a leading
byte-order mark counts as blank). `{` or `[` means a JSON body (the passthrough
`docMode` of `open-sse/utils/stream.js`): a single JSON document, a JSON array (Gemini
`streamGenerateContent` without `alt=sse`) or NDJSON. For a customer key such a body is
buffered, not streamed, and masked once at the end:
- status >= 400: rebuilt by `maskErrorBody` (platform header honoured);
- otherwise masked like a JSON response (model fields, provider fields, usage, ids,
  embedded errors; each element of an array). A body that is not one JSON value is
  masked line by line (NDJSON), and a line that is not JSON is scrubbed as upstream text
  (D8).

The buffer is capped at `STREAM_MAX_BUFFER_BYTES` (default 4 MiB), the same cap under
which `stream.js` still parses such a document for usage. Past it the mask fails closed:
the customer receives a `model_error` JSON error instead of unmasked bytes (the engine
cannot read usage past that cap either, so nothing is billed). An SSE body is masked
as it arrives (D8): a line is released as soon as its data is complete; only the first
lines of a JSON value split over several `data:` lines are held, never a whole event
waiting for a blank line and never the stream.

### D3. Gemini native TTS
`/v1beta/models/<model>:generateContent` with a TTS model or an AUDIO response modality
calls Google directly, bypassing combo-only, the mask and header stripping. A customer
key is refused there before any credential lookup: 403 `endpoint_not_available`,
platform-marked, logged as a platform denial, message
"Endpoint này chưa mở cho API key của khách hàng.". The check uses the shared
`refuseCustomerEndpointSync` (in `unmeteredEndpoints.js`, beside the unmetered list;
`refuseUnmeteredSync` now delegates to it). Unlike the unmetered endpoints (refused
because nothing is charged there) this path is metered, and what it bypasses is the
model-privacy protection; so it follows that capability's switch: with
`hideUpstreamModels` off the previous behaviour returns. Admin keys and keyless local
use are unchanged. The route's catch-all error answer no longer returns the raw
`error.message` to anyone: it logs the error name and a bounded message and answers a
generic Vietnamese sentence.

### D4. One key extractor
`src/lib/auth/apiKeyExtract.js` exports `extractApiKey(request)`:
`Authorization: Bearer` → `x-api-key` → `x-goog-api-key` → `?key=` (the guard's order).
`dashboardGuard.js` and `src/sse/services/auth.js` (re-export, so every handler,
`withErrorLog` and `/v1/models` keep their import) use it; the Gemini route drops its
private `extractGeminiClientApiKey`. Dependency-free and relative-import safe.

### D5. Provider-identifying fields, usage and ids
`maskModelFields` now also:
- deletes `system_fingerprint`, `x_groq`, `prompt_filter_results` at the top of a body
  or chunk, and `native_finish_reason` / `content_filter_results` in each choice (plus
  the existing top-level `provider` string);
- replaces each usage object by an allow-list of its format's standard fields, numbers
  only, detail objects filtered too:
  - OpenAI chat (`object` `chat.completion*`, or a `choices` array): `prompt_tokens`,
    `completion_tokens`, `total_tokens`,
    `prompt_tokens_details.{cached_tokens,cache_creation_tokens,audio_tokens}`,
    `completion_tokens_details.{reasoning_tokens,audio_tokens,accepted_prediction_tokens,rejected_prediction_tokens}`,
    and the top-level `cached_tokens` / `reasoning_tokens` the router's own compat
    whitelist (`filterUsageForFormat`) may emit;
  - Claude (`type` `message` / `message_delta`, and `message.usage` of `message_start`):
    `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
    `cache_read_input_tokens`, and Anthropic's own `cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}`
    and `server_tool_use.{web_search_requests,web_fetch_requests}`;
  - Responses (`object: "response"`, and `response.usage` of `response.*` events):
    `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`,
    `output_tokens_details.reasoning_tokens`;
  - Gemini (`usageMetadata`, also under `response` for Antigravity/Gemini CLI):
    `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`,
    `cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount` and the
    `*TokensDetails` modality arrays;
  - embeddings (a `data[]` of `object: "embedding"` or `embedding` arrays):
    `prompt_tokens`, `total_tokens`;
  - image generations and edits (`created` plus a `data[]` of `url` / `b64_json`, or an
    `image_generation.*` / `image_edit.*` stream event): `input_tokens`,
    `output_tokens`, `total_tokens`, `input_tokens_details.{text_tokens,image_tokens}`,
    `output_tokens_details.{text_tokens,image_tokens}`.
  Audit of what the router itself emits to a client (`translator/concerns/usage.js`
  `buildUsage` and `responsesUsageFromChat`, the response translators, `openai-to-claude`,
  `kiro-to-claude`, `openai-to-antigravity`, `geminiUsageFromOpenAI`, the SSE→JSON
  handler, `shared/qoder/sse.js`, `filterUsageForFormat`): every field is in these lists;
  `prompt_tokens_details.cache_creation_tokens` (cache writes, billed) was the one
  missing from the first version. `estimated` is never client-facing. Audio (STT/TTS)
  bodies never reach a customer key (those endpoints refuse it) and are not masked.
- rewrites ids to router-generated ones: the chat-completion `id`
  (`chatcmpl-<32 hex>`), the Claude message `id` (top-level for `type: "message"`,
  `message.id` for `message_start`; `msg_<32 hex>`) and the Gemini `responseId`
  (top-level or under `response`). One id per kind per response: `maskResponse` and
  `createSseMaskStream` hold a per-response state, so every chunk and event of one
  response carries the same id even if the upstream varied its own.
- leaves alone: the Responses ids of a Responses-format upstream (`response.id`, item
  ids: the client hands them back as `previous_response_id`, which reaches that
  upstream), every tool-call id, and all message content. Responses ids the router
  builds itself are covered by D7. Known gap: a provider-specific prefix in a
  Responses-format upstream's own ids is not hidden; hiding it would need a router-side
  id map for `previous_response_id`, out of scope here.

### D6. Catalogs and settings
- `/api/usage/key`: for a customer key with the protection on, `allowedModels` keeps
  only names that are combos (`null` still means "all").
- `/api/settings/require-login`: `tunnelUrl` / `tailscaleUrl` removed (body built by
  `publicLoginSettings` in `src/lib/auth/publicSettings.js`). Nothing reads them from
  this route (the guard reads settings directly; the admin console reads the
  authenticated settings API); no authenticated variant is needed.
- `/v1beta/models`: a customer key gets the combos `/v1/models` would list for it
  (`resolveKeyScopeForModels` + `buildModelsList`), as `models/<combo>`; others keep
  the built-in catalog. The Gemini-format builders live in
  `src/lib/models/geminiModelList.js`.
- `/v1/models/info`: a customer key gets 404 for every id (combos have no catalog entry;
  built-in entries are not theirs to read).
- `/v1/audio/voices`: it used to fetch `/api/media-providers/tts/.../voices` at the
  request's own origin: a host taken from the caller's Host header, and, behind the
  admin guard, a call with no credential that answered 401 for everyone. It now calls
  those route handlers in-process (they only read their query string), so no network
  request is made and admin use works. Since that bypasses the admin session the
  handlers relied on, the route is their gate now: only a valid, active, unexpired
  admin key (an `apiKeys` row without `userId`) is served. No key or an unknown key
  gets 401 `invalid_api_key` even with `requireApiKey` off (the operator's voices,
  cloned ones included, are never anonymous), an expired key 403 `key_expired`, a
  customer key 403 `endpoint_not_available` (`refuseUnmeteredEndpoint`, as TTS).
- `buildModelPriceList` no longer returns `modelsCount` (no UI reads it).

### D7. Router-owned Responses ids (every caller)
When a Responses client is served by a non-Responses upstream, the router builds the
Responses objects itself. It used to take their ids from the upstream: `resp_<chunk.id>`
in the stream translator (`translator/response/openai-responses.js`) and the Codex
transform stream (`transformer/responsesTransformer.js`), `resp_<body.id>` in the two
non-stream converters (`nonStreamingHandler.js`, `sseToJsonHandler.js`), and item ids
`rs_<responseId>_n` / `msg_<responseId>_n`. With OpenRouter or Bedrock that gave
`resp_gen-…`, `msg_resp_gen-…_0`, `resp_msg_bdrk_…`.

A router-built id is never looked up anywhere. `previous_response_id` is forwarded as
sent to Responses-format upstreams (OpenAI, Azure, custom Responses nodes), but on those
the ids came from that upstream and are kept (D5); on the translated path the codex and
grok-cli executors delete it, the chat request translator does not read it (history is
rebuilt from `input` items, `call_id` and `encrypted_content`), and no route or service
resolves a `resp_` id. So the id is the router's own for every caller, admin included: `newResponseId()`
(`open-sse/utils/responseIds.js`, `resp_<32 hex>`) set once when the stream state is
created (or once per non-stream body), with the item ids derived from it as before. No
log or test depended on the old shape. Tool-call ids and the `fc_`/`ctc_` item ids built
from them keep the upstream value. A Responses → Responses passthrough is untouched.

### D8. Events and text inside a stream
SSE lets one event carry its data on several `data:` lines, which a client joins with
"\n". The first version masked each line alone, so a JSON payload split that way was
taken for broken JSON: its content was scrubbed ("see  docs.python.org  for x" became
"see for x") and its `id` and `provider` passed. A second version held each event until
its blank line; but the engine's passthrough (`open-sse/utils/stream.js`
`passthroughLine`) forwards an upstream's lines exactly as received and never adds a
blank line, and many upstreams send none, so whole streams were held to the end (and an
overflow lost the whole reply). The mask now releases data as soon as it is complete
(`createSseEventMasker` / `maskSseEvent`):
- a line split across network chunks is held until its newline, as always;
- a `data:` line whose payload is not JSON-shaped (text, `[DONE]`, empty) is released
  at once (text through `scrubUpstreamText`);
- JSON data is followed by an incremental JSON grammar check
  (`src/lib/models/jsonPrefix.js`: a pushdown automaton over RFC 8259 — open
  containers, then what may come next: value, key, colon, comma or closer; strings
  with escapes and `\u` sequences; no raw control character inside a string). Each
  line's verdict is complete, a prefix of a possible value, or impossible:
  - complete: released at once, so one line of an ordinary stream leaves in the same
    step it arrived. The lines of a value split over several `data:` lines are joined
    with "\n" (one leading space dropped, as SSE does), masked once and written as one
    `data:` line where the first was (a client joining the lines reads the same value);
  - a prefix: held (only the first lines of a split value are ever held);
  - impossible (for example `{"a":` then a line `{…}` then a line `{`, or a line that
    ends inside a string): the lines held before the offending line go out at once one
    by one (a line that is JSON is masked as JSON, the rest is scrubbed as upstream
    text), and the offending line is treated afresh, as the possible start of the next
    event. A never-closing line therefore holds the stream for at most one further
    line, never to the cap;
- pending data is released when an `event:` line or a blank line arrives, and at the
  end of the stream, by the same one-by-one rule;
- lines without data (`event:`, `id:`, `retry:`, comments) pass at once when nothing is
  pending, otherwise in place; an `id:` value is upstream text (a generation id may
  embed a model or a host) and goes through `scrubUpstreamText` (the router writes no
  `id:` lines of its own); line terminators (`\n`, `\r\n`) are kept and nothing is
  added;
- what happens at the cap: pending data (a split value still open) is capped at
  `STREAM_MAX_BUFFER_BYTES`, and so is a single line still arriving (lines are cut from
  each new network chunk only, so a long line costs linear time). Past the cap, one
  `model_error` data line is released at once; the held lines and the rest of the line
  never leave. The grammar check keeps following the dropped value — through the rest
  of the line and any continuation lines — and the drop ends exactly where the value
  does: its closing line is dropped too, and the next line is treated afresh. A line
  that cannot continue the dropped value (a text error, the `{` of a new value after the
  dropped one closed or could not continue) also ends the drop and is treated afresh, as
  do a blank line and an `event:` line. A nested line that is valid JSON on its own but
  sits inside the dropped value is part of it and is dropped, so no fragment of a
  dropped value is ever released. A line larger than the cap fails closed when it
  comes from a network stream, as it always does in practice: its start is carried
  until its newline, and the carried part outgrows the cap first. Only when such a
  line is handed over whole in one piece (a stored copy, or one network chunk holding
  the whole line) is it simply masked, since nothing then has to be held for it.
- one value spread over k lines costs O(k) (a `Set` of joined line indexes).
Stored copies use the same masker (`maskSseText`); a stored string is treated as SSE
only when a line starts with `data:` or `event:`, and as a JSON document when it starts
with `{` or `[` (a JSON body whose content mentions "data:" is masked as JSON).
Upstream text is scrubbed with `scrubUpstreamText`: first the quoted JSON forms of a
broken fragment (`scrubJsonForms`: the pairs of `provider`, `system_fingerprint`,
`x_groq`, `native_finish_reason`, the filter results and the usage extras are cut out,
`model`/`modelVersion` values name the combo, provider-prefixed response ids `gen-…`,
`chatcmpl-…`, `msg_…` become the router's; tool-call ids `call_…`/`toolu_…` are left),
then the URL / cloud-path / host-name removal and id scrubbing that error messages
already get (`cleanUpstreamMessage` calls it after its prefix and pasted-JSON handling).
A data payload that is a bare JSON string (`data: "…"`) is scrubbed as text, like any
non-object payload: in the chat protocols (OpenAI chat, Claude, Responses, Gemini)
every data payload is an object or `[DONE]`, and message content always travels inside
object fields, so a bare string is never content; it is upstream text (an error or a
gateway notice) and may name the upstream. It is parsed, its text scrubbed and quoted
again, so it stays one valid JSON string (a URL scrub never eats the closing quote).
A byte-order mark in front of a line is kept and no longer hides the line
from the mask (the stream decoder already drops a BOM at the start of a body; stored
copies and other callers may still carry one).

## Risks / Trade-offs

- A legitimate JSON body over 4 MiB answering a streamed customer request becomes a
  `model_error`. The engine already stops reading usage past that size.
- A process that cannot persist or read the sealed-id secret (unwritable `DATA_DIR`,
  every slot corrupted) runs on an in-memory secret: its detail ids do not survive a
  restart and do not resolve in other workers. It logs one `console.warn` saying so.
- On a filesystem without hard links, a slot creator stalled for over 1 s could leave
  processes on different secrets (D1); with hard links (the norm) it cannot happen.
- A JSON array or NDJSON body sent under SSE headers (Gemini `streamGenerateContent`
  without `alt=sse`, some gateways) is buffered whole for a customer key: the customer
  sees nothing until the upstream finishes, where an admin key sees it as it arrives.
  Masking it piece by piece would need a streaming JSON parser; the time to first byte
  is the price of not leaking.
- SSE timing for a customer key matches the unmasked stream line for line, with one
  exception: the first lines of a JSON value split over several `data:` lines wait for
  its last line (they cannot be masked earlier). If an upstream splits a value and the
  line that closes it arrives in a later network packet, that value is released one
  packet late; a separator (a blank line or `event:` line) arriving late never delays
  complete data. A line that never closes (`{"a":`) is released as soon as the grammar
  shows it cannot (usually with the next line or the one after: `{"a":` followed by
  `{…}` is still a possible value, the next line ends it), and in any case by the next
  `event:` line, blank line, the cap or the end of the stream; the valid lines behind
  it are delayed by at most that, never dropped.
- A value the grammar accepts but JSON.parse rejects (an odd number such as `1-2`) is
  released through the per-line fallback; numbers are only checked for their
  character set while streaming.
- Rewritten chat/message ids differ from the upstream's; a customer correlating with
  provider logs cannot (that is the point). Admin keys keep upstream ids, except the
  Responses ids the router builds itself (D7).
- A customer's detail id is 379 characters (sealed, fixed-size padding) instead of a
  short hash.
- Out of scope, noted: the machine id that roots `secrets.js` is also sent to Kimi as
  the `X-Msh-Device-Name` header.
- The combo price falls back to the first priced member when the combo has no own price
  (business rule, unchanged).
