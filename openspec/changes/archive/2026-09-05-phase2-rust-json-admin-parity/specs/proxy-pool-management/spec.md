## Purpose

Manages proxy pools used by provider connections for outbound proxying, including CRUD, connectivity testing, and one-click deployment to Cloudflare/Deno/Vercel edge platforms.

## ADDED Requirements

### Requirement: Proxy pool CRUD over JSON

The Rust backend MUST serve proxy pool management as JSON. `GET /api/proxy-pools` MUST return `{"proxyPools":[...]}` optionally filtered by `isActive` and enriched with `includeUsage=true` connection counts. `POST /api/proxy-pools` MUST validate `name` (required, non-empty), `proxyUrl` (required, non-empty), and `type` (one of `http`, `vercel`, `cloudflare`, `deno`; defaults to `http`); on a missing field it MUST return 400 `{"error":"<reason>"}`. `PUT /api/keys/{id}` MUST update; `DELETE /api/proxy-pools/{id}` MUST remove (and clear the `proxyPoolId` reference on connections that referenced it). All routes MUST return 401 JSON without a valid `auth_token` cookie.

#### Scenario: list with usage counts
- **WHEN** `GET /api/proxy-pools?includeUsage=true` is called authenticated
- **THEN** each pool includes a `usageCount` (number of connections whose `providerSpecificData.proxyPoolId` equals the pool id)

#### Scenario: create with invalid type
- **WHEN** `POST /api/proxy-pools` with `{"name":"p","proxyUrl":"http://x","type":"socks"}`
- **THEN** the response is 400 `{"error":"Invalid proxy type"}`

#### Scenario: create missing name
- **WHEN** `POST /api/proxy-pools` with `{"proxyUrl":"http://x"}`
- **THEN** the response is 400 `{"error":"Name is required"}`

#### Scenario: delete clears references
- **WHEN** `DELETE /api/proxy-pools/{id}` succeeds for a pool referenced by connections
- **THEN** those connections have their `proxyPoolId` set to null and the response is an empty success

### Requirement: Proxy pool connectivity test

`POST /api/proxy-pools/{id}/test` MUST attempt a connection through the pool's `proxyUrl` to a known endpoint and return `{ok, latencyMs, status, error?}` as JSON. It MUST return 404 for an unknown pool id.

#### Scenario: test reachable pool
- **WHEN** the pool's proxy is reachable
- **THEN** the response is 200 `{ok:true, latencyMs:<n>, status:<http code>}`

#### Scenario: test unknown pool
- **WHEN** the pool id does not exist
- **THEN** the response is 404 `{"error":"Proxy pool not found"}`

### Requirement: Edge platform deployment

`POST /api/proxy-pools/cloudflare-deploy`, `POST /api/proxy-pools/deno-deploy`, and `POST /api/proxy-pools/vercel-deploy` MUST deploy the pool configuration to the respective platform and return `{ok, url?, error?, logs?}`. They MUST validate platform credentials before calling the external deploy API and MUST return the platform error as JSON on failure (not 500 with HTML).

#### Scenario: cloudflare deploy success
- **WHEN** `POST /api/proxy-pools/cloudflare-deploy` is called with valid credentials in settings
- **THEN** the response is 200 `{ok:true, url:"https://...workers.dev"}`

#### Scenario: deno deploy missing token
- **WHEN** `POST /api/proxy-pools/deno-deploy` is called and no Deno deploy token is configured
- **THEN** the response is 400 `{"error":"Deno deploy token not configured"}`
