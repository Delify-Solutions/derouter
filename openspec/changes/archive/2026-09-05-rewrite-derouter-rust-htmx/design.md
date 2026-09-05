## Context

Derouter today is a Next.js 16 + React + better-sqlite3 monolith at `/Volumes/SSD/proxy`. The proxy core lives in `src/sse/handlers/*.js` (chat handler `chat.js` is 346 lines: `handleChat` → `enforceKeyAccess` → `getComboModels` → `handleSingleModelChat` fallback chain) and `open-sse/` (executors, services). The DB layer is in `src/lib/db/` (`schema.js`, `migrate.js`'s `syncSchemaFromTables`, `repos/*.js`, `paths.js`, `dataDir.js`). The UI is React under `src/app/`. The SQLite **file** is `${DATA_DIR}/db/data.sqlite` where `DATA_DIR` defaults to `~/.derouter` on macOS/Linux (or the `DATA_DIR` env var; in the Docker image `DATA_DIR=/app/data`, so the file is `/app/data/db/data.sqlite` — volume `derouter-data` in `docker-compose.yml`). The Rust port reads the **same** `DATA_DIR` env var so Node and Rust open the identical file.

## Goals / Non-Goals

**Goals:**
- A single `cargo build --release` artifact that serves the whole app (proxy + admin UI + public usage + auth) with no Node, npm, webpack, or React at runtime.
- Bit-for-bit behavior parity on the `/v1/*` proxy and on the data model — the existing `${DATA_DIR}/db/data.sqlite` opens unchanged and accumulates new rows in the old schema.
- UI delivered as server-rendered HTML fragments (HTMX) + tiny Alpine.js state, matching the existing dashboard/usage UX (tabs, filters, expand rows, drawer, show-raw).
- Phased delivery where each phase is independently runnable/verifiable (Phase 0 boots; Phase 1 proxies; Phase 2 manages; Phase 3 shows usage; Phase 4 logs in; Phase 5 ships).

**Non-Goals:**
- Re-implementing the 28 OAuth/CLI executors, MCP marketplace, translator, pxpipe, tunnel, SSO, basic-chat, media-provider web admin, skills, mitm in this change (later changes).
- Changing the SQLite schema, the DB file format, or any `/v1/*` request/response shape.
- A client-side JSON API or a single-page-app. The UI is multi-page with HTMX fragments by design.
- Performance optimization beyond "fast enough for a single-operator proxy" (no async tuning beyond correctness).

## Decisions

### D1: Axum + tokio for the web framework
Axum (tower middleware, typed extractors, `Sse` response type) is the most idiomatic async Rust web framework and maps cleanly to the per-route handlers and the streaming proxy. Alternative: actix-web (more mature actor model, but heavier and less tower-integrated). Chose Axum for tower/extractor ergonomics and first-class SSE.

### D2: rusqlite + r2d2_sqlite (bundled), sync inside spawn_blocking
`rusqlite` is the direct analog of better-sqlite3: sync API, `?` positional params, `transaction()`. SQLite is single-writer; a `r2d2` pool over `r2d2_sqlite::SqliteConnectionManager` gives a small set of `Connection`s. Because rusqlite is blocking and Axum is async, DB calls run inside `tokio::task::spawn_blocking` (or a dedicated blocking runtime), returning a `Result` to the async caller. WAL mode + `busy_timeout` are set per connection.

**Critical difference from better-sqlite3:** `betterSqliteAdapter.transaction(fn)` executes `fn` immediately and returns the *result* (NOT a callable). `rusqlite::Connection::transaction()` returns a `Transaction` handle that the caller must `.commit()`. Port every existing `db.transaction(() => {...})` to:
```rust
let tx = conn.transaction()?;
// ... tx.execute(...) ...
tx.commit()?;
```
Do NOT double-call (`transaction()()`), and do NOT let a `Transaction` drop without committing (an uncommitted `Transaction` rolls back on drop — fine for aborting on error, but be explicit).

**DB path resolution:** the pool opens `${DATA_DIR}/db/data.sqlite` where `DATA_DIR` is read from the `DATA_DIR` env var, falling back to `~/.derouter` (matching `src/lib/dataDir.js`'s `defaultDir()` exactly: macOS/Linux `~/.derouter`, Windows `%APPDATA%/derouter`). The directory and `db/` subdirectory are created on boot (`ensureDirs` equivalent). This is how the Rust port opens the **same** file Node does — set the same `DATA_DIR` (or leave it unset to use the default) on both.

### D3: Same SQLite schema, syncSchemaFromTables port for auto-migration
`schema.rs` holds the table/column/index definitions copied 1:1 from `src/lib/db/schema.js` (same names, same CHECK constraints, same indexes). `migrate.rs` ports `syncSchemaFromTables`: `PRAGMA table_info(<table>)` → diff against the declared columns → `ALTER TABLE <table> ADD COLUMN <col> <type>` for any missing column. Tables are `CREATE TABLE IF NOT EXISTS` from `schema.rs`. This lets the Rust binary open a DB created by Node and add any columns Node added later, and vice-versa. No versioned migration is needed for additive column adds.

### D4: Askama compile-time templates with Hx-Request partial detection
Askama templates are checked at compile time (template typo = build failure, good for safety). The base `layout.askama` renders sidebar + header + a `{% block content %}` slot for full pages. Fragment endpoints render *only* a partial template (no layout). The `render.rs` helper chooses full-vs-partial by the `Hx-Request: true` header (or dedicated `/.../table` fragment routes that always return partials). No client-side JSON API for any UI interaction.

### D5: HTMX fragment patterns (the core UI mechanic)
- Filter dropdown/select change → `hx-get="/.../table" hx-target="#tbody" hx-include="this form"` → server returns a `<tbody>...</tbody>` fragment → `hx-swap="innerHTML"`.
- Add row → modal form `hx-post="/..."` → server returns the new `<tr>` → `hx-swap="beforeend"` into the table; modal closed by Alpine `@submitted` event.
- Edit row → `hx-put="/.../:id"` → server returns the updated `<tr>` → `hx-swap="outerHTML"` replaces the row in place.
- Delete row → `hx-delete="/.../:id"` → server returns empty body → `hx-swap="outerHTML"` removes the row.
- Tabs → container `<div x-data="{tab:'overview'}">`; each tab button `hx-get="/dashboard/usage/overview" hx-target="#content"` + `@click="tab='overview'"` for active CSS.
- Expand row → `hx-get="/.../models" hx-target="closest tr" hx-swap="afterend"` inserts a sub-`<tr>`.
- Drawer → `hx-get="/.../:id?showRaw=..." hx-target="#drawer" hx-swap="innerHTML"`; Alpine `x-show="drawerOpen"` animates open/close.
- Confirm popover → Alpine `x-data="{confirm:false}"` `x-show="confirm"`; the confirm button is the `hx-delete`.
- Toast after save → response header `HX-Trigger: {"toast":"Saved"}` + an Alpine `@toast.window` listener.
- `hx-vals='js:{key: key}'` passes Alpine-held state (the public-usage key, showRaw) into the request.

### D6: Alpine.js for small client state only
Alpine holds: active-tab CSS, confirm-popover boolean, `showRaw` toggle, drawer `open` boolean, the public-usage `key`/`period` inputs. It does NOT fetch data, render lists, or manage any domain state — that's HTMX/server. This keeps client JS to ~15 KB and removes React/zustand entirely.

### D7: requestedModel two-level preservation (behavior-critical)
The existing bug (client-visible combo name lost in request details) was fixed at two levels in the Node code; the Rust port must preserve both:
1. `buildRequestDetail(base, overrides)` includes `requestedModel` (the bare `clientRawRequest.model` when it contains no `/`) in the record it returns.
2. `flushToDatabase`'s `record` object lists `requestedModel: item.requestedModel || null` explicitly (NOT a spread copy that would drop an `undefined` field) and stores it inside the serialized `data` JSON.
Reports/history then read `requestedModel` from `data` (falling back to `model` for old rows) and display it as the model; the resolved `model` is kept as `resolvedModel` for admin drawer "via" but never shown to key holders.

### D8: enforceKeyAccess before any upstream call
Mirrors `chat.js:86`: `enforceKeyAccess(apiKey, modelStr)` runs first. It resolves the key via `getApiKeyForAuth(key)` → `{rpm, tpm, budgetUsd, resetWindow, allowedModels, expiresAt, windowStartedAt, windowCostUsd}` (merging key + group). Checks in order: key exists & active (else 401/403); model allowed (else 403); expired (else 403); RPM count in last 60s (else 429); TPM sum in last 60s (else 429); budget `windowCostUsd < budgetUsd` after accounting the incoming estimate, else 429. Window reset: if `now - windowStartedAt > resetWindow`, reset `windowCostUsd=0, windowStartedAt=now` first. onace: all checks complete before the executor is invoked.

### D9: reqwest (rustls) + axum SSE for upstream + streaming
`reqwest` with the `rustls-tls` feature (no OpenSSL system dep) issues upstream calls. Streaming chat: `reqwest::Response::bytes_stream()` → an `axum::response::Sse<impl Stream<Item=Result<Event, _>>>` that maps each upstream chunk to an SSE `Event`. Non-streaming: `reqwest` collects the body and the handler returns JSON. The `sseToJson` path (client wants non-streaming but upstream streams) aggregates the upstream SSE into a JSON response, matching the existing `sseToJsonHandler` behavior.

### D10: Buffered requestDetails flush (port the writeBuffer)
`request_details.rs` keeps a `Mutex<Vec<DetailItem>>` write buffer + a background `tokio::time::interval` flush task (and an immediate flush when `buffer.len() >= batchSize`). Config (enabled, maxRecords, batchSize, flushIntervalMs, maxJsonSize) is read from settings with env fallbacks, cached with a TTL like the Node version. `flushToDatabase` drains the buffer inside one `transaction()`, INSERTs each record (with `requestedModel` and the explicit field list from D7), then trims to `maxRecords`. `sanitizeHeaders` removes `authorization/x-api-key/cookie/token/api-key` (case-insensitive contains) before storing. `truncateField` truncates oversize JSON to `{_truncated:true, _originalSize, _preview}`. On shutdown, a final flush drains the buffer.

### D11: argon2 + JWT (HMAC) httpOnly cookie for auth
`argon2` verifies admin passwords (replaces bcryptjs). On success, a JWT (HMAC-SHA256, key from config) is set in an `httpOnly` cookie. A `RequireAdmin` extractor (`FromRequestParts`) reads the cookie, verifies the JWT, and injects the admin identity — or rejects (redirect to `/login` for HTML requests, 401 for others). No session server-side state.

### D12: Docker multi-stage + Tailwind build step
Dockerfile: stage 1 `rust:1-slim` (or `cargo-chef` for layer caching) builds `cargo build --release`; stage 2 `gcr.io/distroless/cc` (or `alpine`) copies the binary + `static/` + a writable `data/` mount. The one non-Rust build is Tailwind 4 → `app.css`; this runs at build time (a `tailwindcss` CLI step) and the output CSS is committed or generated in the Docker build. `htmx.min.js` and `alpine.min.js` are vendored static files (no CDN at runtime).

## Risks / Trade-offs

- **[Async streaming is the trickiest port]** Node's stream pipeline → Rust's `Sse<impl Stream>` + `reqwest::bytes_stream`. Mitigation: port the three handler branches (streaming, non-streaming, sse-to-json) one at a time; verify each with `curl -N` (streaming) and `curl` (non-streaming) against a real combo before moving on. A wrong `Stream` `Drop` can truncate a response — test with a long completion.
- **[rusqlite sync vs Axum async]** A blocking DB call on the async runtime stalls the executor. Mitigation: wrap every repo call in `spawn_blocking` (or a dedicated blocking pool). The r2d2 pool size caps concurrent DB work; set `busy_timeout` to tolerate contention with the Node process on the same file (both use WAL).
- **[Two processes on one SQLite]** Rust and Node both writing the same `${DATA_DIR}/db/data.sqlite` during migration. Mitigation: both use WAL mode + `busy_timeout`; SQLite WAL allows one writer at a time but readers don't block. Keep the overlap short; once Rust is at parity, stop the Node process.
- **[Askama compile-time = slower iteration]** A template typo won't surface until `cargo build`. Mitigation: acceptable for a one-operator app; the type safety is worth it. Use `cargo watch` during development.
- **[Tailwind is the one non-Rust build]** Breaks the "single cargo build" purity. Mitigation: the output is one committed CSS file; the runtime binary never runs Tailwind. If even this must go, hand-write minimal CSS later — but Tailwind keeps the existing class names, minimizing markup churn.
- **[missing executor coverage]** Deferring the 28 OAuth executors means combos referencing them will `model_not_found` in Rust. Mitigation: document this; during migration only combos backed by the 6 core executors are usable from the Rust port. Full coverage is a later change.
- **[rusqlite Transaction drops = rollback]** An uncommitted `Transaction` rolling back on `Drop` is correct for aborting, but a missed `commit()` silently loses writes. Mitigation: always end the transaction block with an explicit `tx.commit()?`; never rely on drop for the success path. Code review catches this.

## Migration Plan

1. Build Phase 0 in `derouter-rs/`, `cargo run` opens `${DATA_DIR}/db/data.sqlite` (same `DATA_DIR` as Node), migrates, serves the layout. Verify DB is untouched (PRAGMA row counts match).
2. Phase 1: point a test client at `:20128/v1/chat/completions` with a known combo; confirm parity with `:20127`. Run both in parallel.
3. Phases 2-4: administer keys/combos and view usage from the Rust port while Node keeps serving traffic. Watch for schema column adds (the Rust migrator must add any column the Node version newly expects and vice-versa).
4. Cut over: stop Node, point the reverse proxy / clients at `:20128`. Keep Node in the repo until one full day of Rust-only traffic passes.
5. Rollback: restart Node on `:20127`, repoint clients. The DB is shared, so no data is lost either way.

## Open Questions

None that would change the specs, approach, or task breakdown. Internal tuning (r2d2 pool size, busy_timeout value, JWT TTL) can be decided during implementation.
