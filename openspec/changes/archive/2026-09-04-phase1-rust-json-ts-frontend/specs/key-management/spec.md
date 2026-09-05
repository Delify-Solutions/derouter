## MODIFIED Requirements

### Requirement: API keys CRUD over JSON

API key management MUST be served as JSON by the Rust backend, with the same fields and validation as the Node original.

#### Scenario: list keys
- **WHEN** `GET /api/keys` is called with a valid auth cookie
- **THEN** it returns `{"keys":[{id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowCostUsd, ...}]}`

#### Scenario: create key with limits
- **WHEN** `POST /api/keys` with body `{"name":"...", "groupId":"...?", "rpm":<n>?, "tpm":<n>?, "budgetUsd":<n>?, "resetWindow":"..."?, "expiresAt":"..."?, "allowedModels":[...]?}`
- **THEN** a new key is created with a server-generated key string (`sk-...`) and machineId from `getConsistentMachineId`, and the response is 201 with the created key (including the full `key` value once)
- **WHEN** `name` is missing
- **THEN** the response is 400 `{"error":"Name is required"}`

#### Scenario: update and delete
- **WHEN** `PUT /api/keys/{id}` with partial fields
- **THEN** the key is updated and the updated row returned
- **WHEN** `DELETE /api/keys/{id}`
- **THEN** the key is removed and an empty success response returned

#### Scenario: key access requires auth
- **WHEN** any `/api/keys` route is called without a valid `auth_token`
- **THEN** the response is 401 JSON `{"error":"Unauthorized"}`
