## MODIFIED Requirements

### Requirement: CLI tools routes over JSON

The Rust backend MUST serve the cli-tools routes as JSON, all requiring auth (401 JSON without cookie). `GET /api/cli-tools/all-statuses` MUST return the install status of every supported tool. `GET/POST/DELETE /api/cli-tools/{tool}` MUST read, write, and reset that tool's REAL on-disk configuration (the same files the tool's CLI reads — e.g. `~/.codex/config.toml`, `~/.claude/settings.json`/`~/.claude.json`, the cowork MCP registry, etc.), parsing and modifying the native format for each tool so that "Apply" produces a working tool config without Node. `GET /api/cli-tools/antigravity-mitm` and `/antigravity-mitm/alias` MUST manage the antigravity MITM alias. `GET /api/cli-tools/cowork-mcp-registry` and `/cowork-mcp-tools` MUST return the cowork MCP registry and tools. The Node `/api/cli-tools/{tool}-settings` routes MUST be removed; the frontend calls Rust `/api/cli-tools/{tool}` exclusively.

#### Scenario: all-statuses
- **WHEN** `GET /api/cli-tools/all-statuses` is called authenticated
- **THEN** the response lists each tool with its install/configured status

#### Scenario: update tool settings writes real config
- **WHEN** `POST /api/cli-tools/codex` is called authenticated with a settings body (baseUrl, apiKey, model, subagentModel)
- **THEN** the Rust backend parses `~/.codex/config.toml`, sets `model`, `model_provider`, the `[model_providers.derouter]` section (name, base_url, wire_api, `[http_headers] Authorization`), and `default_subagent_model`, writes the file back, and returns a success JSON; the file on disk is a valid Codex config the CLI can consume

#### Scenario: reset tool settings
- **WHEN** `DELETE /api/cli-tools/codex` is called authenticated
- **THEN** the Rust backend removes the derouter-specific keys/sections from `~/.codex/config.toml` (or resets them to defaults) and returns a success JSON

#### Scenario: read tool settings
- **WHEN** `GET /api/cli-tools/codex` is called authenticated
- **THEN** the response reports `installed` (CLI binary presence), the parsed current config (model, base_url), `hasderouter` (whether the config points to derouter), and the settings path — matching the shape the Node `-settings` route returned, so the converted TS components render unchanged

#### Scenario: masked keys in read response
- **WHEN** `GET /api/cli-tools/{tool}` or `all-statuses` returns a config that contains an API key or auth token
- **THEN** the key value in the JSON response is masked (`****`), never the raw key

### Requirement: CLI tools page in TypeScript

The cli-tools dashboard page, the per-tool card components (DefaultToolCard, ClaudeToolCard, CodexToolCard, etc.), the `[toolId]` detail page + ToolDetailClient, and the shared cliEndpoint components MUST be converted to `.tsx` with typed props, calling the Rust JSON API via the typed apiClient at the Rust `/api/cli-tools/{tool}` paths (not the deleted Node `-settings` paths).

#### Scenario: cli-tools page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the cli-tools page + components report 0 errors and fetch tool data from Rust `/api/cli-tools/{tool}` endpoints

#### Scenario: cli-tools page uses Rust paths
- **WHEN** the cli-tools components issue settings read/write/reset calls
- **THEN** they call `/api/cli-tools/{tool}` (GET/POST/DELETE) against the Rust origin via the typed apiClient, and no call to a Node `/api/cli-tools/{tool}-settings` path remains
