## MODIFIED Requirements

### Requirement: TypeScript scaffold

The frontend MUST have a strict `tsconfig.json` (with the `@/*` path alias matching the existing JS imports), `typescript` and `@types/*` MUST be installed, and `tsc --noEmit` MUST be a hard CI gate over the entire `src/` tree. Every surviving frontend file MUST be TypeScript (`.ts`/`.tsx`); no `.js`/`.jsx` frontend files MAY remain (excluding vendored/generated files explicitly allowlisted in `tsconfig`).

#### Scenario: type-check gate

- **WHEN** `npx tsc --noEmit` runs against the repo
- **THEN** it reports 0 errors across the entire `src/` tree (login, layout, providers, keys, the converted components, api client, types, ALL shared components/hooks/utils/constants/services, ALL remaining dashboard pages, i18n) — no untyped frontend module is left to silence the gate

#### Scenario: no surviving frontend JS

- **WHEN** the repo is searched for `src/**/*.js` and `src/**/*.jsx` (excluding generated/vendored globs and any file that Next.js server runtime requires and is explicitly documented as kept)
- **THEN** no frontend page, component, hook, util, or constant file remains as `.js`/`.jsx`; all have been converted to `.ts`/`.tsx`

### Requirement: converted pages call the Rust API

All dashboard pages, shared components, hooks, utils, and services MUST fetch data via the typed API client (`apiGet`/`apiPost`/`apiPut`/`apiDelete`/`apiStream`) against the Rust backend instead of internal Next.js `fetch('/api/...')` calls to the (now-deleted) Node routes. The cli-tools components MUST call the Rust `/api/cli-tools/{tool}` paths (the Node `-settings` paths are deleted).

#### Scenario: providers page data source

- **WHEN** the provider management page loads an authenticated session
- **THEN** it calls `apiGet<ProviderConnection[]>('/api/providers')` against the Rust origin and renders connections from that response (not from a Next.js internal API route)

#### Scenario: proxy-pools page data source
- **WHEN** the proxy-pools management page loads an authenticated session
- **THEN** it calls `apiGet<ProxyPool[]>('/api/proxy-pools')` against the Rust origin and renders pools from that response

#### Scenario: usage tabs data source
- **WHEN** the usage dashboard page loads an authenticated session
- **THEN** its Overview/Keys/Details tabs call `apiGet('/api/usage/stats')`, `/api/usage/keys`, `/api/usage/request-details` against the Rust origin

#### Scenario: cli-tools page calls Rust config-writer
- **WHEN** the converted cli-tools page applies settings for a tool
- **THEN** it issues a typed apiClient call to the Rust `/api/cli-tools/{tool}` endpoint (POST), and the Rust backend writes the real on-disk tool config (not the Node `/api/cli-tools/{tool}-settings` route, which is deleted)

## ADDED Requirements

### Requirement: remaining frontend modules converted to strict TypeScript

All previously-unconverted frontend modules MUST be converted to strict TypeScript with typed props, typed state, typed event handlers, and no `any` for component prop shapes: the ~72 `src/shared/**` files (components, hooks, utils, constants, services), the ~40 remaining `src/app/**` non-api pages/layouts, and `src/i18n/**`. The conversions MUST NOT change runtime behavior (only add types and, where a raw `fetch` targeted a deleted Node route, switch to the typed apiClient against the Rust origin).

#### Scenario: shared components type-check

- **WHEN** `npx tsc --noEmit` runs after the shared-module conversions
- **THEN** every `src/shared/**` component, hook, util, and constant reports 0 type errors, and any exported function/component has explicit or inferred types (no implicit `any`).

#### Scenario: remaining pages type-check

- **WHEN** `npx tsc --noEmit` runs after the remaining-page conversions
- **THEN** every remaining `src/app/**` non-api page/layout and `src/i18n/**` file reports 0 type errors.

#### Scenario: no frontend imports deleted Node backend

- **WHEN** the surviving frontend is searched for imports from `@/lib/`, `@/sse/`, `@/store/`, or `@/mitm/` (the deleted Node backend modules)
- **THEN** no such import remains; any prior dependency was removed (the Rust API + typed apiClient replace that logic).
