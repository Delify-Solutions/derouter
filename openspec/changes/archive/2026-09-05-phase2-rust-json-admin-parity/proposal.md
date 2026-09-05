## Why

Phase 1 made the Rust backend a JSON API for core admin (auth, providers, keys, combos, groups, pricing, settings, usage) and scaffolded the TypeScript frontend. The remaining ~35 admin routes — proxy-pools, provider-nodes, models catalog, version/shutdown/locale/init/health, plus the providers/settings/usage sub-routes and auth/reset-password — still run on the Node `src/app/api/**` layer. Phase 2 ports these to Rust so every admin route is served by a single Rust JSON backend, leaving only the proxy executors, provider registry, and cli-tools/mcp/tunnel/pxpipe/translator/headroom/media/oauth flows for Phase 3.

## What Changes

- **New Rust route modules**: `proxy_pools.rs` (CRUD + test + cloudflare/deno/vercel deploy), `provider_nodes.rs` (CRUD + validate), `models.rs` (catalog + alias + availability + catalog-sync + custom + disabled + test), `version.rs` (version + shutdown + update), `locale.rs`, `init.rs`, `health.rs`, `tags.rs`, `oauth.rs` (gitlab PAT only).
- **Extend existing Rust routes**: `usage.rs` (chart, history, key-summary, logs, providers, per-connection, codex-reset-credits), `providers.rs` (models/test/test-models/client/kilo-free-models/suggested-models/test-batch/validate sub-routes), `settings.rs` (database, proxy-test, require-login), `auth.rs` (reset-password).
- **All new `/api/*` routes require `auth_token` cookie** → 401 JSON without it (existing Phase 1 guard). Proxy `/v1/*` routes untouched.
- **Minimal model capabilities map**: ports `getCapabilitiesForModel` for the AI_MODELS catalog only; the full 123-entry provider registry is Phase 3.
- **Tags**: static ollama model list ported to a Rust const array from `open-sse/config/ollamaModels.js`.
- **Frontend TypeScript**: convert the dashboard pages that consume Phase 2 routes — proxy-pools, combos, groups, pricing, usage tabs + components, endpoint, quota, profile, ProviderLimits — to `.tsx` calling the typed apiClient against Rust. Leaves cli-tools/mcp/media/tunnel/pxpipe/translator/basic-chat/skills/token-saver/mitm pages as JS (Phase 3).
- **No Node source changes** except the listed TS conversions. Node `src/app/api/**` routes stay running for unconverted Phase 3 pages until Phase 4 removes them.

## Capabilities

### New Capabilities
- `proxy-pool-management`: CRUD, connectivity test, and platform deploy (Cloudflare/Deno/Vercel) for proxy pools
- `provider-node-management`: CRUD and validation for compatible/embedding provider nodes with baseUrl defaulting per prefix
- `model-catalog`: admin model catalog with aliases, availability, custom models, disabled-model toggling, catalog sync, and model test; minimal capabilities map (full registry deferred to Phase 3)
- `system-operations`: version info, graceful shutdown, self-update, locale, first-run init status, and health check

### Modified Capabilities
- `admin-auth`: adds `POST /api/auth/reset-password` completing the must-change-password loop
- `admin-portal`: adds provider sub-routes (models/test/test-models/client/suggested/test-batch/validate), settings sub-routes (database/proxy-test/require-login), and proxy-pool deploy hooks onto the existing portal API
- `usage-tracking`: adds chart, history, key-summary, logs, providers, per-connection usage, and codex-reset-credits sub-routes
- `ts-frontend`: converts the remaining dashboard pages (proxy-pools, combos, groups, pricing, usage, endpoint, quota, profile) to typed TypeScript
- `rust-json-api`: extends the JSON admin surface to all Phase 2 routes under the same CORS + auth-cookie + 401-JSON contract

## Impact

- **Rust**: 9 new route files under `derouter-rs/src/web/routes/`; 4 existing route files extended; new repo functions in `derouter-rs/src/db/repos/` for proxy_pools/provider_nodes/model_aliases/custom_models/disabled_models; new `derouter-rs/src/providers/capabilities.rs` minimal map; `main.rs` mounts all new `/api/*` routes behind the existing auth layer.
- **Frontend**: ~9 dashboard pages + their client components + ProviderLimits subtree converted `.js`→`.tsx`; new response types in `src/shared/types/`.
- **Node**: no deletions; `src/app/api/**` admin routes remain as the fallback for Phase 3 pages until removed in Phase 4.
- **Infra**: `docker-compose.yml` and CI unchanged from Phase 1 (services + `tsc --noEmit` gate already in place).
- **Dependencies**: none new for Rust (existing axum/rusqlite/reqwest cover all Phase 2 needs); none new for frontend.
- **DB schema**: unchanged (proxy_pools, provider_nodes, model_aliases, custom_models, disabled_models tables already exist — Node uses them; Rust reuses the same file).
