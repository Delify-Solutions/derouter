## Why

The derouter Rust port (`derouter-rs/`) currently serves its admin UI via HTMX/Askama — a hand-rolled, minimal interface that is visibly inferior to the polished Next.js + Tailwind + Material-Symbols design already running in the Node original. The locked decision (Stack A1): keep the beautiful React frontend, make Rust a JSON API backend, and convert the frontend to strict TypeScript. This change is **Phase 1** of a 4-phase full-parity migration — it delivers the auth flow and the 7 core admin CRUD areas (providers, keys, combos, groups, pricing, usage, settings) end-to-end through Rust JSON + React/TS, proving the pattern works before scaling to the remaining 150+ routes and 28 executors in Phases 2-4.

## What Changes

- **Rust backend** converts admin/auth routes from HTMX HTML fragments to **JSON responses** (Axum `Json`), so a React/TS frontend can consume them as an API client.
- Wire **CORS** on the Rust server (`tower-http/cors`, feature already in Cargo.toml) to allow the Next.js origin with credentials.
- **Auth parity with Node**: `POST /api/auth/login` (returns `{success, mustChangePassword}` + httpOnly JWT cookie), `GET /api/auth/status`, `POST /api/auth/logout`. Port the Node `loginLimiter` (DashMap, 5 fails → progressive lock 30s/2m/10m/30m, 1h window reset), `mustChangePassword` (default-password-on-remote → 403, no token — CVE-protection), `isTunnelRequest` tunnel-access guard, JWT-secret file pattern (`DATA_DIR/jwt-secret`).
- **Core admin JSON routes** ported from Node validation 1:1: `/api/providers` (normalizeProviderId, normalizeProxyConfig, normalizeProxyPoolId, APIKEY/FREE_TIER/WEB_COOKIE/compatible/embedding provider lists), `/api/keys` (machineId, group, rpm/tpm/budget/expiry/allowedModels), `/api/combos`, `/api/groups`, `/api/pricing`, `/api/usage/*` (stats, request-details with apiKey filter + includeRaw toggle, request-logs, stream), `/api/settings` (strip secrets, PATCH password with current-pw verify), `GET /api/usage/key` (public key-holder receipts as JSON).
- **Guard change**: admin API routes return **401 JSON** (not 303 redirect) when `auth_token` cookie is missing/invalid — API clients, not browsers.
- **Provider validation data** ported from `src/shared/constants/{providers,config}.js` into Rust modules under `derouter-rs/src/providers/`.
- **Frontend TS scaffold**: `tsconfig.json` (strict, `@/*` alias), `typescript` + `@types/*` deps, `tsc --noEmit` gate.
- **Typed API client** `src/shared/api/client.ts` (apiGet/apiPost/apiPatch/apiDelete with `NEXT_PUBLIC_API_URL` base + `credentials: 'include'`).
- **API types** `src/shared/types/*.ts` (ProviderConnection, ApiKey, Combo, KeyGroup, Pricing, UsageStats, RequestDetail, Settings, AuthStatus, LoginResponse).
- **Proof-of-pattern TS conversions**: `login`, `dashboard layout`, `providers`, `keys` pages + 10 shared components (Button, Card, Input, Select, Modal, Drawer, SegmentedControl, Badge, Sidebar, Header) — call Rust via apiClient. **BREAKING** for these pages (now call Rust instead of Next.js internal API); unconverted pages keep using Node API routes during transition.
- **Infrastructure**: `docker-compose.yml` adds `derouter-rs` service; `.github/workflows/rust-ci.yml` adds `tsc --noEmit` step.

## Capabilities

### New Capabilities
- `rust-json-api`: Rust backend serves admin/auth routes as JSON (CORS, JWT-cookie auth, login limiter, mustChangePassword, tunnel guard) — the API contract the Next.js frontend consumes.
- `ts-frontend`: TypeScript scaffold, typed API client, and proof-of-pattern React/TS pages calling the Rust JSON API.

### Modified Capabilities
- `admin-auth`: Auth flow changes from HTTP-form/redirect (HTMX) to JSON request/response with cookie; adds login lockout + mustChangePassword + tunnel guard parity with Node.
- `key-management`: API keys CRUD now served as JSON with full Node validation (group/rpm/tpm/budget/expiry/allowedModels/machineId).
- `admin-portal`: providers/combos/groups/pricing CRUD served as JSON; provider-create validation matches Node 1:1.
- `usage-tracking`: usage stats/request-details (apiKey filter + includeRaw) served as JSON; public key-holder usage as JSON.
- `public-usage-view`: `/api/usage/key` returns JSON receipts (was HTML fragments).

## Impact

- **Rust** (`derouter-rs/`): new `src/auth/login_limiter.rs`, `src/providers/{mod,config,lists}.rs`; rewrite `src/web/routes/{auth,providers,combos,keys,groups,pricing,usage,settings,public_usage}.rs` to JSON; wire CORS in `main.rs`; deps: add `dashmap`, `axum-extra` to `Cargo.toml`.
- **Frontend** (`src/`): new `tsconfig.json`, `src/shared/api/client.ts`, `src/shared/types/`; convert `login`, `dashboard/layout`, `providers`, `keys` pages + 10 components to TS. `package.json` adds TS deps. Node `src/app/api/**` routes remain (unconverted pages use them).
- **Infra**: `docker-compose.yml` adds `derouter-rs` service; `.github/workflows/rust-ci.yml` adds TS gate.
- **No DB schema change** (shared SQLite unchanged). Proxy `/v1/*` routes untouched.
- Risk: parallel Next.js + Rust during transition — CORS + cookie domain careful; `auth_token` issued by Rust, consumed cross-origin.
