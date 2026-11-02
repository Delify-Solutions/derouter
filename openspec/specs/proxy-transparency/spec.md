# proxy-transparency Specification

## Purpose
Defines what the router may change on the way through a proxied request. For a CUSTOM NODE (a provider node the operator added, id `openai-compatible-*` or `anthropic-compatible-*`) whose format equals the client's (OpenAI chat to an OpenAI-compatible node, Anthropic to an Anthropic-compatible node, Responses to a Responses node) the router is transparent: the client's request reaches the upstream, and the upstream's response reaches the client, as sent, so provider prompt caching, billing and client behaviour match talking to the upstream directly. A BUILT-IN registry provider (MiniMax, Kimi, GLM, DeepSeek, Anthropic OAuth, ...) was chosen by the router's own registry entry and the client cannot know its quirks, so it keeps every shim its registry entry and executor rely on. The legacy shims for odd clients exist behind one operator setting.

## Requirements
### Requirement: Strict transparency is the default for custom nodes, one setting restores the shims
The setting `compatNormalization` (default `false`) SHALL select the behaviour for custom nodes. Off means strict transparency as specified below. On means the legacy compatibility behaviour (id repair, field stripping, tool-id rewriting, invented tool responses, `cache_control` rewriting, content filtering and the other shims listed in the requirements below). For a built-in registry provider the legacy shaping always runs, whatever the setting, exactly as before this specification. The following apply to every provider regardless: no token margin is added anywhere, an omitted `stream` follows the protocol default, a second `[DONE]` and a repeated finish chunk are not forwarded twice, a JSON document answering a streamed request has its usage recorded, and the admin's per-provider thinking override is mapped to the upstream's own field. The setting SHALL be changeable through the settings API and the Token Saver page of the admin console, and SHALL apply to the next request without a restart. Token savers (RTK, Headroom, Caveman, Ponytail, PXPipE) SHALL all default to off and run only when enabled; they are independent of this setting.

#### Scenario: Default
- **WHEN** no operator has changed the settings
- **THEN** `compatNormalization` is `false` and `rtkEnabled` is `false`

#### Scenario: Operator turns the shims back on
- **WHEN** the operator sets `compatNormalization` to `true`
- **THEN** the next request again gets the legacy repairs (for example `developer` becomes `system`, a missing tool response is inserted, `[DONE]` is added to a stream that lacks it), and no token count is ever inflated

### Requirement: Same-format response streams from a custom node are forwarded byte for byte
For a streamed response where the upstream is a custom node and its format equals the client format, the router SHALL enqueue each upstream SSE line exactly as received (including comment lines, `event:` lines, spacing of `data:`, non-standard fields, empty `tool_calls`, Azure fields, short ids, empty-content chunks and non-JSON data lines) and SHALL only observe usage and generated text on the side. Chunk boundaries of the network SHALL NOT change the bytes. Only these lines MAY be withheld: the usage-only chunk the router itself requested, a finish chunk that repeats one already delivered, and a second `[DONE]`.

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

### Requirement: One `[DONE]` at most, never invented in strict mode
The router SHALL deliver at most one `[DONE]` sentinel per stream. In strict mode it SHALL NOT synthesise one for an upstream that did not send it. In compat mode it SHALL add it for OpenAI chat streams only, never for Anthropic, Responses or Gemini-family streams.

#### Scenario: Upstream sends two sentinels
- **WHEN** an upstream ends its stream with `[DONE]` twice
- **THEN** the client receives one

### Requirement: Same-format JSON responses from a custom node are forwarded as received
For a non-streamed response where the upstream is a custom node and its format equals the client format, and no tool name was cloaked on the way in, the router SHALL return the upstream's body text as received (whitespace, field order and unknown fields included) with the upstream's content type, and SHALL read usage from a parsed copy. Rewrites of the body (forcing `finish_reason`, filling `object`/`created`, stripping Azure fields, whitelisting usage fields, removing `reasoning_content` when `content` is non-empty) SHALL happen only in compat mode.

#### Scenario: Reasoning is not removed
- **WHEN** an upstream returns a message with both `content` and `reasoning_content`
- **THEN** the client receives both, unchanged

#### Scenario: Provider extras survive
- **WHEN** an upstream body contains `service_tier` and `usage.prompt_cache_hit_tokens`
- **THEN** the client receives them

### Requirement: Same-format request bodies to a custom node are forwarded as sent
For a request where the upstream is a custom node and the client format equals the upstream format the router SHALL forward the client's body with these exceptions only: the upstream model id (and a `model(level)` suffix turned into the provider's own field), the `stream_options.include_usage` addition required by usage-accuracy, and credentials. Field order and message content SHALL be preserved so provider prefix caching is not disturbed. The following run only in compat mode, for a real format conversion, or for a built-in provider: removing `thinking` when the last message is not from the user, rewriting tool-call ids, inserting empty tool responses, dropping thinking/reasoning fields for models not in the capability table, role and content filtering for OpenAI bodies (`developer` to `system`, `cache_control` and `signature` stripping, dropping blank messages, normalising tools), Anthropic preparation (rewriting every `cache_control` breakpoint, clamping `max_tokens` to a table ceiling, filtering built-in tools), `json_schema` to `json_object` fallback with an injected system prompt, name-keyed parameter stripping, name-keyed `reasoning_content` injection, dropping media for models the capability table marks text-only, tool de-duplication for Claude clients, and defaulting the Claude tool `type`. For a Claude Code client (a `claude-cli` user agent) the same holds: sent to a custom Anthropic node, its body SHALL NOT be reshaped (system turns folded, thinking blocks dropped, empty text removed, cache breakpoints re-anchored, tools de-duplicated, tool `type` defaulted) and its warmup, title and `count` requests SHALL reach the upstream instead of receiving a canned reply; this shaping and the canned replies remain for built-in providers and in compat mode. For a built-in Claude-format provider (MiniMax, Kimi, GLM, DeepSeek-anthropic, Xiaomi) a Claude body still goes through `prepareClaudeRequest`: tool `type` default, tool_use/tool_result ordering fix, thinking placeholder and signature handling, thinking-budget and `max_tokens` reconciliation and clamp. The `ccFilterNaming` option is a separate opt-in and is unchanged. Shims that the provider registry declares for a provider (quirks such as `dropClientMetadata` and `dropOutputConfig`, a provider's `reasoningInject`, provider-keyed parameter strips, the OAuth billing header for an OAuth credential) remain, because that provider requires them.

#### Scenario: OpenAI body is untouched
- **WHEN** an OpenAI chat request contains a `developer` message, a blank user message, a tool call with the id `call:1` and no tool response, and `reasoning_effort`
- **THEN** the upstream receives all of it unchanged in the same order, plus `stream_options` when streaming

#### Scenario: Anthropic body keeps the client's cache breakpoints
- **WHEN** an Anthropic request sets `cache_control` on system and message blocks, `max_tokens: 200000` and a tool without `type`
- **THEN** the upstream receives the same body with only the model id replaced

#### Scenario: Responses body keeps reasoning
- **WHEN** a Responses request sets `reasoning: {effort: "high"}` for a custom node
- **THEN** the upstream receives it unchanged

#### Scenario: Claude Code through a custom node
- **WHEN** a Claude Code client streams to an Anthropic-compatible custom node, including a `Warmup` request
- **THEN** the upstream receives the client's body unchanged (its own `cache_control` breakpoints included) and answers the warmup itself

#### Scenario: Name-based rules do not hit custom nodes
- **WHEN** a custom OpenAI-compatible node serves a model called `deepseek-*`, `kimi-*` or `claude-*`
- **THEN** assistant turns get no injected `reasoning_content` and `temperature` is not dropped

#### Scenario: Built-in providers keep their shaping
- **WHEN** a Claude-format body is sent to a built-in provider such as MiniMax, or a `kimi-*` model is called through built-in Kimi, in default mode
- **THEN** the body is prepared as before (cache breakpoints re-anchored, tool `type` defaulted, `max_tokens` clamped) and Kimi assistant turns get `reasoning_content`

#### Scenario: Admin thinking override
- **WHEN** the admin's per-provider thinking override injected a top-level `thinking` into an OpenAI-format body, or `reasoning_effort` into an Anthropic-format body
- **THEN** it is mapped to the upstream's own field (or dropped for a model that cannot reason), never sent in the wrong format, also for a custom node in strict mode

### Requirement: An omitted `stream` means a JSON response
For OpenAI chat, Anthropic Messages and Responses requests the router SHALL treat an omitted `stream` as `false`, as the protocols define, so that what the router expects is what the upstream sends. The legacy default (stream unless `false`) applies in compat mode and to the Gemini-family formats. The router SHALL NOT add `stream_options` to a body that does not itself stream.

#### Scenario: Curl without stream
- **WHEN** a client posts a chat request without a `stream` field and without an Accept header
- **THEN** the upstream receives no `stream_options`, the client receives the JSON body as sent by the upstream, and the usage is recorded

### Requirement: Format conversion keeps what the target can express
A conversion between different formats is the product and SHALL remain, but it SHALL be lossless for what the target format can express: no truncation of text, tool arguments, reasoning or images, usage mapped with the semantics of usage-accuracy, and, for a custom node, the client's own limits kept (a built-in provider keeps the legacy `max_tokens` policy and the identity prompt it relies on): `max_tokens` is forwarded as sent (Anthropic, which requires it, gets 64000 only when the client sent neither `max_tokens` nor `max_completion_tokens`, and a thinking budget still gets room), a model's code fences are not stripped, and the "You are Claude Code" identity prompt is added only for an OAuth credential. Limits imposed by the target format itself remain: Gemini function names are limited to 64 characters, Responses call ids to 64, Kiro tool names, descriptions and ids to Kiro's limits, and remote images are fetched to base64 for targets that cannot fetch URLs. Automatic cache breakpoints are still added when an OpenAI-format client is converted to Anthropic, because that client cannot express them.

#### Scenario: Client limit survives conversion
- **WHEN** an OpenAI client with tools sends `max_tokens: 4096` to an Anthropic upstream
- **THEN** the upstream receives `max_tokens: 4096`

#### Scenario: Large limit survives conversion
- **WHEN** an Anthropic client sends `max_tokens: 100000` to an OpenAI-compatible upstream
- **THEN** the upstream receives `max_tokens: 100000`

### Requirement: Retained copies are bounded, forwarded and billed data are not
Capping and truncation (`STREAM_MAX_BUFFER_BYTES`, the middle-truncating retained copy) SHALL apply only to the copies kept for logs and request details, never to the bytes forwarded to the client and never to the usage recorded or billed. When a cap trips the completed usage object SHALL carry `_truncated`.

#### Scenario: Very long reply
- **WHEN** a stream's text exceeds the retained-copy cap
- **THEN** the client still receives every byte and the usage row is the upstream's figure

### Requirement: Known limits of transparency
The router SHALL document these limits and SHALL NOT claim byte-exact forwarding beyond them. Built-in Responses-format providers (`codex`, `grok-cli`, `perplexity-agent`) are streamed through the Responses translation path: their events are re-serialised (only `usage: null` fields are preserved) and a stream that ends or is cut before `response.completed` still gets a synthesised `response.failed` and `[DONE]`. A JSON document returned for a streamed request is forwarded byte for byte but with the SSE response headers. A held terminal event (Anthropic, Responses, Gemini client behind an OpenAI chat upstream) is released after `FINISH_HOLD_RELEASE_MS` (1500 ms) if no usage chunk, `[DONE]` or end of stream arrived, with the best usage known (zeroed placeholder for Anthropic, no usage for Responses); the figures that arrive later are still recorded. Request bodies are parsed and re-serialised, so insignificant whitespace, duplicate keys and number formatting of the client's JSON are not preserved (field order and content are). The legacy canned replies for Claude Code warmup/title/`count` requests run before routing only in compat mode and after routing for built-in providers.

#### Scenario: Silent upstream after the finish chunk
- **WHEN** an OpenAI chat upstream sends the finish chunk and then nothing, without closing the socket, and the client speaks the Anthropic format
- **THEN** the client receives its `message_delta` and `message_stop` about 1.5 s after the finish chunk instead of after the stall timeout

### Requirement: Default changes are documented for operators
The operator notes (README, section "Operations notes") SHALL state the two default changes of this specification and how to restore each: `compatNormalization` is `false` (strict for custom nodes; set it to `true` in Token Saver → "Chế độ tương thích" or with `PATCH /api/settings {"compatNormalization": true}` to restore the legacy shaping), and `rtkEnabled` is `false` (previously `true`; set it to `true` in Token Saver or with `PATCH /api/settings {"rtkEnabled": true}`; an installation that had saved the value keeps it).

#### Scenario: Operator wants the old behaviour back
- **WHEN** an operator reads the operations notes
- **THEN** they find the exact setting names and the two ways to set them

### Requirement: Routing, authentication, errors and the error log are unaffected
Combos and fallback, API-key enforcement and plan checks, upstream error mapping, billing and the error log trace SHALL behave as before; transparency changes only the bodies and streams that pass through.

#### Scenario: Combo and error paths
- **WHEN** a request names a combo, or an upstream answers with an error status
- **THEN** routing, the error status mapping and the error log entry are the same as before this specification
