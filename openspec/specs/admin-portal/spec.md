# admin-portal Specification

## Purpose
The admin UI for managing providers, combos, keys, groups, and pricing. The Rust backend serves admin CRUD as JSON over HTTP; the Next.js + TypeScript frontend consumes those JSON endpoints. The admin area is access-controlled (see `admin-auth`): requests without a valid admin session return 401 JSON for `/api/*` routes.
## Requirements
### Requirement: Server-rendered admin pages

The system SHALL serve admin pages (providers, combos, keys, groups, pricing, endpoint) as full HTML documents rendered on the server (Next.js), with navigation and a shared layout. The admin area MUST be access-controlled (see `admin-auth`): requests without a valid admin session return 401 JSON for `/api/*` routes.

#### Scenario: Visit dashboard without session

- **WHEN** an unauthenticated browser visits `/dashboard`
- **THEN** the server redirects to `/login`

#### Scenario: Visit dashboard with session

- **WHEN** an authenticated admin visits `/dashboard`
- **THEN** the server renders the dashboard overview page in the shared layout

### Requirement: providers CRUD over JSON with Node-parity validation

Provider connection management MUST be served as JSON by the Rust backend with the same validation the Node route performs, sourced from the full 123-entry provider registry (replacing the Phase 2 minimal capabilities map). `GET /api/providers` MUST return `{"connections":[...]}` with secrets stripped and names enriched using registry display names when the connection has none. Provider validation (`normalizeProviderId`, APIKEY/FREE_TIER/WEB_COOKIE/compatible/embedding classification, `supportsApiKeyMode`) MUST be derived from the registry's `category` and `serviceKinds`. `/api/providers/{id}/models`, `/api/providers/suggested-models`, and `/api/providers/kilo/free-models` MUST source model lists from the registry's `models` field for the relevant provider.

#### Scenario: list providers strips secrets

- **WHEN** `GET /api/providers` is called authenticated
- **THEN** it returns `{"connections":[...]}` where each connection has `apiKey`, `accessToken`, `refreshToken`, `idToken` removed, and the `name` is enriched using registry display names when the connection has none

#### Scenario: create provider full validation

- **WHEN** `POST /api/providers` with a body
- **THEN** the server validates: `provider` is normalized via `normalizeProviderId` and is a valid provider (classified via the registry's `category` and `serviceKinds` — APIKEY, FREE_TIER, WEB_COOKIE, compatible, embedding, or `supportsApiKeyMode`); `apiKey` (or cookie value for web-cookie providers) is required unless provider is `ollama-local`; `connectionProxyEnabled` requires a `connectionProxyUrl`; `proxyPoolId` is resolved (null when absent/`__none__`, must exist otherwise)
- **AND** on success returns 201 with the created connection (secrets stripped); on validation failure returns 400 `{"error":"<reason>"}`

#### Scenario: connection models from registry

- **WHEN** `GET /api/providers/{id}/models` is called authenticated for a provider with a registry entry
- **THEN** the response includes the registry's `models` list for that provider (id + name) plus any connection-stored custom models

#### Scenario: update and delete

- **WHEN** `PUT /api/providers/{id}` / `DELETE /api/providers/{id}`
- **THEN** the connection is updated / removed and the response confirms; secrets are never returned in the response

### Requirement: combos, groups, pricing CRUD over JSON

Combos, key groups, and per-model pricing MUST be managed as JSON by the Rust backend with the same fields and validation as the Node original.

#### Scenario: combos

- **WHEN** `GET/POST /api/combos`, `PUT/DELETE /api/combos/{id}`
- **THEN** combos (name, kind, models array) are listed/created/updated/deleted as JSON; creating requires a name and a models array
- **WHEN** `POST /api/combos/{name}/test`
- **THEN** it pings the combo via an internal unrestricted key and returns `{ok, latencyMs, status, content, error?, note?}` (the assistant reply text in `content`)

#### Scenario: key groups

- **WHEN** `GET/POST /api/groups`, `PUT/DELETE /api/groups/{id}`
- **THEN** key groups (name, and group-level limits) are managed as JSON

#### Scenario: pricing

- **WHEN** `GET/POST /api/pricing`
- **THEN** per-model pricing is returned/updated as JSON; POST updates specific model prices

### Requirement: settings over JSON with secret stripping

Settings MUST be served as JSON by the Rust backend with secrets stripped, and password changes MUST verify the current password.

#### Scenario: GET settings

- **WHEN** `GET /api/settings` authenticated
- **THEN** it returns settings with `password`, `oidcClientSecret`, and `mitmSudoEncrypted` removed, plus `hasPassword:bool`

#### Scenario: PATCH settings with password change

- **WHEN** `PATCH /api/settings` with `{"password":"new"}` (and other safe fields)
- **THEN** if a password hash already exists, `currentPassword` must be present and must verify against it, else 400; the new password is hashed (argon2) and stored; other fields update
- **WHEN** PATCH omits `password`
- **THEN** other settings fields update without touching the password

### Requirement: Provider management

The system SHALL let an admin add Anthropic-compatible and OpenAI-compatible provider connections, set per-connection auth (OAuth token or API key), activate/deactivate, set priority, and delete. Each connection has a `provider`, `authType`, `name`, `email`, `priority`, `isActive`, and a `data` JSON holding credentials. Management is performed via the JSON CRUD endpoints (`/api/providers`).

#### Scenario: Add an OpenAI-compatible connection

- **WHEN** an admin adds a connection with provider `openai-compatible`, a base URL, and an API key via `POST /api/providers`
- **THEN** the connection is stored and becomes a fallback candidate for combos referencing `openai-compatible`

#### Scenario: Reorder by priority

- **WHEN** two connections exist for the same provider with priorities 1 and 2
- **THEN** fallback ordering tries priority 1 before priority 2

### Requirement: Combo management

The system SHALL let an admin create combos (a `name` mapped to an ordered `models` array of `providerName/modelId` strings), edit, delete, and test a combo via the JSON CRUD endpoints (`/api/combos`). "Testing a combo" means issuing a real proxied completion `{model: <combo.name>, messages:[{role:user, content:"hi"}]}` using an internal unrestricted key, then reporting status, latency, and the assistant's reply text.

#### Scenario: Create a combo

- **WHEN** an admin creates combo `mygpt` with `models = ["openai/gpt-4o","openai-compatible/glm-5.3:pre"]` via `POST /api/combos`
- **THEN** subsequent client requests to `/v1/chat/completions` with `model = "mygpt"` resolve to that fallback chain

#### Scenario: Test a combo succeeds

- **WHEN** an admin triggers a test via `POST /api/combos/{name}/test` on a combo whose first candidate is reachable
- **THEN** the response shows a success indicator, the latency in ms, and the assistant's reply text

#### Scenario: Test a combo fails

- **WHEN** an admin triggers a test on a combo whose candidates all error
- **THEN** the response shows a failure indicator and the error string, with no reply text

### Requirement: Group and pricing management

The system SHALL let an admin manage key groups (with default limits + `priceOverrides`) and per-model / per-combo pricing via the JSON CRUD endpoints (`/api/groups`, `/api/pricing`). Per-combo pricing overrides per-pool pricing for requests that name that combo.

#### Scenario: Set a group's default limits

- **WHEN** an admin edits group "free" and sets RPM 10, TPM 200, budget $1 via `PUT /api/groups/{id}`
- **THEN** keys in "free" with null per-key limits inherit those defaults

#### Scenario: Per-combo price overrides per-pool

- **WHEN** combo `mygpt` has a combo-level price of $0.001/1k output and the underlying provider's pool price is $0.002/1k output
- **THEN** usage for `mygpt` requests is costed at $0.001/1k output

### Requirement: Provider connection sub-routes over JSON

The Rust backend MUST serve provider-connection sub-routes as JSON, all requiring auth (401 JSON without cookie). `GET /api/providers/{id}/models` MUST return the models available on that connection. `POST /api/providers/{id}/test` MUST issue a minimal completion test to the connection and return `{ok, latencyMs, status, content?, error?}`. `POST /api/providers/{id}/test-models` MUST fetch the model list from the upstream provider and return it. `GET /api/providers/client` MUST return the client-facing config (base URL, advertised models). `GET /api/providers/kilo/free-models` MUST return the Kilo free-tier model list. `GET /api/providers/suggested-models` MUST return suggested models for a provider/connection. `POST /api/providers/test-batch` MUST accept a list of connection ids (or full connection configs) and return per-connection test results `[{id, ok, latencyMs, status, error?}]`. `POST /api/providers/validate` MUST validate a provider config (without persisting) and return `{ok, errors?}`.

#### Scenario: test a connection
- **WHEN** `POST /api/providers/{id}/test` is called authenticated for a live connection
- **THEN** the response is 200 `{ok:true, latencyMs:<n>, status:200, content:"..."}`

#### Scenario: batch test
- **WHEN** `POST /api/providers/test-batch` with `{"ids":["a","b"]}` is called authenticated
- **THEN** the response is 200 `[{id:"a", ok:true, ...}, {id:"b", ok:false, error:"..."}]`

#### Scenario: validate without persist
- **WHEN** `POST /api/providers/validate` with a connection config is called authenticated
- **THEN** the response is `{ok:bool, errors?:string[]}` and no row is created

#### Scenario: sub-route without cookie
- **WHEN** any provider sub-route under `/api/providers/*` is called without a valid `auth_token`
- **THEN** the response is 401 JSON `{"error":"Unauthorized"}`

### Requirement: Settings sub-routes over JSON

The Rust backend MUST serve settings sub-routes as JSON, all requiring auth. `POST /api/settings/database` with `{"action":"export"|"import"|"reset"}` MUST perform the database operation: `export` returns the full DB as a downloadable JSON object, `import` accepts a JSON object and restores rows (validating shape first), `reset` clears usage/request-details rows (NOT settings/keys/providers) and returns `{"success":true}`. `POST /api/settings/proxy-test` with `{"proxyUrl":"..."}` MUST test connectivity through the proxy and return `{ok, latencyMs, error?}`. `POST /api/settings/require-login` with `{"requireLogin":true|false}` MUST toggle the require-login mode and return the updated setting.

#### Scenario: database export
- **WHEN** `POST /api/settings/database` with `{"action":"export"}` is called authenticated
- **THEN** the response is the full database contents as JSON (all tables/rows)

#### Scenario: database reset
- **WHEN** `POST /api/settings/database` with `{"action":"reset"}` is called authenticated
- **THEN** usage and request-details rows are cleared, settings/keys/providers remain, and the response is `{"success":true}`

#### Scenario: database import invalid shape
- **WHEN** `POST /api/settings/database` with `{"action":"import","data":"not-an-object"}` is called
- **THEN** the response is 400 `{"error":"Invalid import data"}` and no rows are changed

#### Scenario: proxy test
- **WHEN** `POST /api/settings/proxy-test` with `{"proxyUrl":"http://proxy:3128"}` is called authenticated
- **THEN** the response is `{ok:bool, latencyMs:<n>, error?}`

#### Scenario: toggle require-login
- **WHEN** `POST /api/settings/require-login` with `{"requireLogin":true}` is called authenticated
- **THEN** the setting is updated and the response reflects the new value

### Requirement: Tags (static ollama model list) over JSON

`GET /api/tags` MUST return the static ollama model list (ported from `open-sse/config/ollamaModels.js` as a Rust constant array) as JSON `{"models":[...]}`. It MUST require auth.

#### Scenario: tags list
- **WHEN** `GET /api/tags` is called authenticated
- **THEN** the response is 200 `{"models":[{"name":"...", ...}, ...]}` matching the Node ollama model list verbatim

