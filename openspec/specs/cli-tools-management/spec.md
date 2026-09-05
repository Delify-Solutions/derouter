# cli-tools-management Specification

## Purpose
The cli-tools admin routes (per-tool settings, all-statuses, mitm aliases) and the CLI tools dashboard page that lets an admin configure and copy per-IDE endpoints for the supported CLI tools (claude/codex/copilot/cline/opencode/jcode/kilo/openclaw/hermes/grok-build/deepseek-tui/droid/devin/antigravity/cowork).
## Requirements
### Requirement: CLI tools routes over JSON

The Rust backend MUST serve the cli-tools routes as JSON, all requiring auth (401 JSON without cookie). `GET /api/cli-tools/all-statuses` MUST return the install status of every supported tool. `GET/POST /api/cli-tools/<tool>-settings` MUST return/update that tool's settings (endpoint, apiKey, baseUrl presets). `GET /api/cli-tools/antigravity-mitm` and `/antigravity-mitm/alias` MUST manage the antigravity MITM alias. `GET /api/cli-tools/cowork-mcp-registry` and `/cowork-mcp-tools` MUST return the cowork MCP registry and tools.

#### Scenario: all-statuses
- **WHEN** `GET /api/cli-tools/all-statuses` is called authenticated
- **THEN** the response lists each tool with its install/configured status

#### Scenario: update tool settings
- **WHEN** `POST /api/cli-tools/claude-settings` with a settings body is called authenticated
- **THEN** the settings are persisted and the response confirms

### Requirement: CLI tools page in TypeScript

The cli-tools dashboard page, the per-tool card components (DefaultToolCard, ClaudeToolCard, CodexToolCard, etc.), the `[toolId]` detail page + ToolDetailClient, and the shared cliEndpoint components MUST be converted to `.tsx` with typed props, calling the Rust JSON API via the typed apiClient.

#### Scenario: cli-tools page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the cli-tools page + components report 0 errors and fetch tool data from Rust

