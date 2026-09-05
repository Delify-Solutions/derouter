## 1. Rust dependencies & provider data

- [x] 1.1 Add deps to `derouter-rs/Cargo.toml`: `dashmap = "6"`, `axum-extra = "0.10"` (typed cookies/extractors), confirm `tower-http = { features = ["cors", ...] }` (cors present)
- [x] 1.2 Create `derouter-rs/src/providers/mod.rs` module (declare submodules)
- [x] 1.3 Create `derouter-rs/src/providers/lists.rs`: port `APIKEY_PROVIDERS`, `FREE_TIER_PROVIDERS`, `WEB_COOKIE_PROVIDERS` from `src/shared/constants/providers.js` as phf/static sets; `AI_PROVIDERS` authModes for `supports_apikey_mode`
- [x] 1.4 Create `derouter-rs/src/providers/config.rs`: port `normalizeProviderId`, provider id → alias mapping, `isOpenAICompatibleProvider`, `isAnthropicCompatibleProvider`, `isCustomEmbeddingProvider` from `src/shared/constants/{providers,config}.js`
- [x] 1.5 Create `derouter-rs/src/providers/classify.rs`: `is_valid_provider(provider)`, `supports_apikey_mode(provider)`, combining lists + classify functions  ← (verify: matches Node provider validity for openai/anthropic/gemini/azure/ollama/apikey/web-cookie/compatible/embedding)

## 2. Auth parity (Rust)

- [x] 2.1 Create `derouter-rs/src/auth/login_limiter.rs`: `LoginLimiter` (DashMap, `MAX_FAILS_BEFORE_LOCK=5`, `LOCK_STEPS_MS=[30s,120s,600s,1800s]`, `FAIL_WINDOW_MS=3600s`), `check_lock(ip)`, `record_fail(ip)`, `record_success(ip)`, `get_client_ip(headers, connect_info)` honoring trusted peer headers
- [x] 2.2 Port `load_jwt_secret` in `derouter-rs/src/auth/mod.rs`: `JWT_SECRET` env → `${DATA_DIR}/jwt-secret` → generate 32-byte hex (mode 0600), `OnceCell`
- [x] 2.3 Add `is_tunnel_request(headers, settings)` + `is_local_request(headers)` helpers
- [x] 2.4 Add `is_oidc_configured(settings)` + `is_saml_configured(settings)` (read settings flags for auth/status) — detection only, no flows
- [x] 2.5 Rewrite `derouter-rs/src/web/routes/auth.rs` to JSON: `POST /api/auth/login` (loginLimiter check → password verify → mustChangePassword branch → issue cookie → `{"success":true,"mustChangePassword":false}`), `GET /api/auth/status` (mirror Node status response shape), `POST /api/auth/logout` (clear cookie)
- [x] 2.6 `Set-Cookie` attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `x-forwarded-proto:https` or `AUTH_COOKIE_SECURE=true`
- [x] 2.7 Update `derouter-rs/src/auth/guards.rs`: 401 JSON `{"error":"Unauthorized"}` for `/api/*` (typed Json response), keep redirect only for any non-`/api` HTML page route
## [x] 2.8 ← (verify: cargo build clean; `curl POST /api/auth/login` wrong pw 5x → 429 with Retry-After; correct pw → 200 + Set-Cookie auth_token HttpOnly; default-pw remote → 403 mustChangePassword no token)

## 3. CORS (Rust)

- [x] 3.1 Add `CorsLayer` in `derouter-rs/src/main.rs`: allow_origin from `CORS_ORIGIN` env (comma-split, default `["http://localhost:3000","http://localhost:20127"]`), `allow_credentials(true)`, allow_headers `[COOKIE, CONTENT_TYPE, AUTHORIZATION]`, allow_methods per route, exposed header `Set-Cookie`/`Retry-After`
- [x] 3.2 Apply `.layer(CorsLayer)` on the Router (global), before `.with_state`
- [x] 3.3 Verify OPTIONS preflight returns 204 with allowed headers/origin ← (verify: `curl -I -X OPTIONS -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: POST" .../api/auth/login` → 204 + Access-Control-Allow-Origin + Allow-Credentials)

## 4. Admin routes HTMX → JSON (Rust)

- [x] 4.1 Rewrite `derouter-rs/src/web/routes/providers.rs`: `GET /api/providers` (strip apiKey/accessToken/refreshToken/idToken, enrich name), `POST /api/providers` (full validation: normalizeProviderId, normalizeProxyConfig, normalizeProxyPoolId via proxy_pools repo, provider validity), PUT/DELETE `/api/providers/{id}`
- [x] 4.2 Rewrite `derouter-rs/src/web/routes/keys.rs`: `GET/POST /api/keys` (machineId via getConsistentMachineId, group/rpm/tpm/budgetUsd/resetWindow/expiresAt/allowedModels), `PUT/DELETE /api/keys/{id}`; 401 JSON without cookie
- [x] 4.3 Rewrite `derouter-rs/src/web/routes/combos.rs`: `GET/POST /api/combos`, `PUT/DELETE /api/combos/{id}`, `POST /api/combos/{name}/test` (internal-ping returns `{ok, latencyMs, status, content, error?, note?}`)
- [x] 4.4 Rewrite `derouter-rs/src/web/routes/groups.rs`: `GET/POST /api/groups`, `PUT/DELETE /api/groups/{id}`
- [x] 4.5 Rewrite `derouter-rs/src/web/routes/pricing.rs`: `GET/POST /api/pricing`
- [x] 4.6 Rewrite `derouter-rs/src/web/routes/settings.rs` (new or extend): `GET /api/settings` (strip password/oidcClientSecret/mitmSudoEncrypted, add hasPassword), `PATCH /api/settings` (currentPassword verify for password change, argon2 hash new)
- [x] 4.7 Rewrite `derouter-rs/src/web/routes/usage.rs`: `GET /api/usage/stats`, `GET /api/usage/request-details` (apiKey filter + includeRaw toggle + masked apiKey per row), `GET /api/usage/request-logs`, `GET /api/usage/stream` (SSE)
- [x] 4.8 Rewrite `derouter-rs/src/web/routes/public_usage.rs`: add `GET /api/usage/key` (JSON receipts, masked key) + `DELETE /api/usage/key/history` (keep existing HTML `/usage` page route behavior — 404 on unknown/inactive)
- [x] 4.9 Mount all `/api/*` routes in `derouter-rs/src/main.rs`; remove the HTMX `/dashboard/*` admin routes from the router (keep proxy `/v1/**`); keep `json_not_found` fallback
- [x] 4.10 ← (verify: `curl -H "Cookie: auth_token=<jwt>" /api/providers` → JSON; without → 401 JSON; `POST /api/providers` bad provider → 400 JSON; `/api/usage/key?key=bogus` → 404 JSON)

## 5. Frontend TS scaffold

- [x] 5.1 Create `tsconfig.json` (strict, `allowJs:true`, `jsx:preserve`, paths `@/*`→`./src/*`), add `typescript`, `@types/node`, `@types/react`, `@types/react-dom` to `package.json`
- [x] 5.2 Create `src/shared/api/client.ts`: `apiGet<T>`, `apiPost<T>`, `apiPatch<T>`, `apiDelete<T>` (base `NEXT_PUBLIC_API_URL` default `http://localhost:20128`, `credentials:'include'`, JSON headers, `ApiError` on non-2xx)
- [x] 5.3 Create `src/shared/types/index.ts`: `ProviderConnection`, `ApiKey`, `Combo`, `KeyGroup`, `Pricing`, `UsageStats`, `RequestDetail`, `Settings`, `AuthStatus`, `LoginResponse` matching Rust JSON shapes
- [x] 5.4 Add `NEXT_PUBLIC_API_URL=http://localhost:20128` to `.env.example` (and dev env)
- [x] 5.5 Add `tsc --noEmit` script to `package.json` (`"type-check": "tsc --noEmit"`) ← (verify: `npx tsc --noEmit` passes; `npm run type-check` green)

## 6. Frontend convert proof-of-pattern pages

- [x] 6.1 Convert `src/shared/components/{Button,Card,Input,Select,Modal,Drawer,SegmentedControl,Badge,Sidebar,Header}.js` → `.tsx` with typed props
- [x] 6.2 Convert `src/app/login/page.js` → `.tsx` using `apiPost('/api/auth/login')` + `apiGet<AuthStatus>('/api/auth/status')`
- [x] 6.3 Convert `src/app/(dashboard)/dashboard/layout.js` → `.tsx` (auth check via apiClient, sidebar)
- [x] 6.4 Convert `src/app/(dashboard)/dashboard/providers/page.js` → `.tsx` using `apiGet<ProviderConnection[]>('/api/providers')` + CRUD via apiClient
- [x] 6.5 Convert `src/app/(dashboard)/dashboard/keys/page.js` → `.tsx` using `apiGet<ApiKey[]>('/api/keys')` + CRUD
- [x] 6.6 Replace any `fetch('/api/...')` in the 4 converted pages with the typed apiClient (cross-origin to Rust)
- [x] 6.7 ← (verify: `npx tsc --noEmit` 0 errors; converted pages render; providers page loads data from Rust)

## 7. Infrastructure

- [x] 7.1 Update `docker-compose.yml`: add `derouter-rs` service (build `./derouter-rs`, port 20128, volume `derouter-data`, env `DATA_DIR=/app/data`, `CORS_ORIGIN=http://localhost:3000,http://localhost:20127,http://derouter:20127`); set `NEXT_PUBLIC_API_URL=http://derouter-rs:20128` on the `derouter` Node service
- [x] 7.2 Update `.github/workflows/rust-ci.yml`: add `npx tsc --noEmit` step (frontend gate), keep rust build/clippy
- [x] 7.3 ← (verify: `docker compose up` → both services healthy; `docker logs derouter-rs` shows "Listening on 0.0.0.0:20128"; Node starts without error)

## 8. End-to-end verification

- [x] 8.1 `cargo build --release` clean (0 errors); `cargo clippy -D warnings` clean (allow pre-existing dead-code for retained templates)
- [x] 8.2 Run Rust container + Node (Next.js) via docker-compose; browser: login (admin/123456) → dashboard → providers list renders from Rust API → keys list
- [x] 8.3 `curl` sweep: `/api/auth/status` JSON; login → Set-Cookie; `/api/providers` 401 without cookie / 200 with; 5 bad logins → 429; `/api/usage/key?key=bogus` → 404; CORS headers present with Origin header
- [x] 8.4 Confirm proxy `/v1/*` routes untouched: `POST /v1/chat/completions` with real key+combo still returns completion ← (verify: full Phase 1 acceptance — JSON API + TS frontend working end-to-end, proxy unchanged, parallel-run intact)
