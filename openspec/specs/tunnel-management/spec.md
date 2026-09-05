# tunnel-management Specification

## Purpose
Tunnel management routes (enable/disable/status/install for Tailscale and Cloudflare/Deno/Vercel-based tunnels) and the tunnel dashboard UI.
## Requirements
### Requirement: Tunnel routes over JSON

The Rust backend MUST serve the tunnel routes as JSON, all requiring auth (401 JSON without cookie): `GET /api/tunnel/status`, `POST /api/tunnel/enable`, `POST /api/tunnel/disable`, `GET /api/tunnel/tailscale-check`, `POST /api/tunnel/tailscale-enable`, `/tailscale-disable`, `/tailscale-install`. Each MUST perform the platform action (or check install/state) and return `{ok, status, url?, error?}`; platform errors MUST be returned as JSON, not 500 HTML.

#### Scenario: enable tunnel
- **WHEN** `POST /api/tunnel/enable` is called authenticated
- **THEN** the tunnel is enabled and the response includes the tunnel URL

#### Scenario: tailscale install check
- **WHEN** `GET /api/tunnel/tailscale-check` is called authenticated
- **THEN** the response reports whether Tailscale is installed and ready

### Requirement: Tunnel page in TypeScript

The tunnel dashboard page MUST be converted to `.tsx` with typed props, calling Rust via the typed apiClient.

#### Scenario: tunnel page type-checks
- **WHEN** `npx tsc --noEmit` runs
- **THEN** the tunnel page reports 0 errors

