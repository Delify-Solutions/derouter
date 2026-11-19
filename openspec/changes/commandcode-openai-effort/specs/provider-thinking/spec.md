## ADDED Requirements

### Requirement: An OpenAI-compatible node at Command Code sends Command Code efforts
When an OpenAI-compatible node's endpoint is a Command Code host (`commandcode.ai` or a subdomain), the router SHALL express the request's thinking intent (the client's effort, a Claude/Gemini/Qwen thinking field after format conversion, or the provider's forced Thinking setting) only as Command Code's effort — Chat `reasoning_effort` or Responses `reasoning.effort` — using the same per-model catalog mapping as the built-in Command Code provider, never as the model family's own thinking shape (`thinking`, `enable_thinking`, `thinking_budget`). The mapping: no thinking becomes `off` (or the model's lowest listed level when it cannot switch off; omitted for a model not in the catalog), `minimal` becomes `low`, `auto` becomes `high`, `ultra` becomes `max`, an unlisted level moves to the nearest listed one (the lower on a tie), and a model whose catalog entry has no effort list receives no effort. This SHALL hold in strict transparency mode, in compat mode and after a format conversion, because a value outside Command Code's enum (`off|low|medium|high|xhigh|max`) is always refused. Requests through such a node SHALL also keep the live catalog refreshed, as the built-in provider does. Nodes at other hosts are not changed by this requirement.

#### Scenario: Claude Code helper through the node
- **WHEN** a client sends `reasoning_effort: "none"` for `deepseek/deepseek-v4.1-flash` to a node at `https://api.commandcode.ai/provider/v1`
- **THEN** the upstream receives `reasoning_effort: "off"` and the request is not refused

#### Scenario: Forced Off on the node
- **WHEN** the node's Thinking setting is Off and a request for `deepseek/deepseek-v4.1-flash` arrives
- **THEN** the upstream receives `reasoning_effort: "off"` and no `thinking` object

#### Scenario: OpenAI-only values
- **WHEN** a request through that node carries `minimal` or `auto`
- **THEN** the upstream receives `low` or `high` (or the nearest level the model lists)

#### Scenario: Model family shapes are not used
- **WHEN** a request for `Qwen/Qwen4-Max` with `reasoning_effort: "medium"` goes through the node in compat mode
- **THEN** the upstream receives a listed effort and no `enable_thinking` or `thinking_budget`
