## MODIFIED Requirements

### Requirement: Same-format request bodies to a custom node are forwarded as sent
For a request where the upstream is a custom node and the client format equals the upstream format the router SHALL forward the client's body with these exceptions only: the upstream model id (and a `model(level)` suffix turned into the provider's own field), the `stream_options.include_usage` addition required by usage-accuracy, the cache breakpoints that an admin-selected Cache `auto` setting adds to a request that carries none (never to one that already carries any, and never rewriting a marker the client placed), and credentials. Field order and message content SHALL be preserved so provider prefix caching is not disturbed. The following run only in compat mode, for a real format conversion, or for a built-in provider: removing `thinking` when the last message is not from the user, rewriting tool-call ids, inserting empty tool responses, dropping thinking/reasoning fields for models not in the capability table, role and content filtering for OpenAI bodies (`developer` to `system`, `cache_control` and `signature` stripping, dropping blank messages, normalising tools), Anthropic preparation (rewriting every `cache_control` breakpoint, clamping `max_tokens` to a table ceiling, filtering built-in tools), `json_schema` to `json_object` fallback with an injected system prompt, name-keyed parameter stripping, name-keyed `reasoning_content` injection, dropping media for models the capability table marks text-only, tool de-duplication for Claude clients, and defaulting the Claude tool `type`. For a Claude Code client (a `claude-cli` user agent) the same holds: sent to a custom Anthropic node, its body SHALL NOT be reshaped (system turns folded, thinking blocks dropped, empty text removed, cache breakpoints re-anchored, tools de-duplicated, tool `type` defaulted) and its warmup, title and `count` requests SHALL reach the upstream instead of receiving a canned reply; this shaping and the canned replies remain for built-in providers and in compat mode. For a built-in Claude-format provider (MiniMax, Kimi, GLM, DeepSeek-anthropic, Xiaomi) a Claude body still goes through `prepareClaudeRequest`: tool `type` default, tool_use/tool_result ordering fix, thinking placeholder and signature handling, thinking-budget and `max_tokens` reconciliation and clamp. The `ccFilterNaming` option is a separate opt-in and is unchanged. Shims that the provider registry declares for a provider (quirks such as `dropClientMetadata` and `dropOutputConfig`, a provider's `reasoningInject`, provider-keyed parameter strips, the OAuth billing header for an OAuth credential) remain, because that provider requires them.

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
