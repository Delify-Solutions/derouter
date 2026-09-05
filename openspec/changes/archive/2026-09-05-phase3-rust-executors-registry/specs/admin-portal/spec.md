## MODIFIED Requirements

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
