## Context

Phase 1 is archived: Rust serves auth + the 7 core admin areas as JSON, React/TS scaffolding is in place (tsconfig strict, typed apiClient, typed index types, login + dashboard layout + providers page converted, 10 components typed). The Rust proxy `/v1/*` and DB pool are reused. This phase extends the Rust JSON surface to every remaining admin route so the Node `src/app/api/**` admin layer can stop being the source of truth for admin pages (only Phase 3 executor/registry/cli-tools/mcp/etc. routes stay on Node until Phase 3/4). See proposal.md for the route inventory.

Existing Rust pieces reused: `auth::require_auth` (401 JSON guard), `db::repos::*` (settings, api_keys, combos, groups, usage, request_details, connections), the `providers/` module (normalizeProviderId + provider lists from Phase 1), `Json`, `State(pool)`, the CORS layer + `expose_headers` from Phase 1.

## Goals / Non-Goals

**Goals:**
- All ~35 Phase 2 admin routes served as JSON by Rust with auth + validation parity to Node.
- Minimal model capabilities map so the models catalog renders caps without the full provider registry.
- Dashboard pages that consume Phase 2 routes converted to TS calling Rust.
- `cargo build --release` clean (new code), `tsc --noEmit` 0 errors (converted set).

**Non-Goals:**
- The 22 remaining proxy executors (Phase 3).
- The 123-entry provider registry (Phase 3) — Phase 2 ships a minimal static capabilities map for `AI_MODELS`.
- cli-tools, mcp, media-providers, tunnel, pxpipe, translator, headroom, full oauth flows (Phase 3).
- Removing Node `src/app/api/**` routes (Phase 4) — they stay as fallback for unconverted pages.
- Converting cli-tools/mcp/etc. pages to TS (Phase 3/4).

## Decisions

### D1 — Minimal capabilities map (not the full registry)
Port `AI_MODELS` from `src/shared/constants/config.js` and a hand-written `{provider/model -> caps}` map for the models in scope, into `derouter-rs/src/providers/capabilities.rs`. `get_capabilities_for_model(provider, model)` returns the entry or a default `{vision:false, search:false, reasoning:false, contextWindow:0, maxOutput:0}`. The full `open-sse/providers/capabilities.js` + registry port is Phase 3. **Why over porting the full registry now:** the registry has 123 entries and intertwined with executor transforms — out of Phase 2 scope. **Trade-off:** some models show default/empty caps until Phase 3; UI handles missing caps gracefully (it already does — Node returns whatever caps exist).

### D2 — proxy-pool deploy endpoints: port 1:1, keep external calls server-side
`cloudflare-deploy`/`deno-deploy`/`vercel-deploy` call external platform APIs (Cloudflare Workers API, Deno Deploy API, Vercel API) using credentials from settings. Port the Node fetch logic 1:1 into Rust using `reqwest` (already a dependency). Validate platform credentials exist in settings before calling; return `{ok, url?, error?}`. **Alternative (defer deploy to Phase 3):** rejected — these are admin CRUD-adjacent and the proxy-pools page needs them. **Trade-off:** external API shape drift is possible; mitigation: return the platform error as JSON, not 500 HTML.

### D3 — tags as a static const array
Port `open-sse/config/ollamaModels.js` verbatim into `derouter-rs/src/providers/ollama_models.rs` as a `pub const OLLAMA_MODELS: &[&str] = &[...];` (or an array of small structs if the Node shape is `{name, ...}`). `GET /api/tags` returns `{"models":[...]}`. **Why:** it's a read-only static list, the simplest route — no DB, no validation.

### D4 — DB porting: reuse existing tables, add repo functions as needed
proxy_pools, provider_nodes, model_aliases, custom_models, disabled_models tables already exist (Node uses them). Rust `db/repos/` already has settings/api_keys/combos/groups/usage/request_details/connections repos. Add: `proxy_pools.rs` repo (get/create/update/delete, count_connections_by_pool), `provider_nodes.rs` repo, `model_aliases.rs` repo, `custom_models.rs` repo, `disabled_models.rs` repo. All use the existing `rusqlite` pool. **No schema migration** — tables exist.

### D5 — settings/database export-import: full DB snapshot
`export` serializes all tables to a JSON object. `import` validates it's an object with expected table keys, then inserts in a transaction (delete-then-insert per table, or upsert). `reset` deletes `usage` + `requestDetails` rows only (NOT settings/keys/providers/combos/groups/pricing/proxy_pools/provider_nodes). **Risk:** import overwrites admin data; mitigation: auth-required + validate shape before any write + wrap in transaction.

### D6 — health is the only unauthenticated Phase 2 route
`GET /api/health` returns 200/503 without auth (public liveness for Docker/uptime checks). All other Phase 2 routes use the existing `auth::require_auth` guard. Documented in the system-operations spec.

### D7 — shutdown via a shutdown signal channel
`POST /api/shutdown` (and `/api/version/shutdown`) send a signal on a `tokio::sync::watch` or `oneshot` channel wired into `main.rs`; the server drains for a short grace period then exits. The handler returns 200 `{"success":true}` immediately. **Alternative:** hard exit — rejected (in-flight proxy requests would die). Node uses a similar graceful path.

### D8 — Frontend conversion: isolate Phase 2 pages, convert shared components on demand
Convert the 9 listed pages + their direct client components + ProviderLimits subtree. For a shared component imported by both a Phase 2 page and a Phase 3 page, convert it to `.tsx` now (Phase 3 page keeps importing the `.tsx` — `allowJs` not needed for that import). Do NOT convert Phase 3 pages (cli-tools, mcp, etc.). Add Phase 2 response types (`ProxyPool`, `ProviderNode`, `ModelCatalogEntry`, `ModelAlias`, `SystemVersion`, `HealthStatus`) to `src/shared/types/index.ts`.

### D9 — models `routedModel`/`alias` shape parity
`GET /api/models` must return the same per-entry shape Node does: `fullModel = provider/model`, `routedModel = providerAlias/model`, `alias = storedAlias || model`, `caps = {...}`. The `providerAlias` lookup reuses the Phase 1 `providers/config.rs` provider→alias map. This keeps the combos/UI from distinguishing Rust vs Node responses.

## Risks / Trade-offs

- **Minimal caps map drift from full registry** → some models show default caps. Mitigation: Phase 3 ports the full registry; UI and combos don't break (caps are display-only metadata).
- **External deploy API shape changes** → cloudflare/deno/vercel deploy could fail if their API changes. Mitigation: return platform error as JSON; Phase 3 can refresh. Non-blocking for core admin CRUD.
- **settings/database import overwrites data** → an admin importing a stale or malicious dump could clobber the DB. Mitigation: auth-required, validate shape, transaction-wrapped, `reset` never touches settings/keys.
- **Converting shared components used by Phase 3 pages** → a `.tsx` conversion of e.g. a Modal used by cli-tools page means the cli-tools JS page now imports a `.tsx`. With `allowJs:true` this works (Next.js compiles both). Mitigation: keep the public component API identical.
- **Two backend writers (Node + Rust) during transition** → same as Phase 1; admin write volume is low, WAL + busy_timeout handle it.

## Migration Plan

1. Implement Rust Phase 2 routes + repo functions; `cargo build --release` clean; `curl` sweep each endpoint (with cookie = JSON, without = 401, bad input = 400, unknown id = 404).
2. Convert frontend Phase 2 pages to TS calling Rust; `npx tsc --noEmit` 0 errors.
3. `docker compose up` both services; browser: login → dashboard → proxy-pools list from Rust → models catalog → usage tabs → endpoint page.
4. Rollback: stop `derouter-rs`, revert the Phase 2 page `.tsx` files to their `.js` (kept in git), Node serves all admin routes again. Phase 1 routes on Rust are unaffected (they're a superset).

## Open Questions

- None material to Phase 2. (The minimal caps map's exact model list is determined at implementation time from the current `AI_MODELS` catalog; if a model lacks a caps entry the default is returned — documented in D1.)
