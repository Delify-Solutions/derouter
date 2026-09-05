## ADDED Requirements

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

## MODIFIED Requirements

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
