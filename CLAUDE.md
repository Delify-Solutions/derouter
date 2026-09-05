@AGENTS.md

# derouter rewrite — project state & known issues

## Architecture (final — all 4 phases archived 2026-09-05)

Strangler rewrite of the derouter AI proxy/fallback-router **complete**. Node.js
(Next.js 16 + React + better-sqlite3) → **Stack A1**: Rust (Axum + rusqlite) is the
**sole backend**; Next.js 16 strict-TS is a pure UI shell calling the Rust JSON API
via a typed `apiClient` (`src/shared/api/client.ts`, CORS + `credentials:'include'`).
2-service docker (shared SQLite volume `${DATA_DIR}/db/data.sqlite`).

- Rust backend: `derouter-rs/` — all `/api/*` admin + `/v1/*` proxy + 16 cli-tools
  config-writers + 13 oauth + 22 executors. Port 20128.
- Next.js frontend: `src/` — UI only, ZERO frontend `.js` (strict-TS gate). Port 20128.
- DB reused (`${DATA_DIR}/db/data.sqlite`, default `~/.derouter/db/data.sqlite`).
- Cursor D1 executor byte-verified 6/6.

### OpenSpec archive (all 4 phases)
- `openspec/changes/archive/2026-09-04-phase1-rust-json-ts-frontend/`
- `openspec/changes/archive/2026-09-05-phase2-rust-json-admin-parity/`
- `openspec/changes/archive/2026-09-05-phase3-rust-executors-registry/`
- `openspec/changes/archive/2026-09-05-phase4-frontend-strict-ts-backend-removal/`

### Hard invariants (carry forward)
1. Mask API keys `****` / `sk-…****last4` — never leak full keys.
2. `.env` not tracked; real secrets hidden before any push.
3. Every `/api/*` except `/api/health` → 401 JSON `{"error":"Unauthorized"}` without
   cookie (not HTML redirect). loginLimiter + mustChangePassword + tunnel guard.
4. CORS: credentials, expose `Set-Cookie`+`Retry-After`, origins from env,
   **never `Any`**.
5. Settings secret stripping: `hasPassword`/`oidcConfigured` computed BEFORE strip.
6. Proxy `/v1/*` untouched — existing 22 executors + chat/resolve/limits/detail.
7. JSON errors only (`{"error":"..."}`), never HTML/panic. SSE = `text/event-stream`.
8. Rust binds `0.0.0.0` via `HOST` env, **NEVER `HOSTNAME`** (Docker sets HOSTNAME to
   container ID → parse panic).
9. Cursor D1: byte-verified protobuf or DEFER (never ship broken executor).

### Build commands
- `cargo build --release --manifest-path /Volumes/SSD/proxy/derouter-rs/Cargo.toml`
- `cargo clippy --release --manifest-path /Volumes/SSD/proxy/derouter-rs/Cargo.toml`
- `cargo test byte_verify --manifest-path /Volumes/SSD/proxy/derouter-rs/Cargo.toml`
- `npx tsc --noEmit` (from `/Volumes/SSD/proxy`)
- `npm run build`
- `docker compose build` / `docker compose up -d`

## KNOWN POST-ARCHIVE BUGS (discovered 2026-09-06 during docker test)

These two bugs were missed by Phase 4 osf-verify (curl sweep hit JSON endpoints but
did not drive the browser login flow end-to-end). They block the admin panel from
being usable. **Fix on `main` before release.**

### BUG 1 — Dashboard accessible without login (auth gate missing)

**Symptom:** `https://<nextjs-host>/dashboard/providers` returns HTTP 200 and renders
the dashboard shell even with no auth cookie. Rust `/api/providers` correctly returns
401, so data is empty — but the page looks "open".

**Root cause:** Node.js `custom-server.js` + `dashboardGuard.js` used to gate
`/dashboard/*` server-side (redirect → login HTML when no session). Phase 4 deleted
all Node backend (`src/proxy.js`, `src/dashboardGuard.js`, `custom-server.js`) and
the Askama login HTML route (Rust `login_page` handler + `templates/auth/login.html`,
removed during Askama stripping). No replacement auth gate was created in Next.js —
there is **no `middleware.ts`** and **no `/login` route** in the frontend.
`src/shared/components/layouts/AuthLayout.tsx` exists from the Phase-1 scaffold but
is unused (no page imports it). `DashboardLayout.tsx` only wraps Sidebar+Header, no
auth check. `Header.tsx` calls `/api/auth/status` to display user info but never
redirects when `authenticated:false`.

**Fix:**
1. Create `src/middleware.ts` (Next.js root middleware): gate `/dashboard/*` — if
   no `auth_token` cookie → redirect `/login`; allow `/login` and public routes.
   Do NOT verify the JWT in middleware (don't leak the secret / avoid a round-trip
   complexity); presence of the cookie is a sufficient pessimistic gate. The Rust
   API still enforces real JWT verification on every `/api/*`.
2. Create `src/app/login/page.tsx` (client component wrapped by `AuthLayout`):
   password form → `POST /api/auth/login` with `{password}`, handle 401
   (`{error, remainingBeforeLock}`) and 429 (`{error, retryAfter, resetHint}`), on
   success redirect `/dashboard`. Show OIDC/SAML buttons when
   `/api/auth/status` reports `oidcConfigured`/`samlConfigured`.
3. Login API contract (Rust, already built):
   - `POST /api/auth/login` body `{password}` → 200 sets `auth_token` cookie +
     `{success:true, mustChangePassword:false}`; 401 `{error, remainingBeforeLock}`;
     429 `{error, retryAfter, resetHint}` (+ `Retry-After` header).
   - `GET /api/auth/status` → `{authenticated, authMode, ssoType, oidcConfigured,
     oidcLoginLabel, samlConfigured, samlLoginLabel, hasPassword, displayName,
     loginMethod, oidc*, saml*}`.
   - Cookie name: `auth_token` (HttpOnly, `SameSite=Lax`, `Secure` per-proto),
     max-age 86400s. Verified `derouter-rs/src/web/routes/auth.rs:285`.

### BUG 2 — Frontend cannot reach the Rust API (api routing broken)

**Symptom:** After docker `compose up`, the browser on `https://derouter.proxy.orb.local/`
cannot reach the Rust API. Two mutually-broken call patterns coexist:

- **24 components** use `fetch("/api/...")` (relative) — these resolve to the Next.js
  server, which no longer has a Node API (deleted in Phase 4) → 404 / HTML.
- **35 components** use `apiClient` (`apiGet/apiPost/...`) with
  `NEXT_PUBLIC_API_URL=http://derouter-rs:20128`. This is an internal-Docker hostname
  embedded in the browser bundle at build time. The browser running on the host
  **cannot resolve `derouter-rs`** (verified: NXDOMAIN from host; resolves only
  inside the Docker network). So every browser-side `apiClient` call fails.

**Root cause:** Phase 4 deleted the Node `/api/*` routes that the relative `fetch`
calls were hitting, AND `NEXT_PUBLIC_API_URL` was set to an internal-only hostname
that browsers can't resolve. No reverse-proxy / rewrite bridges browser requests
to Rust.

**Fix (recommended — single-origin via Next.js rewrites):**
1. In `next.config.*`, add `rewrites()` mapping `/api/*` and `/v1/*` →
   `http://derouter-rs:20128/$1` (internal Docker DNS, resolved server-side by
   Next.js — works because Next.js runs inside the Docker network). This makes the
   browser call same-origin `/api/*`, Next.js proxies internally to Rust.
2. Change the 24 relative `fetch("/api/...")` calls to use `apiClient`, and set
   `NEXT_PUBLIC_API_URL` to **empty/relative** so `apiClient` calls `/api/*`
    same-origin (then Next.js rewrite forwards). Alternatively keep `apiClient` but
   ensure it produces same-origin paths.
3. With same-origin, the `auth_token` HttpOnly cookie is sent automatically
   (no CORS, no cross-origin cookie hassles). Drop the cross-origin CORS dependency
   for the browser path (Rust CORS layer still needed for any direct cross-origin
   API clients).
4. Verify, per environment, that `NEXT_PUBLIC_API_URL` resolves from wherever the
   browser runs, OR use same-origin rewrites so it's not needed at all.

**Affected files (sampling):** `src/shared/components/Header.tsx` (relative
`/api/auth/status`, `/api/auth/logout`), ~23 more dashboard pages with relative
`fetch("/api/...")`; all `apiClient` consumers depend on `NEXT_PUBLIC_API_URL`.

### Why these slipped

Phase 4 verify did a curl sweep (Rust 200/401 JSON, Next.js `/api/*` 404) and
declared it clean — but **never drove a browser login** to catch that the login
route didn't exist and the API was unreachable from the browser. The
`login → dashboard → providers CRUD` browser-smoke task (tasks.md 6.4) was not
actually executed; it was inferred from the curl sweep.

## Working on this repo

- Branch `feat/derouter-rust-port`. Do NOT push `main`.
- The user works on `main` to fix the bugs above; this branch holds the rewrite.
- All four archive dirs are read-only reference — do not modify archived changes.
