## ADDED Requirements

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
