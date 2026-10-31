# usage-accuracy Specification

## Purpose
Defines which token figures the router records, bills and returns for a proxied request: the upstream's own figures, exactly, in one canonical convention, with an estimate only as a flagged billing fallback that is never shown to a client. Covers streamed and non-streamed responses, the cached and reasoning parts of a request, and what is recorded for a stream that fails or is cancelled.

## Requirements
### Requirement: No safety margin is ever added to usage
The router SHALL NOT add tokens to any usage figure it records, bills or returns. In particular the former "+2000 buffer" on `input_tokens`, `prompt_tokens` and `total_tokens` SHALL NOT exist, neither in what a client receives nor in what is recorded for billing, and estimates SHALL NOT include it.

#### Scenario: Real usage is passed on unchanged
- **WHEN** an upstream reports `prompt_tokens: 4511` and `completion_tokens: 2`
- **THEN** the client receives those figures and the usage row records 4511 input and 2 output tokens

### Requirement: The upstream's own usage wins over an estimate
When an upstream reports usage for a streamed response, the router SHALL record exactly the figures the upstream reported, including the cached-token details, even if the upstream sends them after the finish chunk (as the OpenAI protocol does), sends more than one finish chunk, or sends them in a different event than the rest (Anthropic `message_start` versus `message_delta`). The recorded figures SHALL be read only from the raw upstream chunks; a figure a translator rebuilt for the client (for example a prompt that already includes the cache) SHALL NOT be merged into them. A request that has real upstream usage SHALL never be billed from an estimate, in any path (stream, non-stream, forced SSE-to-JSON, Responses, Anthropic, Gemini).

#### Scenario: Usage arrives after the finish chunk
- **WHEN** an upstream sends a finish chunk without usage, then a usage-only chunk with `prompt_tokens: 4511` and `cached_tokens: 4480`, then the finish chunk again
- **THEN** the usage row records 4511 input tokens and 4480 cached tokens, not an estimate

#### Scenario: Anthropic upstream, OpenAI client
- **WHEN** an Anthropic upstream reports `input_tokens: 31`, `cache_read_input_tokens: 4480` and `output_tokens: 7` and the client speaks the OpenAI format
- **THEN** the client sees `prompt_tokens: 4511` with `prompt_tokens_details.cached_tokens: 4480`, and the row records 4511 input and 4480 cached tokens (the cached part is counted once, never 8991)

### Requirement: One canonical usage convention
Recorded usage SHALL use one convention: `prompt_tokens` includes the cached and cache-written parts of the prompt, `cached_tokens` is the cache-read part, `cache_creation_input_tokens` is the cache-write part, and `reasoning_tokens` is a subset of `completion_tokens`. Anthropic `input_tokens` excludes the cache and SHALL be folded in exactly once; OpenAI `prompt_tokens`, DeepSeek `prompt_cache_hit_tokens`, Responses `input_tokens` (with `input_tokens_details.cached_tokens`) already include it. Gemini thinking tokens are output: they SHALL be added to the completion and reported as the reasoning subset, never added to the prompt.

#### Scenario: Cost charges each token once
- **WHEN** a request has 4511 prompt tokens of which 4480 are cached, and 7 output tokens, priced input $3, cached $0.30, output $15 per million
- **THEN** the cost is 1,542,000 nano-USD: 31 fresh tokens at the input rate, 4480 at the cached rate, 7 at the output rate

#### Scenario: Reasoning is not charged twice
- **WHEN** a request has `completion_tokens: 1000` of which `reasoning_tokens: 400`, priced output $15 and reasoning $30 per million
- **THEN** the cost of the completion is 600 tokens at the output rate plus 400 at the reasoning rate

### Requirement: Clients see the cached part in their own format
Whatever the upstream format, a response SHALL carry usage in the client's format with the cache split the way that format defines it. For an Anthropic client `input_tokens` SHALL exclude the cache and `cache_read_input_tokens` / `cache_creation_input_tokens` SHALL carry it, so that their sum equals the upstream's prompt. For an OpenAI client `prompt_tokens` SHALL include it with `prompt_tokens_details` reporting it. For a Responses client `input_tokens` SHALL include it with `input_tokens_details.cached_tokens`, and `response.completed` SHALL carry the usage. A usage-only OpenAI chunk that follows the finish chunk SHALL reach the client's terminal event: the translator SHALL hold the finish until that usage chunk, `[DONE]` or the end of the stream, then emit one terminal event with the real figures.

#### Scenario: Cached prompt in an Anthropic stream
- **WHEN** an OpenAI upstream reports `prompt_tokens: 4511` and `cached_tokens: 4480` after its finish chunk and the client speaks the Anthropic format
- **THEN** the single `message_delta` carries `input_tokens: 31`, `cache_read_input_tokens: 4480`, `output_tokens: 2`, followed by one `message_stop`

#### Scenario: Cached prompt in a non-streamed Anthropic reply
- **WHEN** the upstream reports `prompt_tokens: 4511` and `cached_tokens: 4480` for a non-streamed request made in the Anthropic format
- **THEN** the reply carries `input_tokens` 31 and `cache_read_input_tokens` 4480

#### Scenario: Responses client behind a chat upstream
- **WHEN** an OpenAI chat upstream reports usage with cached tokens and the client speaks the Responses format
- **THEN** `response.completed` carries `usage` with `input_tokens_details.cached_tokens`; when the upstream reported no usage the `usage` field is absent

### Requirement: Streamed requests to an OpenAI-compatible upstream always ask for usage
For a streamed chat request to an OpenAI-compatible upstream (custom node of type chat) whose body itself has `stream: true`, the router SHALL send `stream_options.include_usage: true`, also when the client sent `false` or nothing, because an upstream that was not asked reports no usage and billing would fall back to an estimate. The addition SHALL be appended after the client's own fields and the caller's body object SHALL NOT be mutated. Non-streamed requests, bodies that do not stream, and upstreams of the Responses type SHALL be left unchanged. When the client did not itself ask for usage (`include_usage` not `true`), the usage-only chunk (`choices: []`) the router triggered SHALL be withheld from the client and still recorded. A usage object that the upstream puts INSIDE a finish chunk is forwarded as sent: the router cannot tell whether the upstream would have sent it without being asked, and rewriting an upstream's chunk would break byte equality.

#### Scenario: Stream asks for usage
- **WHEN** a client streams a chat request to an OpenAI-compatible chat node without `stream_options`
- **THEN** the upstream request carries `stream_options: {"include_usage": true}` after the client's fields, the client's own body object is unchanged, and the client's stream has no usage-only chunk

#### Scenario: Client explicitly opts out
- **WHEN** the client sends `stream_options: {"include_usage": false}` and the upstream reports usage in a separate usage-only chunk
- **THEN** the upstream still receives `include_usage: true`, the request is billed from the real usage, and the client's stream contains no usage chunk

#### Scenario: Usage inside the finish chunk
- **WHEN** the upstream puts the usage inside its finish chunk
- **THEN** the client receives that chunk unchanged, usage included

#### Scenario: Client asked for usage
- **WHEN** the client sends `stream_options: {"include_usage": true}`
- **THEN** the client receives the usage-only chunk exactly as the upstream sent it

### Requirement: An estimate is a flagged billing fallback only
When an upstream reports no usable usage for a request that generated output, the router SHALL record an estimate: input from the text of the request, output from the generated text (including tool-call names and arguments), flagged `estimated`. The estimate SHALL NOT include any margin, SHALL NOT be sent to the client (an OpenAI or Responses stream gets no fabricated usage; an Anthropic `message_delta` carries the zeroed placeholder the protocol requires), SHALL NOT be merged with real figures, and SHALL be visible as `estimated` in the usage row and the key holder's receipt. A request that generated no output SHALL record nothing. No tokenizer is bundled, so the estimate is a heuristic.

Residual inaccuracy: the estimate counts roughly 4 ASCII characters or 2 non-ASCII characters per token and a flat 1000 tokens per inline image or file; real tokenizers differ by model and the figure is typically within tens of percent of the true count, not exact. Chat-template overhead, hidden system prompts and server-side tools are not counted. Operators should treat estimated rows as approximate and prefer upstreams that report usage.

#### Scenario: Upstream never reports usage on a stream
- **WHEN** an upstream streams a reply and sends no usage chunk (for example DeepSeek behind a gateway that omits it)
- **THEN** the usage row records the estimate flagged `estimated`, with no cached tokens and no added margin, and the client receives exactly the upstream's bytes

#### Scenario: Estimate ignores encoding overhead
- **WHEN** a request carries a 400 KB base64 image and 8 characters of text
- **THEN** the estimated input is 1002 tokens, not roughly 100,000

### Requirement: Failed or cancelled streams record what is known
A stream that ends without a normal close (client cancel, upstream error, socket reset, stall) SHALL still be recorded exactly once: the usage the upstream had already reported if any, otherwise a flagged estimate for the output that was actually delivered, otherwise nothing. Nothing SHALL be invented for a stream that produced no output.

Residual limit: if a client disconnects after the upstream's finish chunk but before the trailing usage chunk was read, the cancel ends the pipe first, the real usage is not seen, and the row is the flagged estimate even though the true figure was on the wire. Where a translator holds the finish chunk for the usage (an OpenAI upstream behind an Anthropic or Responses client), the same limit applies to the terminal event the client never receives.

#### Scenario: Client cancels after receiving text
- **WHEN** a client aborts a stream after receiving generated text and before any usage arrived
- **THEN** one usage row is recorded for that text, flagged `estimated`

#### Scenario: Upstream dies mid-stream
- **WHEN** the upstream socket is reset after some text was delivered and before any usage
- **THEN** one usage row is recorded for that text, flagged `estimated`

#### Scenario: Anthropic stream cancelled after message_start
- **WHEN** the Anthropic upstream already reported input and cache tokens in `message_start` and the stream is cancelled
- **THEN** those real figures are recorded, not an estimate

### Requirement: A non-streamed reply is billed from its own usage
For a non-streamed response the router SHALL record the usage reported in the body, reading every spelling of the cached figure (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `input_tokens_details.cached_tokens`, `cache_read_input_tokens`, `cachedContentTokenCount`). If the body has no usable usage but has output, the flagged estimate applies. A provider that answers a streamed request with one JSON document SHALL be forwarded as sent and its usage recorded from the document.

#### Scenario: JSON body to a streamed request
- **WHEN** a provider answers a streamed request with a plain JSON chat completion that has usage
- **THEN** the body reaches the client unchanged and the row records its usage

### Requirement: The estimated cached part is a per-combo option, off by default
A combo SHALL have the boolean option `cacheEstimation` (stored in the combo's `meta`, default off, changed in the combo form as "Ước lượng cache theo prefix" and through the combo API, which SHALL accept booleans only and answer 400 for anything else). A combo without the option, and a request to a bare provider/model, SHALL behave exactly as before this requirement. The combo the client called decides, also for a fusion combo; a combo reached from another combo keeps the outer decision. A request without an API key has no tenant to scope the remembered prompts to and SHALL get no estimate. The option only makes sense for an upstream that really caches its prompt prefix; the form SHALL say that it applies only when the upstream returns no usage and that the figure is an estimate.

#### Scenario: Existing combo
- **WHEN** a combo was created before this option existed
- **THEN** it has no `cacheEstimation` key and its requests record cached tokens exactly as before

#### Scenario: Fusion and nested combos
- **WHEN** a fusion combo with the option on runs its models, or a combo with the option on reaches another combo
- **THEN** every upstream call of that request is estimated under the outer combo's decision, and the inner combo's own option does not override it

#### Scenario: Request without an API key
- **WHEN** a request to a combo with the option on carries no API key
- **THEN** it records the plain estimate, with no estimated cached part and no remembered prompt

#### Scenario: Invalid value
- **WHEN** a combo is created or updated with `cacheEstimation: "yes"`
- **THEN** the API answers 400 and nothing is stored

### Requirement: The estimate applies only to a pure estimate
The estimated cached part SHALL be added only to a usage that is itself a pure estimate (the upstream reported no usable usage at all, spec "An estimate is a flagged billing fallback only"). Usage the upstream reported SHALL never be altered: not when it carries no cache details, not when it carries them, in any path (stream, non-stream, forced SSE-to-JSON). A request that failed or recorded no usage SHALL get no estimate. The estimate SHALL be computed after the response was delivered and off the request's own turn (after the last byte of a stream, after the reply of a non-streamed request was returned, both in `setImmediate`), never while chunks are in flight; an error in it SHALL leave the usage recorded unchanged.

#### Scenario: Upstream reported usage without cache
- **WHEN** a combo with the option on gets `prompt_tokens: 4511` and no cache details from the upstream
- **THEN** the row records 0 cached tokens, not an estimate

#### Scenario: Upstream reported nothing
- **WHEN** the same combo gets a stream without usage and a previous request shared most of its prompt
- **THEN** the row is flagged `estimated` and carries an estimated cached part

### Requirement: The cached part is estimated from prefix reuse, deterministically
The router SHALL remember, per scope (the calling API key, the upstream connection, the upstream model), the last three prompt texts of requests of combos with the option on, in a bounded in-memory LRU with a time to live of 10 minutes (`CACHE_ESTIMATION_TTL_MS`), a total cap of 64 MB (`CACHE_ESTIMATION_MAX_BYTES`) and a per-text cap of 8 MB (`CACHE_ESTIMATION_ENTRY_MAX_BYTES`); a value that is not a positive finite number SHALL fall back to the default. Least recently used scopes SHALL be evicted first, a text over the per-text cap SHALL be ignored, and a scope whose newest text is past the TTL SHALL be released by a lazy sweep (at most every 30 s, on writes and estimates), not only ignored on read. The prompt text is the system/instructions, the tools and then each message serialised separately, in the order the provider renders them, with inline base64 payloads (images, files) replaced by a short stable token (hash and length) so they neither inflate memory nor the shared-character ratio (a repeated image makes the estimate conservative). For a pure estimate the router SHALL take the longest common prefix, in characters, between the request's text and each remembered text of the scope, keep the longest, convert it to tokens in proportion to the request's own estimated prompt tokens (`promptEstimate * commonChars / totalChars`), round DOWN to a multiple of 64, keep it below the prompt estimate and record it as `prompt_tokens_details.cached_tokens`. A request with nothing in common gets 0. A different key never sees another key's prefixes. No tokenizer and no fixed ratio is used.

#### Scenario: Agent turn that only appends
- **WHEN** a request repeats the previous prompt and appends a new user turn
- **THEN** the estimated cached tokens are the shared fraction of the prompt, rounded down to a multiple of 64

#### Scenario: Cold request
- **WHEN** nothing from the scope is remembered, or the remembered text expired
- **THEN** the estimated cached tokens are 0

#### Scenario: System prompt changed
- **WHEN** the system part differs from every remembered text
- **THEN** the estimated cached tokens are 0

#### Scenario: Another customer
- **WHEN** a different API key sends the same prompt
- **THEN** it gets 0, not the first customer's prefix

#### Scenario: Price
- **WHEN** an estimated row has an estimated cached part
- **THEN** its cost charges that part at the cached rate and the rest of the prompt at the input rate

### Requirement: An estimated cache is labelled wherever it is shown
A row whose cached part is estimated SHALL keep `estimated: true` and carry `cacheEstimated: true` in its meta, in the key receipts API and in the account usage rows. The usage pages (`/usage` history and by-model table, `/account/usage`) SHALL show the cached number with a leading "≈" and the tooltip "Ước lượng, upstream không báo cache"; an aggregate (by-model row, total) that contains at least one such row with cached tokens above zero SHALL be marked the same way. A cold request whose cached part is 0 is still labelled an estimate. Admin tables other than these are not labelled.

#### Scenario: Receipt of an estimated row
- **WHEN** a key holder opens their receipts
- **THEN** the row has `estimated: true` and `cacheEstimated: true`, and the cached number is shown as "≈N"

### Requirement: The estimated cache is honest about its limits
The estimate SHALL be documented as an estimate that can be wrong: the upstream cache may have expired earlier or later than the router's 10 minutes, a provider may cache in different block sizes or only above a minimum prompt length, the characters-to-tokens proportion is approximate, concurrent requests of one key to the same upstream share one remembered history, and the memory is per process (lost on restart, not shared between instances). The option SHALL be enabled only for upstreams that really cache their prompt prefix; for an upstream that does not, it over-reports cached tokens and therefore under-charges.

#### Scenario: Upstream without a cache
- **WHEN** the option is on for an upstream that does not cache
- **THEN** the recorded cached part is an estimate that does not match reality, which is why the option is off by default

