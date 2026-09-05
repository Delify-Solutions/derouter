## Why

Phases 1-3 ported the entire derouter backend (auth, all admin routes, 22 proxy executors, 122-entry provider registry, route groups, OAuth flows) to the Rust JSON API and converted the Phase-1-through-3 dashboard pages to TypeScript. The Node backend now only survives as redundant fallback: ~186 admin/proxy route files in `src/app/api/**`, ~135 `src/lib/**` modules, ~23 `src/sse/**` proxy handlers, and ~24 `src/mitm`/`src/store` files — all behaviorally superseded by Rust. Meanwhile ~112 frontend JS files (shared components, hooks, utils, remaining pages) still keep `npx tsc --noEmit` from being a hard repo-wide gate, and the one remaining functional gap — the cli-tools config-writer that edits real `~/.{tool}/config.toml` files — still runs on Node because Rust only stores a snapshot. Phase 4 closes the migration: strict TypeScript everywhere in the surviving frontend, the Node backend deleted, the cli-tools config-writer ported to Rust so nothing frontend-facing depends on Node routes, and the vestigial Askama/htmx assets (left over from the original HTMX plan, abandoned for Stack A1) removed. After Phase 4, `docker compose up` runs exactly two services — the Next.js+TS frontend and the Rust backend — with zero Node backend code remaining.

## What Changes

- Convert all remaining frontend JS/JSX to strict TypeScript: ~72 `src/shared/**` files (components, hooks, utils, constants, services), ~40 remaining `src/app/**` non-api pages/layouts, and `src/i18n/**` (3 files). `npx tsc --noEmit` becomes a hard 0-error gate repo-wide.
- Port the full Node cli-tools config-writer logic into Rust `cli_tools.rs`: each tool's route (codex `~/.codex/config.toml`, claude settings, cowork MCP registry, etc.) parses → modifies → writes the real on-disk tool config so the Rust `/api/cli-tools/{tool}` endpoint fully replaces Node's `/api/cli-tools/{tool}-settings`. Then switch the TS cli-tools components from the Node `-settings` paths to the Rust `/api/cli-tools/{tool}` paths.
- **BREAKING (internal)**: Delete the entire Node backend — `src/app/api/**` (~186 route files), `src/lib/**` (~135 modules), `src/sse/**` (~23 proxy handlers), `src/mitm/**` (17), `src/store/**` (7), and root backend files (`src/proxy.js`, `src/dashboardGuard.js`, `src/consoleLogBuffer.js`, `src/localDb.js`, etc.) — replaced wholesale by the Rust backend. (External `/api/*` and `/v1/*` behavior is unchanged; this is an internal architecture removal.)
- Remove vestigial Askama + htmx/alpine assets from `derouter-rs/`: `templates/` directory, `static/` directory, `build.rs` rerun-if-changed=templates line, `askama` Cargo dependency (if unused after template removal), and the `COPY templates/`/`COPY static/` lines in the Rust Dockerfile.
- Finalize `docker-compose.yml` as a clean 2-service setup (Next.js frontend + Rust backend, shared SQLite volume); verify `NEXT_PUBLIC_API_URL` points to the Rust service and no Node-backend env hints remain.
- Keep `src/instrumentation.js` (or convert to TS) if the Next.js server runtime requires it; verify each kept root file is actually imported by the surviving frontend before deleting.

## Capabilities

### New Capabilities

(None — no new behavior; Phase 4 is completion/removal of existing capabilities.)

### Modified Capabilities

- `ts-frontend`: The strict-TypeScript requirement tightens from "TS scaffold + converted dashboard pages" (Phases 1-3, per-area) to a hard repo-wide gate: zero unconverted `.js`/`.jsx` files in the surviving frontend, `npx tsc --noEmit` 0 errors across the whole `src/` tree, and shared components/hooks/utils fully typed so converted pages import no untyped modules.
- `rust-json-api`: The Rust backend becomes the sole backend. The requirement extends from "Rust serves admin + proxy alongside Node fallback" (Phases 1-3) to "Rust serves ALL `/api/*` and `/v1/*` with no Node backend remaining." The Node admin/proxy code is deleted, so the Node fallback path is gone.
- `cli-tools-management`: The cli-tools config-writer requirement is satisfied by Rust, replacing the Phase-3 snapshot-only behavior. Rust `/api/cli-tools/{tool}` now reads, validates, writes, and resets the real per-tool configuration files (`~/.{tool}/config.toml` / `auth.json` / settings), matching the Node `-settings` routes' behavior so the frontend can call Rust exclusively.

## Impact

- **Frontend code** (`src/shared/**`, remaining `src/app/**`, `src/i18n/**`): ~112 JS files converted to strict TSX/TS; behavior unchanged, types added, raw `fetch` to Node routes replaced with the typed `apiClient` where applicable (especially cli-tools components switching to Rust paths).
- **Backend code deleted** (~368 files): `src/app/api/**`, `src/lib/**`, `src/sse/**`, `src/mitm/**`, `src/store/**`, and root Node backend files. Deletion happens AFTER the frontend tsc gate is green and the cli-tools writer is ported, so no frontend import is orphaned.
- **Rust backend** (`derouter-rs/`): `cli_tools.rs` gains the full config-writer per tool; Askama templates/static removed; `Cargo.toml` + `build.rs` + `Dockerfile` cleaned of `askama`/htmx/alpine.
- **Docker** (`docker-compose.yml`): finalized 2-service (Next.js + Rust); both services build and start; shared SQLite volume; Rust binds `0.0.0.0`.
- **Dependencies**: `askama` removed from `derouter-rs/Cargo.toml` if no longer used; no new Rust deps (TOML read/write for cli-tools uses existing deps or a `toml` crate if needed — design decision).
- **No external behavior change**: proxy `/v1/*` and admin `/api/*` responses are identical to Phase 3 (Rust already served them; Node is just removed). SQLite schema unchanged, DB file reused.
- **Security invariants carry forward**: key masking `****`/`sk-…****last4`, `.env` untracked, auth 401 JSON, CORS credentials never `Any`, settings secret-stripping computed before stripping, JSON errors only.
