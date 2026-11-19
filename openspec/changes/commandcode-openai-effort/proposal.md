## Why

The owner serves Command Code both through the built-in `commandcode` provider and through an OpenAI-compatible node pointed at Command Code's OpenAI API (`https://api.commandcode.ai/provider/v1`). Requests through the node intermittently failed with 400 `Invalid option: expected one of "off"|"low"|"medium"|"high"|"xhigh"|"max"`. The router treated the node as a plain OpenAI upstream and sent OpenAI efforts verbatim — `none` (Claude Code's background helper always sends it; a forced Off on the node produces it), `minimal`, `auto` — which Command Code's enum does not contain. Only requests routed to that node and carrying one of those values failed, hence "sometimes".

## What Changes

- One mapping, `toCommandCodeEffort(value, model)` in `thinkingUnified.js`, turns any effort into the value Command Code accepts for that model (catalog-driven: `none` → `off` or the model's lowest level, `minimal` → `low`, `auto` → `high`, unlisted levels → nearest listed, a model without an effort list → field omitted). The built-in `commandcode` thinking branch now uses it (behaviour unchanged except `ultra` → `max`).
- `applyThinking` gets `{ commandCodeNode }` (set by `translateRequest` from the node's base URL via `isCommandCodeNode`): for such a node the thinking intent is written only as Command Code's effort (Chat `reasoning_effort` / Responses `reasoning.effort`), instead of the shape the model family's name-based capabilities would pick (deepseek `thinking:{type}`, qwen `enable_thinking`, zai's own level mapping). This covers forced levels, compat mode and format conversions.
- `DefaultExecutor.transformRequest`: for such a node the effort that reaches it (also the strict same-format body, which skips `applyThinking`) is mapped with the same function, and the live Command Code catalog refresh is triggered as the native executor does. The client's body is never mutated.
- `forcedThinkingLevel` (thinkingUnified, used by chatCore): the provider's forced Thinking level for such a node is moved to a level Command Code's catalog lists, not one the model family's name-based level list guesses (e.g. Low on `deepseek/deepseek-v4-flash-fast` stays `low`).
- Nodes at any other host are unchanged by this change.

## Capabilities
### Modified Capabilities
- `provider-thinking` (introduced by the unarchived change `provider-thinking-force`; archive that change first)
- `proxy-transparency` (one more strict-mode exception: the effort for a Command Code-hosted node)

## Impact
- No schema change. `open-sse/translator/concerns/thinkingUnified.js`, `open-sse/translator/index.js`, `open-sse/handlers/chatCore.js`, `open-sse/executors/default.js`, `test/commandcode-openai-effort.test.js`.
