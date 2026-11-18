## Why

The Providers page has a "Thinking" dropdown per provider. It only *filled in* a level when the client sent none, and it had no way to switch thinking off, so an admin could not make a provider use a fixed level for every customer CLI. The owner wants three clear modes:

- **Auto**: keep whatever thinking level the user's CLI chose.
- **A level (Low … Max)**: use that level for every request to the provider, whatever the user's CLI sent.
- **Off**: switch thinking off.

## What Changes

- The stored per-provider setting is carried as the same `model(level)` suffix a client may send, which the translator already treats as the top-priority thinking instruction: it drops every thinking field of the client's body (Claude `thinking`/`output_config`, OpenAI `reasoning_effort`/`reasoning`, Gemini, Qwen …) and writes the one the target provider understands, in strict same-format mode too, and for native passthrough clients (Claude Code → claude).
- `Off` is `(none)`: for providers that cannot be switched off the existing per-format clamp applies (e.g. Gemini 3 maps it to its lowest level, Codex keeps its floor).
- A suffix the client put on the model is replaced by the forced level.
- The older stored value `on` is read as `medium`.
- Providers page: `Thinking: Auto (theo CLI của user)`, `Thinking: Off (tắt)`, `Thinking: <Level> (ép mức)`; the copied model name still gets `(level)`.

## Capabilities
### New Capabilities
- `provider-thinking`

## Impact
- No schema change. `open-sse/translator/concerns/thinkingUnified.js` (`providerThinkingSuffix`, `withThinkingSuffix`), `open-sse/handlers/chatCore.js`, `providers/[id]/page.js`, `test/provider-thinking.test.js`.
