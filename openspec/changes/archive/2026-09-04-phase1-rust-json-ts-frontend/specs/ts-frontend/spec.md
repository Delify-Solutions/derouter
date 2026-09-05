## Purpose

The Next.js frontend is converted to strict TypeScript with a typed API client that calls the Rust JSON backend, proving the pattern on the login + core admin pages.

## ADDED Requirements

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

The proof-of-pattern pages (login, dashboard layout, providers, keys) MUST fetch data via the typed API client instead of internal Next.js `fetch('/api/...')` calls.

#### Scenario: providers page data source
- **WHEN** the provider management page loads an authenticated session
- **THEN** it calls `apiGet<ProviderConnection[]>('/api/providers')` against the Rust origin and renders connections from that response (not from a Next.js internal API route)

### Requirement: shared components are typed

The 10 shared components converted in this phase MUST accept typed props (no `any` for component props).

#### Scenario: Button typed props
- **WHEN** a `<Button>` is used with props
- **THEN** TypeScript enforces the prop shape (variant, size, onClick, disabled, children) at compile time, and a wrong prop type is a `tsc` error
