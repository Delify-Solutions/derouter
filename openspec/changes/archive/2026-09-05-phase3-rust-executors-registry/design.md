## Context

Phases 1-2 are done: Rust serves every admin route as JSON, TS scaffold + core/Phase 2 pages converted, proxy `/v1/*` works for the 6 Phase 0 executors (openai, anthropic, azure, google, ollama, openai-compatible) + minimal capabilities map. The Node original has 28 executors (22 unported) and a 123-entry `open-sse/providers/registry/*.js` that drive transport/auth/executor selection for non-compatible providers. This phase closes the last functional gap: any combo resolving to any of the 123 providers proxies like Node, the admin providers/models use the full registry, and the remaining dashboard pages (cli-tools/mcp/media/tunnel/pxpipe/translator/headroom/basic-chat/token-saver/skills) convert to TS.

Existing Rust reused: `ProviderExecutor` trait (`stream`+`complete` → `UpstreamResponse`), `select_executor`, `getComboModels`, the proxy `/v1/*` routes, `auth::require_auth`, the Phase 1-2 admin routes, the CORS layer, the r2d2/rusqlite pool.

## Goals / Non-Goals

**Goals:**
- 22 specialized executors ported with upstream-parity (auth, URL, body transform, stream/decode).
- 123-entry registry in Rust, driving model resolution, provider validation, capabilities, executor selection.
- cli-tools/mcp/media/tunnel/pxpipe/translator/headroom route groups ported; oauth full flows (cursor/kiro/codex import) ported.
- All remaining dashboard pages converted to TS; `tsc --noEmit` 0 errors; `cargo build --release` clean (new code).

**Non-Goals:**
- Removing Node `src/app/api/**` routes (Phase 4 — they stay as fallback until the full app is verified on Rust).
- Removing Askama templates / htmx static assets (Phase 4 cleanup).
- New proxy behavior beyond Node parity.
- Performance re-architecture — parity first.

## Decisions

### D1 — Cursor protobuf: hand-rolled, not prost
The cursor executor uses a small Connect-RPC protobuf framing (field encoding + envelope + GZIP/trailer flags) over a fixed schema. Port it by hand from `open-sse/utils/cursorProtobuf.js` into `derouter-rs/src/proxy/executors/cursor_proto.rs` rather than pulling in `prost`/`prost-build` (which would add a build-script + `.proto` files for a small, fixed message set). CRC32 for the checksum headers via `crc32fast` (small dep) or a 10-line table impl. **Why over prost:** avoids a build-script complexity wall and a proto-codegen step for a single provider's minimal framing. **Trade-off:** if cursor changes its protobuf schema upstream, this needs a manual update — same risk as the JS hand-rolled version.

### D2 — Kiro token refresh ported to Rust
Port `open-sse/services/tokenRefresh.js` `refreshKiroToken` to `derouter-rs/src/proxy/executors/kiro_token.rs`. On each kiro request, check the connection's token expiry; if expired/near-expiry, call the refresh endpoint with the stored refresh credentials, update the connection's token (DB write), then proceed. In-memory cache of recent refreshes to avoid stampede. The same pattern applies to any oauth-flow executor that refreshes (codex). **Why:** mirrors Node exactly; keeps tokens fresh without client-side re-auth.

### D3 — Registry as one module, 123 entries as static data
Port the 123 registry entries into `derouter-rs/src/providers/registry/`. To keep file count sane but diffs reviewable, group into a small number of files by category (`apikey.rs`, `oauth.rs`, `web_cookie.rs`, `free_tier.rs`, `compatible.rs`, `embedding.rs`, `media.rs`) OR one file per entry if the maintainers prefer (decision: group by category — fewer files, easier review). Each entry is a `const`: `ProviderRegistryEntry { id, priority, alias, display, category, transport, models, service_kinds }`. Index by id + by alias at startup. **Why over a DB table:** the registry is static in-code data in Node; keeping it in-code in Rust preserves the no-DB-change invariant and avoids a migration.

### D4 — select_executor extended, fallback unchanged
`select_executor(provider)` adds match arms for the 22 new providers + their aliases (`cu`→cursor, `gcli`/`gb`→grok-cli, `mmf`→mimo-free, `vertex-partner`→vertex, `cc`→claude via anthropic executor with claude transport, etc.). The `_ => OpenAiCompatExecutor` fallback stays for unknown compatible providers. The registry's `transport.format` selects the request/response translator (claude/openai/gemini/...) used by the executor for shape translation — port the `translator/formats.js` registry into `derouter-rs/src/proxy/translator.rs` (the format adapters the executors need; full translator console UI uses the Phase 3 translator routes).

### D5 — cli-tools/mcp/media/tunnel/pxpipe/translator/headroom routes: thin Rust wrappers
These route groups are mostly orchestration (call a local process, call an external API, proxy-passthrough). Port as thin Rust handlers:
- **tunnel**: call the platform CLI (tailscale) or deploy API; return `{ok, status, url?, error?}`.
- **pxpipe/headroom**: manage a child process via `tokio::process`; status/start/stop/restart + log capture.
- **translator/send/translate**: apply the format translator (D4) and return the translated body; load/save persist config in settings KV; console-logs/stream SSE forwards the translator's internal log channel.
- **media voices**: reqwest to the provider's voices endpoint with the connection's creds.
- **mcp/{plugin}/sse + /message**: forward to the plugin (reqwest/SSE forward).
- **oauth cursor/kiro/codex import**: complete the OAuth exchange (token exchange + store), reusing the kiro token-refresh infra.

### D6 — Frontend conversion: the rest of the dashboard
Convert the ~15 remaining pages + their client components to TS. SSE-aware hooks (mcp/translator console) use the existing `apiClient` + a small SSE helper (EventSource with credentials, or fetch-ReadableStream). Add Phase 3 response types to `src/shared/types/index.ts`. Shared components imported by Phase 3 pages (charts, tool cards, drawers) get typed props as encountered.

### D7 — Remove the Phase 2 minimal capabilities map
Once the full registry's `get_capabilities_for_model` is in, delete the minimal `providers/capabilities.rs` map from Phase 2 (the registry supersedes it). The `models.rs` route switches to calling the registry's capabilities. This is the one intentional removal in Phase 3.

## Risks / Trade-offs

- **Cursor http2 + protobuf is the highest-risk port** → if the hand-rolled framing is subtly wrong, cursor requests fail. Mitigation: port `cursorProtobuf.js` + `cursorChecksum.js` with a focused unit-ish test (encode a known body, compare bytes with the JS output); the executor is the single riskiest piece. If it can't be verified working, surface it as a known limitation and keep cursor on Node (the strangler path) for Phase 4 — do NOT ship a silently-broken executor.
- **Kiro/codex token refresh relies on stored refresh creds** → if the refresh flow shape differs from Node, tokens won't refresh. Mitigation: port `tokenRefresh.js` 1:1 and log refresh outcomes; fall back to 401 (forcing re-auth) on refresh failure rather than looping.
- **123-entry registry is large to port by hand** → transcription errors. Mitigation: port in category batches, diff each entry against the JS source; the registry is data, so a mismatch is a visible field diff, not a logic bug.
- **Process-management routes (pxpipe/headroom/tunnel) need binary paths** → these call local CLIs whose install paths are environment-specific. Mitigation: read paths from settings (like Node), return clear JSON errors when a binary is missing.
- **Phase 3 is large** → may exceed one osf-apply agent's context. Mitigation: tasks grouped so the agent checkpoints between groups; if it stalls, resume via SendMessage or re-invoke with remaining tasks.

## Migration Plan

1. Port the registry (D3) first — it's pure data and unblocks executors + routes. `cargo build` clean.
2. Port the simple executors (ollama-local already works; port the OpenAI-like ones: vertex, gemini-cli, github, qoder, iflow, perplexity-web, commandcode, xiaomi-tokenplan, mimo-free, kimchi, zed, windsurf, trae, codebuddy ×2, devin-cli, antigravity, grok-web, grok-cli). Wire `select_executor` + the translator formats.
3. Port the high-risk executors last: cursor (D1), kiro + token refresh (D2), codex. Verify each against a real provider before moving on.
4. Port the route groups (tunnel/pxpipe/headroom/translator/media/mcp/cli-tools) + oauth flows.
5. Remove the Phase 2 minimal caps map (D7).
6. Convert the remaining frontend pages to TS; `tsc --noEmit` 0 errors.
7. `docker compose up` both; browser: a real cursor/kiro/codex combo request returns a completion; cli-tools page configures a tool; mcp page streams.

**Rollback:** stop `derouter-rs`; Node proxy serves `/v1/*` again (its executors are still in place); admin pages revert to their `.js`. Per-executor rollback is possible — keep each new executor behind `select_executor` so a broken one only affects its provider.

## Open Questions

- Cursor's exact protobuf schema (field tags, message names) needs verification against `cursorProtobuf.js` at implementation time — if the hand-rolled encoder can't be byte-verified matching the JS output, defer cursor to Phase 4 and keep it on Node (documented limitation), per D1 risk. Resolve at implementation, not in spec.
