# provider-node-management Specification

## Purpose
Manages provider nodes (OpenAI-compatible, Anthropic-compatible, and custom-embedding prefixes) that supply baseUrl and identity for compatible provider connections, with CRUD and config validation.
## Requirements
### Requirement: Provider node CRUD over JSON

The Rust backend MUST serve provider node management as JSON. `GET /api/provider-nodes` MUST return `{"nodes":[...]}`. `POST /api/provider-nodes` MUST require a non-empty `name`, accept `prefix`, `apiType`, `type`, and `baseUrl`, and MUST apply the default `baseUrl` when the node's prefix is `OPENAI_COMPATIBLE_PREFIX`, `ANTHROPIC_COMPATIBLE_PREFIX`, or `CUSTOM_EMBEDDING_PREFIX` and no `baseUrl` is supplied. `PUT/DELETE /api/provider-nodes/{id}` MUST update/remove the node; `DELETE` MUST NOT orphan connections that referenced it (they keep their stored baseUrl). All routes MUST return 401 JSON without a valid `auth_token` cookie.

#### Scenario: create with compatible prefix default
- **WHEN** `POST /api/provider-nodes` with `{"name":"my-openai","prefix":"openai-compat"}` and no `baseUrl`
- **THEN** the created node has `baseUrl` set to the OpenAI-compatible default (`https://api.openai.com/v1`)

#### Scenario: create missing name
- **WHEN** `POST /api/provider-nodes` with `{"prefix":"openai-compat"}`
- **THEN** the response is 400 `{"error":"Name is required"}`

#### Scenario: list
- **WHEN** `GET /api/provider-nodes` is called authenticated
- **THEN** the response is 200 `{"nodes":[{id, name, prefix, apiType, baseUrl, type, ...}]}`

### Requirement: Provider node validation

`POST /api/provider-nodes/validate` MUST check a candidate node config (without persisting) and return `{ok:bool, errors?:string[]}` indicating whether the prefix is recognized and the baseUrl is a well-formed URL.

#### Scenario: valid node config
- **WHEN** `POST /api/provider-nodes/validate` with `{"name":"x","prefix":"openai-compat","baseUrl":"https://api.openai.com/v1"}`
- **THEN** the response is 200 `{ok:true}`

#### Scenario: unrecognized prefix
- **WHEN** `POST /api/provider-nodes/validate` with `{"prefix":"unknown-prefix"}`
- **THEN** the response is 200 `{ok:false, errors:["Unrecognized prefix"]}`

