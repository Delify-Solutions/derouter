## Why

Some CLIs send no `cache_control` at all, so a Claude/Anthropic-format upstream caches nothing for them and every turn pays the full prompt. The owner wants a per-provider Cache setting whose **auto** mode checks the request: if it carries no cache hint, add them; if the CLI already sent any, leave it as it is.

## What Changes

- Providers page: a **Cache** dropdown next to Thinking, shown only for providers whose upstream speaks the Claude/Anthropic format (the only format where the client has to mark what may be cached): `Mặc định` (unchanged behaviour) and `Auto (chèn nếu thiếu)`. Stored as `settings.providerCache[providerId] = { mode: "auto" }`; Default deletes the key.
- `chatCore`: after every step that can reshape the body (compressors, the existing re-anchor), a request going out in the Claude format, to a provider in Auto, is passed through `ensureClaudeCache`: **if the body has any `cache_control` anywhere (system, tools, messages) nothing changes**; otherwise breakpoints are added with the policy the router already uses for re-anchoring — last system block and last tool at 1h, the last assistant turn (or the last message on a first turn, and the final tool results of a tool loop) at 5m, never more than the upstream's 4 breakpoints and never on a thinking block. A string `system` and non-empty string message contents are turned into one text block each so a breakpoint can sit on them.
- No behaviour change unless the admin picks Auto for a provider.
- **Where it matters**: for a built-in Claude-format provider (MiniMax, GLM, Kimi, DeepSeek-anthropic, Claude passthrough) the router's compat shaping already re-anchors or adds breakpoints, so Auto finds markers and changes little there. It is for custom `anthropic-compatible` nodes in strict mode (where the client's body is forwarded as sent and a CLI that sends no hint gets no cache) and for a first turn with nothing else to anchor. The 1h TTL on system/tools is the same one the compat shaping already sends to built-ins; a gateway in front of a non-Anthropic model that rejects `ttl` should be left on Default.
- **Copy-on-write**: the body is shared with the client's request and with the next account's attempt, so Auto builds a new body and never edits the shared one; a retry ships the same breakpoints as the first attempt.

## Non-goals
- OpenAI-format and Responses upstreams cache a stable prefix by themselves (no client markers), Gemini caches implicitly, and Codex already gets a `prompt_cache_key` from its executor: nothing to add there.
- Command Code's envelope carries no cache hint at all, so the dropdown is not shown for it.
- `github` and `opencode` have no Claude transport entry (some of their models resolve to a Claude target), so the dropdown is hidden for them.
- Auto never rewrites or moves a marker the client placed. (The router's existing compat shaping still re-anchors client markers on Claude passthrough, as before.)

## Capabilities
### New Capabilities
- `provider-cache`

## Impact
- No schema change. `open-sse/translator/formats/claude.js` (`ensureClaudeCache`, `providerCacheMode`), `open-sse/handlers/chatCore.js`, `src/sse/handlers/chat.js`, `providers/[id]/page.js`, `test/provider-cache.test.js`.
