## Purpose

The MCP (Model Context Protocol) plugin marketplace: per-plugin SSE message streaming and the plugin marketplace UI. Plugins are identified by `[plugin]` path segment.

## ADDED Requirements

### Requirement: MCP plugin routes over JSON/SSE

The Rust backend MUST serve `GET /api/mcp/{plugin}/sse` (the plugin's SSE endpoint, long-lived) and `POST /api/mcp/{plugin}/message` (send a message to the plugin). Both MUST require auth (401 JSON without cookie). The SSE endpoint MUST stay open until the client disconnects, forwarding plugin events; the message endpoint MUST forward the body to the plugin and return its response.

#### Scenario: plugin SSE stream
- **WHEN** a client connects to `/api/mcp/<plugin>/sse` authenticated
- **THEN** the server opens the plugin's SSE stream and forwards events until disconnect

### Requirement: MCP marketplace page in TypeScript

The MCP marketplace page (and any components) MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient.

#### Scenario: mcp page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the mcp page reports 0 errors and lists plugins from Rust
