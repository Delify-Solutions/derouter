## Context

Phase 3 archived 2026-09-05: the Rust backend (`derouter-rs/`, Axum + rusqlite) serves all admin/auth routes and all 22 proxy executors, the 122-entry provider registry drives model resolution, and the Phase-1-through-3 dashboard pages are TypeScript calling Rust via the typed `apiClient` (`src/shared/api/client.ts`, `credentials:'include'`, `NEXT_PUBLIC_API_URL`). The Node backend survives only as redundant fallback: `src/app/api/**` (~186 routes), `src/lib/**` (~135 modules), `src/sse/**` (~23 proxy handlers), `src/mitm/**` (17), `src/store/**` (7), plus root backend files. `npx tsc --noEmit` is 0 errors for the converted set but cannot yet gate the whole `src/` tree because ~112 frontend JS files (shared components/hooks/utils, remaining pages, i18n) are still untyped. One functional gap remains: the cli-tools config-writer that edits real `~/.{tool}/config.toml` / `~/.claude/settings.json` / cowork MCP registry still runs on Node (Rust `cli_tools.rs` only stores a snapshot), so the TS cli-tools components call Node `-settings` paths. See proposal.md for motivation.

Invariants carried from Phases 1-3 (must hold after Phase 4): mask keys `****`/`sk-…****last4`; `.env` untracked; auth 401 JSON on every `/api/*` except `/api/health`; CORS credentials never `Any`; settings `hasPassword`/`oidcConfigured` computed before secret stripping; proxy `/v1/*` behavior identical; JSON errors only; SSE = `text/event-stream`; SQLite schema unchanged; Rust binds `0.0.0.0` via `HOST` env (never `HOSTNAME` — Docker sets it to the container ID).

## Goals / Non-Goals

**Goals:**
- `npx tsc --noEmit` is a hard 0-error gate over the entire `src/` tree, with zero surviving frontend `.js`/`.jsx` files (excluding generated/vendored allowlist + any Next.js server-runtime-mandated file documented as kept).
- The Rust backend is the sole backend: Node admin/proxy code deleted, no `/api/*` or `/v1/*` request served by Node.
- The cli-tools Rust routes write the real per-tool on-disk config (TOML for codex, JSON for claude, external API proxy for cowork MCP registry), so the TS components call Rust exclusively.
- Vestigial Askama templates + htmx/alpine static removed from `derouter-rs`; `askama` Cargo dep removed if unused.
- `docker compose up` runs exactly two services (Next.js + Rust) healthy end-to-end.

**Non-Goals:**
- New proxy providers, new admin features, or schema changes (Phase 4 is completion/removal).
- Re-converting pages already converted in Phases 1-3.
- Removing the Next.js frontend (it stays as the UI; only the Node backend goes).
- Converting the ~368 Node-backend files to TypeScript (they are deleted, not converted — Rust already provides the behavior).
- Porting Node-side server actions or middleware that have no Rust equivalent and aren't used by the surviving frontend.

## Decisions

### Decision 1: Convert-then-delete ordering
The frontend conversions and the cli-tools Rust port MUST land and pass `tsc --noEmit` 0 errors BEFORE any Node-backend files are deleted. This prevents orphaned imports: the surviving frontend imports `@/shared/**` (and possibly a few root files), never `@/lib/` or `@/sse/` (verified during scoping), but the delete step still runs after the gate to avoid transient broken states. Deletion is a single batch at the end, gated on: tsc green, cli-tools writer ported, and a grep confirming no surviving frontend import references the about-to-be-deleted Node modules.

**Alternative considered**: delete-then-convert. Rejected — it orphans frontend imports immediately and makes the tsc gate meaningless mid-migration.

### Decision 2: cli-tools config-writer is per-tool, not generic
Each tool's native config format differs: codex writes TOML (`~/.codex/config.toml`: `model`, `model_provider="derouter"`, `[model_providers.derouter]` with `name`/`base_url`/`wire_api="responses"`/`[http_headers] Authorization = "Bearer …"`, plus `default_subagent_model`; apiKey goes to `~/.codex/auth.json`, NOT config.toml); claude writes JSON (`~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` + apiKey, plus mcpServers read from `~/.claude.json`); cowork-mcp-registry proxies an external API (`https://api.anthropic.com/mcp-registry/v0/servers` with pagination + filtering + a 1h cache); other tools have their own JSON/TOML shapes. The Rust port implements one read/write/reset function per tool in `cli_tools.rs` (or a `cli_tools/` submodule), faithfully matching the Node route for that tool (same file path, same field names, same derouter-section insert/remove semantics, same binary-presence detection via `which`/`where`). Read responses mask apiKey/authToken values as `****` before returning JSON (Node already masked; Rust must too).

**TOML read/write**: Rust needs a TOML parser/serializer for codex (and others using TOML). Use the `toml` crate (already a transitive dep via other crates if present; add to `Cargo.toml` if not). Preserve unknown fields (round-trip the whole document, modify only the derouter section) so the user's other config isn't clobbered — mirrors Node's `parseTOML` → modify → `stringifyTOML` flow.

**Alternative considered**: keep cli-tools on Node (don't port), accept Phase 3's tradeoff permanently. Rejected — it leaves Node alive for one route, defeating the "sole backend" goal and blocking the Node `src/app/api/cli-tools/*` deletion.

### Decision 3: which files to KEEP vs DELETE (verification rule)
A Node-backend file is deleted only after a grep confirms no surviving frontend import references it. The rule:
- `src/app/api/**`, `src/sse/**`, `src/mitm/**`, `src/store/**`, `src/lib/**`: DELETE (Rust replaces; frontend confirmed not to import `@/lib/`/`@/sse/`).
- Root files (`src/proxy.js`, `src/dashboardGuard.js`, `src/consoleLogBuffer.js`, `src/localDb.js`, `instrumentation.js`, `models/`): KEEP if the surviving frontend or Next.js server runtime imports it (convert to TS); DELETE otherwise. `instrumentation.js` in particular is a Next.js convention — keep + convert to `.ts` if Next.js requires it; verify by checking `next.config.*` and imports. Each kept file is documented in tasks.md with the reason.
- `src/i18n/**`: KEEP (frontend i18n) + convert to TS.

**Alternative considered**: blanket-delete everything non-`.tsx`. Rejected — risks removing a Next.js-runtime-mandated file (e.g. instrumentation) and breaking the server with no clear error.

### Decision 4: Askama/htmx removal — remove the live parallel HTMX UI, not just dead code
A grep confirms Askama is NOT vestigial — it is a live parallel UI path from the archived `2026-09-05-rewrite-derouter-rust-htmx` plan. Files referencing Askama (verified on disk): `src/templates.rs` (30+ `#[derive(Template)]` structs), `src/web/render.rs` (Hx-Request partial-detect renderer), `src/web/routes/public_usage.rs` (`use askama::Template`). Routes mounted in `main.rs`: `/usage` (HTML page), `/usage/key/receipts`, `/usage/key/receipts/detail`, `DELETE /usage/key/history`, plus a `dashboard_page` HTML handler. These Rust HTML routes collide with the Next.js frontend, which also serves `/usage` (`src/app/usage/page.js`, being converted to `.tsx` in Task Group 2) and `/dashboard` — in the 2-service setup the browser talks to Next.js, which calls the Rust JSON endpoints (`/api/usage/key`, `DELETE /api/usage/key/history`), so the Rust HTML routes are unused by the Stack A1 architecture.

Removal is therefore: (a) delete `src/templates.rs`, `src/web/render.rs`, `derouter-rs/templates/**`, `derouter-rs/static/**`, `derouter-rs/build.rs` (if it only has the `rerun-if-changed=templates/` directive — verify first); (b) in `main.rs` remove the HTML route mounts (`/usage`, `/usage/key/receipts`, `/usage/key/receipts/detail`, `DELETE /usage/key/history`, the `dashboard_page` handler + its mount) and any `mod templates;` / `mod render;` declarations — KEEP the JSON variants `/api/usage/key` + `DELETE /api/usage/key/history` (those are `public_usage::key_usage_json` / `clear_history_json`, not the Askama ones); (c) edit `public_usage.rs` to drop the Askama `page`/`receipts`/`receipt_detail`/`clear_history` HTML handlers + the `use askama::Template` import, keeping only the JSON handlers; (d) remove `askama = "0.12"` from `Cargo.toml`; (e) edit `Dockerfile` to drop `COPY templates/ templates/` + `COPY static/ static/`. Gate: `cargo build --release` + `cargo clippy --release` clean after removal; `cargo test byte_verify` still 6/6 (cursor D1 unaffected). If any surviving code still imports the deleted `templates`/`render` modules after the handler removals, remove or migrate that import too (none expected beyond the named files).

**Alternative considered**: leave the parallel HTMX UI in place. Rejected — it collides with Next.js on `/usage` + `/dashboard`, adds build time + image size, and implicitly keeps two UIs alive, contradicting the Stack A1 "Rust = JSON backend only" decision. The JSON endpoints (`/api/usage/*`) stay; only the HTML-rendering handlers go.

### Decision 5: Docker 2-service finalization
`docker-compose.yml` is already 2-service. Finalization = verify `NEXT_PUBLIC_API_URL` (Next.js service) points to the Rust service hostname (`http://derouter-rs:20128`), remove any env hints that assume a Node backend (e.g. the `derouter` service's `HOSTNAME` env is fine for Node but worth re-checking it doesn't break the Rust service — the Rust service must NOT set `HOSTNAME` as its bind host; it uses `HOST` env defaulting to `0.0.0.0`), confirm the shared SQLite volume (`derouter-data:/app/data`) is mounted on BOTH services so both see the same `${DATA_DIR}/db/data.sqlite`, and run `docker compose up` end-to-end. No new services, no new volumes.

### Decision 6: No spec-level behavior change for proxy — Rust already owns it
Phase 3 already made Rust the executor for all 22 providers, so removing `src/sse/**` does not change `/v1/*` responses. The design treats Node `src/sse/**` deletion as a no-op for external behavior; the risk is only if some Node-side observability/usage-logging hook wasn't yet ported to Rust. Tasks include a pre-deletion check: confirm Rust usage logging (`saveRequestUsage`, request-details flush in `derouter-rs/src/db/repos/request_details.rs`) covers everything Node did, with a real-provider curl sweep before deleting.

## Risks / Trade-offs

- **[Risk: cli-tools per-tool port introduces a config-format bug]** (e.g. codex TOML field name drift, claude settings.json schema changed since Node route written) → Mitigation: per-tool unit tests comparing Rust written config vs Node written config for a fixed input (byte or semantic equality); and a manual `codex`/`claude` CLI smoke test that the written config loads. If a tool's format is unsettled, port that tool LAST and keep its Node route until verified.
- **[Risk: deleting a Next.js-runtime-mandated file breaks the server with a confusing error]** → Mitigation: Decision 3's grep-before-delete rule + keeping `instrumentation.js`/`.ts` unless proven unused; `npm run build` must pass after deletions.
- **[Risk: an orphaned frontend import to a deleted `@/lib` module surfaces only at runtime, not tsc]** (tsc passes but a dynamic import or string-referenced module is gone) → Mitigation: grep for `@/lib/`, `@/sse/`, `@/store/`, `@/mitm/` across the surviving frontend AND `next.config.*`/middleware; any hit is removed before deletion. The frontend was verified not to import these during Phase 4 scoping, but re-verify at delete time.
- **[Trade-off: TOML round-trip may reorder/format the user's config.toml]** → accepted; Node's confbox has the same behavior. Document in the cli-tools response that applying derouter settings may reformat the tool config.
- **[Risk: `askama` removal breaks a hidden dependency]** → Mitigation: Decision 4 grep gate + `cargo build` after removal.
- **[Trade-off: keeping `instrumentation.js` as JS violates "zero frontend JS"]** → if kept, convert to `.ts` (Decision 3) so the gate holds; only allowlisted-vendored JS stays.

## Migration Plan

1. **Frontend TS conversion** (disjoint directory-scoped agents): convert `src/shared/**` (72 files), remaining `src/app/**` non-api pages (40), `src/i18n/**` (3) to strict `.tsx`/`.ts`. Gate: `npx tsc --noEmit` 0 errors repo-wide.
2. **cli-tools config-writer Rust port**: implement per-tool read/write/reset in `cli_tools.rs` (codex TOML, claude JSON, cowork-mcp-registry external proxy, + each remaining `{tool}-settings` route's format). Switch the TS cli-tools components from `/-settings` Node paths to Rust `/api/cli-tools/{tool}` paths. Gate: per-tool config-writer tests + tsc 0 errors.
3. **Node-backend deletion** (after steps 1-2 green): delete `src/app/api/**`, `src/lib/**`, `src/sse/**`, `src/mitm/**`, `src/store/**`, and verified-bad root files. Re-run `npx tsc --noEmit` + `npm run build` to confirm no orphaned imports; restore any file that turns out to be needed.
4. **Askama/htmx removal**: grep-gate, delete `derouter-rs/templates/` + `static/`, edit `build.rs`/`Cargo.toml`/`Dockerfile`. Gate: `cargo build --release` + `cargo clippy` clean.
5. **Docker finalize + verify**: `docker compose up` both services; curl sweep key `/api/*` (401 without cookie, JSON with); `/v1/chat/completions` with a real key+combo; browser login → dashboard → providers CRUD → cli-tools Apply writes real config → usage tabs → proxy completion.
6. **Archive** `phase4-frontend-strict-ts-backend-removal`.

**Rollback strategy**: changes are on a branch (not pushed to main per the locked plan). A broken step is reverted via git; Node backend is restored from the branch's pre-deletion commit. Because Rust + Node ran in parallel through Phase 3, restoring Node is a clean fallback at any step until the deletion batch.

## Open Questions

(None — all design decisions are resolved above. The per-tool config formats are determined from the Node route source; the keep/delete rule is grep-based; the Askama/docker decisions are deterministic.)
