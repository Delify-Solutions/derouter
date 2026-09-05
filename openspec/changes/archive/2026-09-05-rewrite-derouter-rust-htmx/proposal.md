# Rewrite derouter in Rust + HTMX + Askama + Alpine.js

## Why

Derouter is an AI proxy-fallback router. Today it is a Next.js 16 + React +
better-sqlite3 app distributed as a ~hundreds-of-MB `node_modules` tree, a
webpack-built standalone bundle, a native `better-sqlite3` build (which has
historically caused Docker build failures and requires system toolchains), and
a large React frontend that ships a client-side JSON API. The result is a heavy
cold start, a large Docker image, fragile native builds, and a frontend build
step that adds no value for a single-operator admin console.

This change rewrites the entire application as **one static Rust binary**
(~15–20 MB) that serves server-rendered HTML fragments over HTMX, with Alpine.js
for small client state, compiled Askama templates, and a bundled SQLite
(rusqlite). The rewrite preserves all proxy behavior and reuses the existing
`derouter.db` file so the Node and Rust versions run in parallel on the same data
during a phased strangler migration — the operator switches over only when the
Rust port reaches parity in scope (core proxy + admin UI + usage + public usage
+ auth).

## What Changes

- **BREAKING (deployment only, not API)**: the runtime is now a single Rust
  binary instead of `node custom-server.js`. The default port moves to `20128`
  (Node stays on `20127`) so both run side-by-side. Clients using `/v1/*` see no
  change; only deploy/config changes.
- New backend: Axum web framework, `rusqlite` (bundled SQLite via `r2d2_sqlite`
  connection pool), Askama compile-time templates, `reqwest` (rustls) for upstream
  provider calls, `axum::response::sse` for streaming chat completions, `argon2`
  for password hashing, `jsonwebtoken` for session cookies.
- New frontend: HTMX 2.x for server-returned HTML fragments (filters, modals,
  row CRUD, tab switching, drawer, pagination — all server-rendered partials),
  Alpine.js 3.x for small client-only state (active-tab CSS, confirm popover,
  show-raw toggle, drawer open/close), Tailwind 4 compiled to one static
  `app.css`. **No React, no JSX, no client-side JSON API for the UI.**
- DB layer kept 1:1: same SQLite schema (`providerConnections`, `settings`,
  `providerNodes`, `proxyPools`, `apiKeys`, `keyGroups`, `combos`, `kv`,
  `usageHistory`, `requestDetails`, `usageDaily`, all indexes), same SQLite
  **file** — `${DATA_DIR}/db/data.sqlite` where `DATA_DIR` defaults to
  `~/.derouter` on macOS/Linux (or the `DATA_DIR` env var, e.g. `/app/data` in
  the Docker image). The Rust port reads the same `DATA_DIR` env var so Node and
  Rust open the identical file. Auto-migration via `ALTER TABLE ADD COLUMN`
  (ported from `migrate.js`'s `syncSchemaFromTables`).
- The `/v1/*` proxy endpoints are ported to preserve behavior exactly: combo
  resolution + fallback chain, per-key RPM/TPM/budget/expiry/`allowedModels`
  enforcement before any upstream call, `requestedModel` (the bare combo name)
  threaded through request-detail logging (the two-level fix), usage history +
  request-details buffered flush, key masking `sk-…****last4`.
- New directory `/Volumes/SSD/proxy/derouter-rs/` alongside the existing Node
  code; the existing codebase is **untouched** during the migration.
- Docker image rebuilt as multi-stage Rust build → distroless final image with
  the binary + `static/` files.
- New CI workflow `rust-ci.yml`: `cargo fmt --check`, `cargo clippy -- -D
  warnings`, `cargo build --release`.

### Scope delivered (this change)
- Phase 0: Cargo scaffold + rusqlite pool + schema + auto-migration + Axum boots
  + static serving + Askama layout.
- Phase 1: proxy core (chat/embeddings/images/audio/video/responses/search/models
  for the 6 core executors: openai, anthropic, openai_compat, google, azure,
  ollama) + limits + request-detail + usage logging.
- Phase 2: admin CRUD (providers/combos/keys/groups/pricing) via HTMX fragments.
- Phase 3: usage dashboard (overview/keys/details tabs, per-key table, detail
  drawer, show-raw).
- Phase 4: public `/usage?key=` + auth (login, JWT cookie, RequireAdmin guard).
- Phase 5: Docker multi-stage + Rust CI.

### Out of scope (ported in LATER changes, not this one)
28 OAuth/CLI executors (kiro, cursor, codex, devin, grok-cli, iflow, codebuddy,
…), MCP plugin marketplace (`mcp/[plugin]/sse`), translator console + routes,
pxpipe, tunnel (tailscale/cloudflare/deno/vercel), SAML/OIDC SSO, basic-chat
playground, media-providers web admin pages, skills, mitm, OAuth bulk-import
flows, cli-tools settings pages, console-log streaming. Endpoints that are only
reachable through OAuth-only providers are deferred with those executors.

## Capabilities

### New Capabilities
These capabilities describe the behavior the Rust port must satisfy; they mirror
behavior already shipped in the Node version and now become the explicit contract
the rewrite is verified against. Each creates a `specs/<name>/spec.md`.

- `proxy-routing`: resolving an incoming client `model` (a combo name) to a
  provider/model fallback chain, enforcing per-key access and rate/budget limits
  before any upstream call, executing the upstream request (streaming or
  non-streaming), and logging usage. Covers `/v1/*` endpoints.
- `key-management`: API key CRUD with per-key RPM/TPM/budget (`budgetUsd`) /
  reset window (`resetWindow`: 5h / daily / monthly) / expiry / `allowedModels`,
  plus key groups that supply default limits. Admin-only.
- `admin-portal`: the admin UI (providers/combos/keys/groups/pricing pages)
  implemented as server-rendered HTMX fragments — list pages, modals for
  add/edit, row delete via `hx-swap outerHTML`, combo test modal.
- `usage-tracking`: usage dashboard (overview/keys/details tabs, per-key table
  with limits + peak TPM + per-model breakdown, request-details drawer with
  show-raw toggle) and the buffered request-details flush. Admin-only dashboard;
  public view is a separate capability.
- `public-usage-view`: the public `/usage?key=` page a key holder uses to view
  their own receipts, per-model usage, and clear their own history. Gated by the
  key (404 on unknown key — existence must not leak). Shows `requestedModel`
  (combo name), never the resolved provider/model.
- `admin-auth`: admin login (argon2) → JWT cookie httpOnly → RequireAdmin
  extractor guarding the dashboard and admin API; header sanitization before
  storing request details.

### Modified Capabilities
None — there are no existing specs in `openspec/specs/` yet (this is the first
spec-tracked change). The Node implementation's behavior is being captured as the
contract above, not modified.

## Impact

- **Code**: new `/Volumes/SSD/proxy/derouter-rs/` (Cargo project, ~40 Rust source
  files, Askama templates, static assets, Dockerfile, CI workflow). Existing
  Node/JS code under `src/`, `open-sse/`, `cli/` is **untouched**.
- **APIs**: `/v1/*` proxy endpoints — behavior-preserving, same request/response
  shapes. Admin API becomes HTMX fragment endpoints (HTML, not JSON) under
  `/dashboard/*` — this is a client-facing format change but only the admin UI
  and the public `/usage` page consume it, and both are rewritten in the same
  change.
- **Dependencies**: removes Node, npm, webpack, React, Next.js, better-sqlite3
  from the *deployment* (they remain in the repo during migration). Adds a Rust
  toolchain at build time only. Runtime deps: the OS dynamic linker (or static
  musl) + the binary + the SQLite DB file.
- **Data**: no data migration — the same `${DATA_DIR}/db/data.sqlite` is opened
  directly by rusqlite. `DATA_DIR` defaults to `~/.derouter` (or the `DATA_DIR` env
  var, e.g. `/app/data` in Docker — matching `docker-compose.yml`). Auto-migration
  adds any missing columns via `ALTER TABLE ADD COLUMN`.
- **Deployment**: Docker image shrinks from the Next.js standalone bundle to a
  distroless/scratch image with one binary + `static/`. Default port `20128`.
- **Security**: argon2 replaces bcryptjs; JWT (HMAC) replaces `jose`; key
  masking, 404-not-401 on unknown public key, and request-header redaction are
  preserved exactly as invariants.
