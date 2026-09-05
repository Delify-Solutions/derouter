## Context

The Rust port (`derouter-rs/`, Axum + rusqlite + Askama + HTMX) currently serves admin/auth via Askama HTML fragments. Phase 1 makes Rust a JSON API backend and moves UI to a Next.js + TypeScript frontend. The existing Rust proxy (`/v1/*`) and DB layer (`db/repos/*`) are reused unchanged. The Node app keeps running for unconverted pages, so this is a strangler step: both processes coexist, converted pages call Rust, unconverted pages keep using Node `src/app/api/**`.

Key existing pieces to reuse: `auth::verify_dashboard_password` (argon2+bcrypt), `db::repos::{api_keys, key_groups, combos, settings, usage, request_details, connections}`, `tower-http/cors` feature (already in Cargo.toml), the `json_not_found` fallback + `0.0.0.0` bind (already fixed).

## Goals / Non-Goals

**Goals:**
- Rust serves `/api/auth/*` + 7 core admin areas as JSON with full Node validation parity.
- CORS configured so Next.js (port 3000/20127) calls Rust (20128) with cookies.
- Auth parity: loginLimiter, mustChangePassword, tunnel guard, JWT cookie (httpOnly/Secure-per-proto).
- Next.js TS scaffold + typed apiClient + proof-of-pattern pages (login, layout, providers, keys) + 10 components.
- Both services runnable via docker-compose.

**Non-Goals:**
- 22 remaining executors / 123 provider registry full port (Phase 3).
- cli-tools/mcp/tunnels/pxpipe/translator/headroom/media routes (Phase 3).
- proxy-pools/provider-nodes/tags/version/shutdown/locale/models/init/health routes (Phase 2).
- Full SSO/SAML/OIDC login flows (only detect configured state).
- Converting the remaining ~405 JS files to TS (Phase 4).
- Removing Askama templates / htmx.min.js / alpine.min.js (Phase 4 cleanup — keep in tree to avoid breaking build).

## Decisions

### D1 — CORS: allow-list, credentials, preflight
Use `tower_http::cors::CorsLayer` with `allow_origin` = parsed list from `CORS_ORIGIN` env (default `["http://localhost:3000","http://localhost:20127"]`), `allow_credentials(true)`, `allow_headers([COOKIE, CONTENT_TYPE, AUTHORIZATION])`, `allow_methods` per route. Apply as a `.layer()` on the Router (global). Alternatives: `any()` origin — rejected (we need credentials, which forbids `*`). The CORS preflight (OPTIONS) is handled by the layer automatically.

### D2 — Auth routes as JSON, 401 (not redirect) for API
`auth.rs` handlers return `Json(...)` / `(StatusCode::X, Json(...))`. The `RequireAdmin` extractor (`auth/guards.rs`) currently returns 303-redirect for HTML requests and 401 for JSON; for Phase 1 all `/api/*` admin routes get the JSON branch (401 `{"error":"Unauthorized"}`). The existing HTMX login page route stays (for direct browser nav) unless Next.js fully owns `/login` — for Phase 1, Next.js owns `/login`, Rust only exposes `POST /api/auth/login` (JSON). Keep the Askama `LoginPage` template in-tree but unused.

### D3 — LoginLimiter via DashMap (in-memory)
Add `dashmap` dep. `LoginLimiter` is a `OnceCell<DashMap<IpString, Entry>>` with `check_lock`, `record_fail`, `record_success`. Constants mirror `loginLimiter.js`: `MAX_FAILS_BEFORE_LOCK=5`, `LOCK_STEPS_MS=[30s,120s,600s,1800s]`, `FAIL_WINDOW_MS=3600s`. `get_client_ip` honors trusted-peer headers (mirror `trustedPeer.js` — only trust `x-forwarded-for` when custom-server stamped it; for Rust behind no custom-server, trust socket peer for loopback, else first x-forwarded-for entry). In-memory = resets on restart (same as Node). Alternatives: SQLite-persisted limiter — rejected (Node is in-memory; parity).

### D4 — mustChangePassword branch
In `login`, after password validates: if `stored_hash.is_none() && env INITIAL_PASSWORD unset && !is_local_request` → return 403 `{success:false, mustChangePassword:true}` WITHOUT issuing token. `is_local_request` checks loopback IPs + trusted-peer headers. This mirrors the Node CVE-protection branch exactly.

### D5 — JWT secret file
`load_jwt_secret`: read `JWT_SECRET` env, else read `${DATA_DIR}/jwt-secret`, else generate 32 random bytes hex and write to `${DATA_DIR}/jwt-secret` mode 0600. Loaded once via `OnceCell`. Mirror `dashboardSession.js` `loadJwtSecret`. Token: HS256, 24h expiry, claims `{authenticated:true}`. Reuse existing `jsonwebtoken` crate.

### D6 — Provider validation data ported to Rust
New `derouter-rs/src/providers/` module: `lists.rs` (APIKEY_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS as `&[&'static str]` / phf sets), `config.rs` (provider id → alias/baseUrl/kind), `classify.rs` (`is_openai_compatible_provider`, `is_anthropic_compatible_provider`, `is_custom_embedding_provider`, `supports_apikey_mode`, `normalize_provider_id`). Ported from `src/shared/constants/{providers,config}.js`. This is data, not UI. `normalizeProxyConfig` + `normalizeProxyPoolId` (lookup in `proxy_pools` repo) ported as Rust functions in the providers route.

### D7 — Frontend apiClient base URL + credentials
`src/shared/api/client.ts` exports `apiGet<T>, apiPost<T>, apiPatch<T>, apiDelete<T>` using `fetch` with `credentials:'include'`, `headers: {'Content-Type':'application/json'}`, base from `process.env.NEXT_PUBLIC_API_URL` (default `http://localhost:20128`). On non-2xx, parse JSON `{error}` and throw a typed `ApiError`. No global state — each page fetches what it needs (matches existing React component pattern).

### D8 — TS conversion: incremental, allowJs true
`tsconfig.json`: `strict:true`, `allowJs:true`, `jsx:preserve`, paths `@/*` → `./src/*`. `allowJs:true` so unconverted `.js` files are still imported by `.tsx` without errors; `tsc --noEmit` checks only `.ts/.tsx` + files they import. Convert the named proof-of-pattern files first; the rest type-check gradually. Alternatives: convert all-or-nothing — rejected (block parallel-run). CI runs `next build` (already a gate via webpack) + `tsc --noEmit` on the converted set.

### D9 — 401 JSON for admin API
The admin route handlers use a small helper `fn require_auth(claims) -> Result<..., (StatusCode, Json<ErrResp>)>`. `RequireAdmin` extractor stays for any remaining HTMX pages but admin `/api/*` routes wire 401-JSON explicitly. Cookie read via `axum::extract::TypedHeader<Cookie>`. `auth_token` validated by the same `verify_token` used by proxy limits.

### D10 — docker-compose two services
`docker-compose.yml`: add `derouter-rs` (build `./derouter-rs`, ports 20128:20128, volume derouter-data, env DATA_DIR=/app/data, CORS_ORIGIN, NEXT_PUBLIC_API_URL). Keep `derouter` (Node) — it runs on 20127, env `NEXT_PUBLIC_API_URL=http://derouter-rs:20128`. Both share the volume so converted pages and unconverted pages see the same data. Rollback: stop `derouter-rs`, Node serves everything again (its `src/app/api/**` routes remain).

## Risks / Trade-offs

- **Cross-origin cookie + SameSite=Lax**: SameSite=Lax allows the cookie on top-level GET navigations and same-site fetch, but cross-origin XHR with `credentials:'include'` requires `SameSite=None; Secure` OR same-site. Since Rust (20128) and Next.js (3000) differ in port but same host (localhost), browsers treat same-host different-port as same-site for SameSite=Lax in most browsers — but to be safe over HTTPS/different hosts, set `SameSite=Lax` (matches Node) and rely on CORS `allow-credentials`. **Risk**: some browsers treat different port as cross-site → cookie not sent. **Mitigation**: document that production should serve both behind one origin (reverse proxy), or set `AUTH_COOKIE_SECURE` + `SameSite=None` for cross-host. Phase 1 dev runs same-host.
- **Two DB writers (Node + Rust) during transition**: both open the same SQLite (WAL mode). WAL handles concurrent readers + one writer; concurrent writes serialize via busy_timeout. **Risk** if both write heavily. **Mitigation**: write traffic in Phase 1 is admin-only (low); keep `busy_timeout` high (already set). Monitor for lock errors.
- **In-memory login limiter resets on Rust restart** — parity with Node, but if you restart Rust frequently, lockout resets. Acceptable (matches Node).
- **Provider validation lists drift**: Rust ports a snapshot of `src/shared/constants/providers.js`. If Node adds providers later, Rust lags. **Mitigation**: Phase 3 ports the full registry (dynamic); Phase 1 uses the snapshot for the core API-key providers only.

## Migration Plan

1. Implement Rust JSON + CORS + auth parity; build clean; smoke `curl` all endpoints.
2. Scaffold Next.js TS (tsconfig, deps, apiClient, types) without touching existing pages.
3. Convert login → providers → keys pages to TS (call Rust). Unconverted pages untouched.
4. `docker compose up` both; browser test login → dashboard → providers.
5. Rollback: stop `derouter-rs`, revert the 4 page TS files to their `.js` (kept in git), Node serves all again.

## Open Questions

- None material to Phase 1. (Cookie SameSite across ports in production is a Phase-3+ deployment concern, documented in D10/Risks.)
