# ts-frontend Specification

## Purpose

The Next.js frontend is converted to strict TypeScript with a typed API client that calls the Rust JSON backend, proving the pattern on the login + core admin pages.
## Requirements
### Requirement: TypeScript scaffold

The frontend MUST have a strict `tsconfig.json` (with the `@/*` path alias matching the existing JS imports), `typescript` and `@types/*` MUST be installed, and `tsc --noEmit` MUST be a CI gate.

#### Scenario: type-check gate

- **WHEN** `npx tsc --noEmit` runs against the repo
- **THEN** it reports 0 errors for the converted files (login, layout, providers, keys, the 10 converted components, api client, types)

### Requirement: typed API client

A typed fetch helper MUST send JSON requests to the Rust backend with cookies, using a base URL from `NEXT_PUBLIC_API_URL`.

#### Scenario: credentialed JSON call

- **WHEN** `apiGet<T>('/api/providers')` is called
- **THEN** it issues `GET {NEXT_PUBLIC_API_URL}/api/providers` with `credentials: 'include'` and `Accept: application/json`, and returns parsed JSON typed `T` on 2xx, or throws/returns an `{error}` on non-2xx
- **WHEN** the env is unset
- **THEN** the base URL defaults to `http://localhost:20128`

### Requirement: converted pages call the Rust API

The dashboard pages (login, dashboard layout, providers, keys, plus the Phase 2 pages: proxy-pools, combos, groups, pricing, usage tabs + components, endpoint, quota, profile, ProviderLimits) MUST fetch data via the typed API client instead of internal Next.js `fetch('/api/...')` calls.

#### Scenario: providers page data source

- **WHEN** the provider management page loads an authenticated session
- **THEN** it calls `apiGet<ProviderConnection[]>('/api/providers')` against the Rust origin and renders connections from that response (not from a Next.js internal API route)

#### Scenario: proxy-pools page data source
- **WHEN** the proxy-pools management page loads an authenticated session
- **THEN** it calls `apiGet<ProxyPool[]>('/api/proxy-pools')` against the Rust origin and renders pools from that response

#### Scenario: usage tabs data source
- **WHEN** the usage dashboard page loads an authenticated session
- **THEN** its Overview/Keys/Details tabs call `apiGet('/api/usage/stats')`, `/api/usage/keys`, `/api/usage/request-details` against the Rust origin

### Requirement: shared components are typed

The shared components converted across Phase 1, Phase 2, and Phase 3 MUST accept typed props (no `any` for component props), including any shared component imported by the Phase 3 pages (charts, drawers, tool cards, SSE-aware hooks).

#### Scenario: Button typed props

- **WHEN** a `<Button>` is used with props
- **THEN** TypeScript enforces the prop shape (variant, size, onClick, disabled, children) at compile time, and a wrong prop type is a `tsc` error

#### Scenario: usage component typed props

- **WHEN** a usage-tab component (e.g. KeyUsageTable, RequestDetailsTab, UsageChart) receives props
- **THEN** TypeScript enforces the prop shape at compile time, and a wrong prop type is a `tsc` error

#### Scenario: tool card typed props

- **WHEN** a per-tool card component (e.g. ClaudeToolCard, CodexToolCard) receives props
- **THEN** TypeScript enforces the prop shape at compile time, and a wrong prop type is a `tsc` error

### Requirement: Phase 2 dashboard pages converted to TypeScript

The proxy-pools, combos, groups, pricing, usage (page + components), endpoint, quota, and profile dashboard pages, plus their client components and the ProviderLimits subtree, MUST be converted from `.js` to `.tsx` with typed props and MUST call the Rust JSON API via the typed apiClient. The remaining `tsc --noEmit` MUST report 0 errors across the converted set.

#### Scenario: type-check covers Phase 2 pages
- **WHEN** `npx tsc --noEmit` runs against the repo
- **THEN** it reports 0 errors for the Phase 1 + Phase 2 converted files (login, layout, providers, keys, proxy-pools, combos, groups, pricing, usage, endpoint, quota, profile, and their components)

#### Scenario: usage page fetches from Rust
- **WHEN** the converted usage page mounts an authenticated session
- **THEN** it issues typed apiClient calls to `/api/usage/stats`, `/api/usage/keys`, `/api/usage/request-details`, and `/api/usage/stream` against the Rust origin

### Requirement: Phase 3 dashboard pages converted to TypeScript

The cli-tools (page + `[toolId]` detail + the per-tool card components + cliEndpoint presets/match), mcp, media-providers (`[kind]`, `web`, `[kind]/[id]`, `[kind]/combo/[id]` + example cards), tunnel, pxpipe, translator, headroom, basic-chat, token-saver, and skills dashboard pages, plus their client components, MUST be converted from `.js` to `.tsx` with typed props and MUST call the Rust JSON API via the typed apiClient (and SSE where applicable for mcp/translator/headroom). The remaining `tsc --noEmit` MUST report 0 errors across the Phase 1 + 2 + 3 converted set.

#### Scenario: type-check covers Phase 3 pages
- **WHEN** `npx tsc --noEmit` runs against the repo
- **THEN** it reports 0 errors for the Phase 1 + 2 + 3 converted files (login, layout, providers, keys, proxy-pools, combos, groups, pricing, usage, endpoint, quota, profile, cli-tools, mcp, media-providers, tunnel, pxpipe, translator, headroom, basic-chat, token-saver, skills, and their components)

#### Scenario: cli-tools page fetches from Rust
- **WHEN** the converted cli-tools page mounts an authenticated session
- **THEN** it issues typed apiClient calls to `/api/cli-tools/all-statuses` and the per-tool settings endpoints against the Rust origin

#### Scenario: mcp page connects to Rust SSE
- **WHEN** the converted mcp page opens a plugin
- **THEN** it connects to `/api/mcp/<plugin>/sse` on the Rust origin with credentials

