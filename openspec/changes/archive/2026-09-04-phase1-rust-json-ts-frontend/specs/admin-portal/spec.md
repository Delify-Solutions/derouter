## MODIFIED Requirements

### Requirement: providers CRUD over JSON with Node-parity validation

Provider connection management MUST be served as JSON by the Rust backend with the same validation the Node route performs.

#### Scenario: list providers strips secrets
- **WHEN** `GET /api/providers` is called authenticated
- **THEN** it returns `{"connections":[...]}` where each connection has `apiKey`, `accessToken`, `refreshToken`, `idToken` removed, and the `name` is enriched for compatible providers (using nodeName from providerNodes when the connection has none)

#### Scenario: create provider full validation
- **WHEN** `POST /api/providers` with a body
- **THEN** the server validates: `provider` is normalized via `normalizeProviderId` and is a valid provider (in APIKEY_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, supportsApiKeyMode, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, or isCustomEmbeddingProvider); `apiKey` (or cookie value for web-cookie providers) is required unless provider is `ollama-local`; `connectionProxyEnabled` requires a `connectionProxyUrl`; `proxyPoolId` is resolved (null when absent/`__none__`, must exist otherwise)
- **AND** on success returns 201 with the created connection (secrets stripped); on validation failure returns 400 `{"error":"<reason>"}`

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
