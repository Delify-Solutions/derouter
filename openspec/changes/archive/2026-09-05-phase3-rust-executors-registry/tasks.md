## 1. Provider registry (Rust data)

- [ ] 1.1 Create `derouter-rs/src/providers/registry/mod.rs` with `ProviderRegistryEntry` struct (id, priority, alias, ui_alias, display, category, transport{baseUrl, format, urlSuffix, headers, auth, quirks}, models, service_kinds) + lookup functions (by_id, by_alias, all, classify helpers)
- [ ] 1.2 Port all 123 entries from `open-sse/providers/registry/*.js` into category-grouped files: `derouter-rs/src/providers/registry/{apikey,oauth,web_cookie,free_tier,compatible,embedding,media}.rs`, each `pub const ENTRIES: &[ProviderRegistryEntry] = &[...]`
- [ ] 1.3 Replace Phase 1 provider lists (`APIKEY_PROVIDERS`/`FREE_TIER`/`WEB_COOKIE`) + `providers/classify.rs` with registry-derived classification (`category` field + `serviceKinds`)
- [ ] 1.4 Port `get_capabilities_for_model` from `open-sse/providers/capabilities.js` into `derouter-rs/src/providers/registry/capabilities.rs` sourced from the full registry ← (verify: `cargo build` clean; `get_capabilities_for_model("anthropic","claude-3-5-sonnet-20241022")` returns Node-matching caps; `by_alias("cc")` returns the claude entry; all 123 entries present)

## 2. Translator formats (Rust)

- [ ] 2.1 Port `open-sse/translator/formats.js` (the `FORMATS` registry) into `derouter-rs/src/proxy/translator.rs`: request/response shape adapters for `claude`, `openai`, `gemini`, and any other format the executors use
- [ ] 2.2 Wire `transport.format` → translator selection so executors pick the right request/response shape ← (verify: a `claude`-format transport produces the Anthropic request shape and decodes the Anthropic response)

## 3. Simple executors (Rust) — OpenAI-like transports

- [ ] 3.1 Port `open-sse/executors/vertex.js` (vertex + vertex-partner) → `derouter-rs/src/proxy/executors/vertex.rs`
- [ ] 3.2 Port `gemini-cli.js`, `github.js`, `iflow.js`, `qoder.js`, `perplexity-web.js`, `commandcode.js`, `xiaomi-tokenplan.js`, `mimo-free.js`, `kimchi.js`, `zed.js`, `windsurf.js`, `trae.js`, `codebuddy-cn.js`, `codebuddy-intl.js`, `devin-cli.js`, `antigravity.js`, `grok-web.js`, `grok-cli.js`, `opencode.js` → one executor file each under `derouter-rs/src/proxy/executors/`
- [ ] 3.3 Each executor implements `ProviderExecutor` (stream + complete), reads auth from `conn.data`, applies the transport format translator, returns `UpstreamResponse`; missing credentials → clear 401/400 JSON (no panic)
- [ ] 3.4 Extend `select_executor` in `base.rs` with match arms for each new provider + aliases (`cu`→cursor, `gcli`/`gb`→grok-cli, `mmf`→mimo-free, `vertex-partner`→vertex, etc.); keep `_ => OpenAiCompatExecutor` fallback ← (verify: `cargo build` clean; `select_executor("github")` returns the github executor; unknown provider → OpenAiCompat; each executor's url/headers/body match the Node executor for a sample request)

## 4. High-risk executors (Rust)

- [ ] 4.1 Port `open-sse/utils/cursorProtobuf.js` → `derouter-rs/src/proxy/executors/cursor_proto.rs` (Connect-RPC framing: field encode, envelope wrap, GZIP/trailer flags) + `open-sse/utils/cursorChecksum.js` → `build_cursor_headers` (CRC32, via `crc32fast` or hand-rolled). Byte-verify against the JS output for a known body.
- [ ] 4.2 Port `cursor.js` → `derouter-rs/src/proxy/executors/cursor.rs` (encode body, set checksum headers, send via reqwest http2 when available fallback http1, decode frames → SSE chunks `chatChunkSse`/`sseChunk` shapes). If the encoder can't be byte-verified matching JS, STOP and surface as a known limitation (defer cursor to Phase 4, keep on Node) — do NOT ship a silently-broken executor.
- [ ] 4.3 Port `open-sse/services/tokenRefresh.js` `refreshKiroToken` → `derouter-rs/src/proxy/executors/kiro_token.rs` (check expiry, refresh via stored creds, update connection in DB, in-memory refresh cache)
- [ ] 4.4 Port `kiro.js` → `derouter-rs/src/proxy/executors/kiro.rs` (resolveKiroModel via ported `kiroConstants`, token refresh on expiry, kiro event shapes as SSE)
- [ ] 4.5 Port `codex.js` → `derouter-rs/src/proxy/executors/codex.rs` (oauth bearer auth, token refresh reuse) ← (verify: cursor body encodes byte-for-byte matching JS for a sample (or deferred w/ documented note); kiro refresh path runs when token expired; codex missing token → clear error, no panic)

## 5. Remove Phase 2 minimal caps map

- [ ] 5.1 Delete `derouter-rs/src/providers/capabilities.rs` (the Phase 2 minimal map); update `models.rs` route + any callers to use `providers::registry::capabilities::get_capabilities_for_model` ← (verify: `cargo build` clean; `GET /api/models` caps now come from the full registry; no duplicate capability sources)

## 6. cli-tools, media, mcp, tunnel, pxpipe, translator, headroom routes (Rust)

- [ ] 6.1 Create `derouter-rs/src/web/routes/cli_tools.rs`: `GET /api/cli-tools/all-statuses`, per-tool `GET/POST /api/cli-tools/<tool>-settings` (claude/codex/copilot/cline/opencode/jcode/kilo/openclaw/hermes/grok-build/deepseek-tui/droid/devin/cowork), `GET /api/cli-tools/antigravity-mitm`, `/antigravity-mitm/alias`, `/cowork-mcp-registry`, `/cowork-mcp-tools`
- [ ] 6.2 Create `derouter-rs/src/web/routes/media_providers.rs`: `GET /api/media-providers/tts/voices` + `/deepgram|elevenlabs|inworld|minimax/voices` (reqwest to provider with creds; 400 when unconfigured)
- [ ] 6.3 Create `derouter-rs/src/web/routes/mcp.rs`: `GET /api/mcp/{plugin}/sse` (forward SSE), `POST /api/mcp/{plugin}/message`
- [ ] 6.4 Create `derouter-rs/src/web/routes/tunnel.rs`: `GET /api/tunnel/status`, `POST enable|disable`, `GET tailscale-check`, `POST tailscale-enable|disable|install` (platform CLI/API; JSON errors)
- [ ] 6.5 Create `derouter-rs/src/web/routes/pxpipe.rs`: `GET health|status|stats|logs`, `POST start|stop|restart|install`
- [ ] 6.6 Create `derouter-rs/src/web/routes/headroom.rs`: `GET status|extras`, `POST start|stop|restart`, `ANY /api/headroom/proxy/{*path}` passthrough
- [ ] 6.7 Create `derouter-rs/src/web/routes/translator.rs`: `POST send|translate`, `GET load`, `POST save`, `GET console-logs`, `GET console-logs/stream` (SSE)
- [ ] 6.8 Extend `derouter-rs/src/web/routes/oauth.rs`: port `oauth/[provider]/[action]` + `oauth/cursor/{auto-import,import}` + `oauth/kiro/{api-key,auto-import,import,import-cli-proxy,social-authorize,social-exchange}` + `oauth/codex/{bulk-import,import-token}` + `oauth/grok-cli/bulk-import` + `oauth/iflow/cookie` (full flows; gitlab/pat already done Phase 2)
- [ ] 6.9 Mount all new `/api/*` routes in `main.rs` behind auth (except headroom proxy passthrough) ← (verify: each route JSON with cookie, 401 without; platform errors are JSON not 500; SSE routes return text/event-stream)

## 7. Wire registry into proxy resolution + admin routes

- [ ] 7.1 Update `getComboModels` / proxy model resolution in `derouter-rs/src/proxy/` to look up the provider in the registry for transport + executor selection (format → translator)
- [ ] 7.2 Update `/api/providers`, `/api/providers/{id}/models`, `/api/providers/suggested-models`, `/api/providers/kilo/free-models`, `/api/models` to source from the full registry
- [ ] 7.3 Update `/api/models/availability` to probe via real executors (not the Phase 2 stub) ← (verify: a real cursor/kiro/github combo request via `/v1/chat/completions` returns a completion matching Node behavior; `/api/models` caps from registry; `/api/models/availability` reflects real probes)

## 8. Frontend types + Phase 3 page conversions (TS)

- [ ] 8.1 Add to `src/shared/types/index.ts`: `CliToolStatus`, `CliToolSettings`, `McpPlugin`, `MediaVoice`, `TunnelStatus`, `PxpipeStatus`, `TranslatorFormat`, `HeadroomStatus`, `OAuthImportResult` matching Rust shapes
- [ ] 8.2 Convert `src/app/(dashboard)/dashboard/cli-tools/page.js` + `[toolId]/{page,ToolDetailClient}.js` + `cli-tools/components/*` (all tool cards + ApiKeySelect/BaseUrlSelect/EndpointPresetControl + cliEndpointPresets/Match) → `.tsx`
- [ ] 8.3 Convert `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/*` remaining + `media-providers/*` pages (`[kind]`, `web`, `[kind]/[id]`, `[kind]/combo/[id]` + Embedding/Generic/Stt/Tts example cards) → `.tsx`
- [ ] 8.4 Convert `mcp`, `tunnel`, `pxpipe`, `translator`, `headroom`, `basic-chat`, `token-saver`, `skills`, `mitm` pages + their client components → `.tsx` calling Rust (+ SSE for mcp/translator/headroom)
- [ ] 8.5 Replace `fetch('/api/...')` in converted Phase 3 pages with the typed apiClient; add a small SSE helper (EventSource w/ credentials or fetch-ReadableStream) for streaming pages ← (verify: `npx tsc --noEmit` 0 errors for all converted files; cli-tools page fetches from Rust; mcp page connects to Rust SSE)

## 9. Build + end-to-end verification

- [ ] 9.1 `cargo build --release` clean; `cargo clippy -D warnings` clean for new Phase 3 files (pre-existing Phase 0 dead-code allowed)
- [ ] 9.2 `npx tsc --noEmit` 0 errors for all converted files
- [ ] 9.3 Real-provider sweep: `POST /v1/chat/completions` with a real cursor/kiro/codex/github/grok-cli combo key → completion matching Node
- [ ] 9.4 `docker compose up` → both services; browser: cli-tools configures a tool; mcp streams; a provider-model combo proxies; proxy `/v1/*` unchanged for OpenAI/Anthropic ← (verify: full Phase 3 acceptance — all 123 providers proxy via Rust registry + 22 executors; all dashboard pages in TS; Node admin layer redundant and ready for Phase 4 removal)
