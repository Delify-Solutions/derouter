## MODIFIED Requirements

### Requirement: Same-format response streams from a custom node are forwarded byte for byte
For a streamed response where the upstream is a custom node and its format equals the client format, the router SHALL enqueue each upstream SSE line exactly as received (including comment lines, `event:` lines, spacing of `data:`, non-standard fields, empty `tool_calls`, Azure fields, short ids, empty-content chunks and non-JSON data lines) and SHALL only observe usage and generated text on the side. Chunk boundaries of the network SHALL NOT change the bytes. Only these lines MAY be withheld: the usage-only chunk the router itself requested, a finish chunk that repeats one already delivered, and a second `[DONE]`. One exception: for a customer key with `hideUpstreamModels` on, the model fields, the `provider` field and error texts of each JSON `data:` line are rewritten as specified in model-privacy, and that line is re-serialised; every other line is still forwarded unchanged.

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
- **THEN** each JSON `data:` line carries the combo name in its model field and is otherwise the same data

### Requirement: Same-format JSON responses from a custom node are forwarded as received
For a non-streamed response where the upstream is a custom node and its format equals the client format, and no tool name was cloaked on the way in, the router SHALL return the upstream's body text as received (whitespace, field order and unknown fields included) with the upstream's content type, and SHALL read usage from a parsed copy. Rewrites of the body (forcing `finish_reason`, filling `object`/`created`, stripping Azure fields, whitelisting usage fields, removing `reasoning_content` when `content` is non-empty) SHALL happen only in compat mode. One exception: for a customer key with `hideUpstreamModels` on, the body is re-serialised with its model fields, `provider` field and errors rewritten as specified in model-privacy.

#### Scenario: Reasoning is not removed
- **WHEN** an upstream returns a message with both `content` and `reasoning_content`
- **THEN** the client receives both, unchanged

#### Scenario: Provider extras survive
- **WHEN** an upstream body contains `service_tier` and `usage.prompt_cache_hit_tokens`
- **THEN** the client receives them
