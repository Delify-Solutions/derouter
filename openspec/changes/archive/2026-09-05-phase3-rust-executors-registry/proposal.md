## Why

Phases 1-2 made the Rust backend serve every admin route as JSON. The proxy still only serves the 6 executors ported in Phase 0 (openai, anthropic, azure, google, ollama, openai-compatible) and a minimal capabilities map. The Node original has 28 executors (22 unported) and a 123-entry provider registry that drive model availability, transport/auth config, and the executor selection for non-OpenAI-compatible providers (cursor w/ protobuf+checksum, kiro w/ token refresh, codex, gemini-cli, github, grok-cli/web, perplexity-web, iflow, qoder, trae, windsurf, zed, kimchi, mimo-free, commandcode, codebuddy ×2, devin-cli, antigravity, xiaomi-tokenplan, vertex). Phase 3 ports these so a client sending `model: "<combo>"` that resolves to any of the 123 providers gets the same upstream behavior as Node — eliminating the last functional gap before the Node proxy layer can be retired.

## What Changes

- **Port 22 remaining executors** to `derouter-rs/src/proxy/executors/`: cursor (Connect-RPC protobuf framing + CRC checksum headers via `open-sse/utils/cursorProtobuf.js` + `cursorChecksum.js`, http2 streaming fallback), kiro (token refresh via `tokenRefresh.js`, model resolution via `kiroConstants.js`), codex, gemini-cli, github, grok-cli, grok-web, perplexity-web, iflow, qoder, trae, windsurf, zed, kimchi, mimo-free, commandcode, codebuddy-cn, codebuddy-intl, devin-cli, antigravity, xiaomi-tokenplan, vertex (+ vertex-partner). Each implements the existing `ProviderExecutor` trait (`stream` + `complete` → `UpstreamResponse`).
- **Port the 123-entry provider registry** to `derouter-rs/src/providers/registry/`: a Rust module with one static entry per provider (id, priority, alias, display, category, transport{baseUrl, format, headers, auth scheme, quirks}, models, serviceKinds). Replaces the Phase 2 minimal capabilities map with the full `get_capabilities_for_model` + provider→alias + transport lookup.
- **Port supporting util modules**: `open-sse/utils/cursorProtobuf.js` and `cursorChecksum.js` → Rust protobuf framing + CRC32; `open-sse/services/tokenRefresh.js` → Rust token-refresh for kiro/codex/oauth executors; the `FORMATS` translator format registry where executors need response-shape translation.
- **Wire executors into `select_executor`** (`derouter-rs/src/proxy/executors/base.rs`): extend the match to all providers that have a specialized executor; DefaultExecutor-equivalent for unknown compatible providers stays the OpenAI-compat fallback (already present).
- **Wire the registry into `getComboModels` / model resolution / providers route**: `/api/providers`, `/api/models`, `/api/providers/{id}/models`, `/v1/models` now source from the full registry (provider alias, transport, capabilities) instead of the Phase 2 minimal map.
- **Frontend**: convert the cli-tools, mcp, media-providers, tunnel, pxpipe, translator, headroom, basic-chat, skills (if present), token-saver pages to TypeScript calling Rust (these are the Phase-3-area pages deferred in Phase 2). Plus convert the cli-tools/mcp/media/tunnel/pxpipe/translator/headroom Node routes that back those pages from Node to Rust where the pages need them; OAuth import flows for cursor/kiro/codex/etc. (the full `/api/oauth/*` set deferred from Phase 2 — only gitlab/pat was Phase 2).
- **Remove the Phase 2 minimal capabilities map** once the full registry is in (the registry's `models` + `serviceKinds` supersedes it).

## Capabilities

### New Capabilities
- `provider-executors`: the 22 specialized provider executors (cursor/kiro/codex/gemini-cli/github/grok-cli/grok-web/perplexity-web/iflow/qoder/trae/windsurf/zed/kimchi/mimo-free/commandcode/codebuddy-cn/codebuddy-intl/devin-cli/antigravity/xiaomi-tokenplan/vertex) that build upstream HTTP calls (auth headers, endpoint URL, body transform, streaming) beyond the OpenAI-compatible default
- `provider-registry`: the 123-entry registry of static provider metadata (id, alias, display, category, transport baseUrl/format/headers/auth, models, serviceKinds, capabilities) used for model resolution, provider validation, and executor selection
- `cli-tools-management`: the cli-tools routes (per-tool settings, statuses, mitm links) and their frontend pages
- `mcp-plugin-marketplace`: the MCP plugin SSE/message routes and marketplace UI
- `media-providers`: media (TTS/STT/embedding) provider routes (voices lists) and UI
- `tunnel-management`: tunnel enable/disable/status/install routes (Tailscale/Cloudflare/Deno/Vercel) and UI
- `pxpipe-management`: pxpipe start/stop/status/logs/install/stats routes and UI
- `translator-console`: translator send/translate/load/save/console-logs routes and UI
- `headroom-management`: headroom start/stop/status/restart/extras/proxy routes and UI

### Modified Capabilities
- `proxy-routing`: `getComboModels` + executor selection now source from the full 123-entry registry and the 22 new executors, so any provider resolves and proxies like Node
- `admin-portal`: `/api/providers`, `/api/models`, `/api/providers/{id}/models`, `/api/providers/suggested-models` source from the full registry (replacing the Phase 2 minimal capabilities map)
- `model-catalog`: the catalog's `caps` come from the full registry capabilities instead of the Phase 2 minimal map; model availability probes use real executors
- `rust-json-api`: the JSON admin surface extends to the cli-tools/mcp/media/tunnel/pxpipe/translator/headroom routes; oauth full flows added
- `ts-frontend`: the cli-tools/mcp/media/tunnel/pxpipe/translator/headroom/basic-chat/skills/token-saver pages convert to TypeScript

## Impact

- **Rust**: ~22 new executor files under `derouter-rs/src/proxy/executors/`; a `registry/` module (123 entries, likely one file per provider grouping or a few aggregate files); port of `cursorProtobuf`+`cursorChecksum` to Rust (prost or hand-rolled protobuf + CRC32); port of `tokenRefresh.js`; new route modules `cli_tools.rs`, `mcp.rs`, `media_providers.rs`, `tunnel.rs`, `pxpipe.rs`, `translator.rs`, `headroom.rs`; extend `oauth.rs` with cursor/kiro/codex import flows. `select_executor` + `getComboModels` updated.
- **Frontend**: convert ~15 sub-app pages (cli-tools with 20+ tool cards, mcp, media-providers, tunnel, pxpipe, translator, headroom, basic-chat, token-saver, skills) to TS.
- **Dependencies (Rust)**: likely `prost`/`prost-build` for protobuf (cursor Connect-RPC) OR a hand-rolled framing impl (cursor's protobuf is minimal — hand-roll to avoid build-script complexity); `http`/`hyper` http2 for cursor streaming (or `reqwest` with http2 feature, already present). CRC32 via `crc32fast` or a small impl. `uuid` (have). Token refresh uses `reqwest` (have).
- **DB**: no schema changes (executors/registry are in-code static data; tokens stored in settings/connections).
- **Honest scope note**: This is the largest phase (~22 executors + 123 registry entries + ~8 new route groups + ~15 page conversions). It is expected to take the bulk of remaining autopilot budget and may exhaust a single agent's context — the task list is grouped so osf-apply can checkpoint between groups. Executors with heavy external dependencies (cursor http2+protobuf, kiro token refresh) are highest-risk.
