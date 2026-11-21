## MODIFIED Requirements

### Requirement: Same-format response streams from a custom node are forwarded byte for byte
For a streamed response where the upstream is a custom node and its format equals the client format, the router SHALL enqueue each upstream SSE line exactly as received (including comment lines, `event:` lines, spacing of `data:`, non-standard fields, empty `tool_calls`, Azure fields, short ids, empty-content chunks and non-JSON data lines) and SHALL only observe usage and generated text on the side. Chunk boundaries of the network SHALL NOT change the bytes. Only these lines MAY be withheld: the usage-only chunk the router itself requested, a finish chunk that repeats one already delivered, and a second `[DONE]`. One exception: for a customer key with `hideUpstreamModels` on, the model fields, the provider-identifying fields, the usage extras, the chat-completion, Claude message and Gemini response ids, and the error texts of each JSON `data:` line are rewritten as specified in model-privacy, and that line is re-serialised (an event whose JSON data spans several `data:` lines is read whole, masked once and written as one `data:` line); data that is not JSON has URLs, host names and hidden ids removed as specified in model-privacy; every other line (`event:`, comments, blank lines, `[DONE]`) is still forwarded unchanged. A JSON document, JSON array or sequence of JSON lines answering the streamed request is, for such a key, held and masked as a document as specified in model-privacy.

#### Scenario: Usage inside the finish chunk
- **WHEN** an OpenAI-compatible upstream streams a reply whose finish chunk carries usage
- **THEN** the client receives exactly the bytes the upstream sent

#### Scenario: Gateway that repeats the finish chunk
- **WHEN** an upstream sends a finish chunk, a usage-only chunk, the finish chunk again and `[DONE]`, and the client asked for usage
- **THEN** the client receives the first finish chunk, the usage chunk and one `[DONE]`; the repeated finish chunk is withheld

#### Scenario: Unusual but valid lines
- **WHEN** an upstream stream contains a comment line, a `data:` line without a space and a chunk with `"tool_calls": []`
- **THEN** all of them reach the client unchanged

#### Scenario: Anthropic and Responses streams
- **WHEN** the upstream streams Anthropic events or Responses events to a client of the same format
- **THEN** the client receives the bytes unchanged and no `[DONE]` is appended to the Anthropic stream or the Responses stream

#### Scenario: Customer key
- **WHEN** a customer key streams a combo from a custom node with `hideUpstreamModels` on
- **THEN** each JSON `data:` line carries the combo name in its model field, a router-generated id and only standard usage fields, and is otherwise the same data

### Requirement: Same-format JSON responses from a custom node are forwarded as received
For a non-streamed response where the upstream is a custom node and its format equals the client format, and no tool name was cloaked on the way in, the router SHALL return the upstream's body text as received (whitespace, field order and unknown fields included) with the upstream's content type, and SHALL read usage from a parsed copy. Rewrites of the body (forcing `finish_reason`, filling `object`/`created`, stripping Azure fields, whitelisting usage fields, removing `reasoning_content` when `content` is non-empty) SHALL happen only in compat mode. One exception: for a customer key with `hideUpstreamModels` on, the body is re-serialised with its model fields, provider-identifying fields, usage extras, ids and errors rewritten as specified in model-privacy.

#### Scenario: Reasoning is not removed
- **WHEN** an upstream returns a message with both `content` and `reasoning_content`
- **THEN** the client receives both, unchanged

#### Scenario: Provider extras survive
- **WHEN** an upstream body contains `service_tier` and `usage.prompt_cache_hit_tokens` and the caller is an admin key
- **THEN** the client receives them

#### Scenario: Provider extras for a customer
- **WHEN** the same body answers a customer key with `hideUpstreamModels` on
- **THEN** `service_tier` and the message are unchanged and `usage.prompt_cache_hit_tokens` is absent

## ADDED Requirements

### Requirement: Responses objects the router builds carry the router's own ids
When the router builds a Responses API response itself, because the client speaks the Responses format and the upstream does not (a Chat Completions, Claude or other non-Responses upstream, streamed or not), the response id SHALL be `resp_` followed by a random value the router generates once per response, and the reasoning and message item ids SHALL be derived from that id. Neither SHALL contain or be derived from the upstream's own id, for any caller. Every event of one stream SHALL carry the same response id. Tool-call ids (`call_id`, and the `fc_`/`ctc_` item ids built from them) SHALL keep the upstream's value. A Responses-format upstream answering a Responses client keeps its own ids.

#### Scenario: OpenRouter behind a Responses client
- **WHEN** a Responses client streams through a Chat Completions upstream whose chunks carry `"id":"gen-1763-abc"`
- **THEN** every event carries the same `resp_<random>` response id, the item ids are built from it, and no event contains `gen-1763-abc`

#### Scenario: Non-streamed reply
- **WHEN** the same client asks without streaming and the upstream body has `"id":"msg_bdrk_01ABC"` and a tool call `call_up_7`
- **THEN** the response id is `resp_<random>` and the function-call item keeps `call_id: "call_up_7"`
