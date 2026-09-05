## MODIFIED Requirements

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

The shared components converted across Phase 1 and Phase 2 MUST accept typed props (no `any` for component props), including the components imported by the Phase 2 pages (e.g., charts, tables, drawer, segmented-control variants used by usage/proxy-pools/quota).

#### Scenario: Button typed props

- **WHEN** a `<Button>` is used with props
- **THEN** TypeScript enforces the prop shape (variant, size, onClick, disabled, children) at compile time, and a wrong prop type is a `tsc` error

#### Scenario: usage component typed props
- **WHEN** a usage-tab component (e.g. KeyUsageTable, RequestDetailsTab, UsageChart) receives props
- **THEN** TypeScript enforces the prop shape at compile time, and a wrong prop type is a `tsc` error

## ADDED Requirements

### Requirement: Phase 2 dashboard pages converted to TypeScript

The proxy-pools, combos, groups, pricing, usage (page + components), endpoint, quota, and profile dashboard pages, plus their client components and the ProviderLimits subtree, MUST be converted from `.js` to `.tsx` with typed props and MUST call the Rust JSON API via the typed apiClient. The remaining `tsc --noEmit` MUST report 0 errors across the converted set.

#### Scenario: type-check covers Phase 2 pages
- **WHEN** `npx tsc --noEmit` runs against the repo
- **THEN** it reports 0 errors for the Phase 1 + Phase 2 converted files (login, layout, providers, keys, proxy-pools, combos, groups, pricing, usage, endpoint, quota, profile, and their components)

#### Scenario: usage page fetches from Rust
- **WHEN** the converted usage page mounts an authenticated session
- **THEN** it issues typed apiClient calls to `/api/usage/stats`, `/api/usage/keys`, `/api/usage/request-details`, and `/api/usage/stream` against the Rust origin
