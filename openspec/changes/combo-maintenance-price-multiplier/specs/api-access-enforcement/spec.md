## ADDED Requirements

### Requirement: A combo can be put under maintenance
A combo whose `meta.maintenance` is `true` SHALL be refused on every LLM endpoint for any request made with an API key (customer or admin key) that names it, with HTTP 503, error code `model_maintenance`, error type `server_error` and a Vietnamese message naming the combo. The refusal SHALL happen after the model allow-list check and before plan admission, so no plan credit is reserved and no upstream is called, and it SHALL be recorded in request history like every other platform denial. A request without an API key SHALL NOT be refused. Turning the flag off SHALL make the combo callable again on the next request. Combos can no longer list another combo as a member, but legacy rows may: when a combo under maintenance is a member of another combo, that member SHALL be skipped as unavailable and the outer combo SHALL continue with its other members. `/v1/models` SHALL keep listing a combo under maintenance and SHALL mark it with `maintenance: true`.

#### Scenario: Customer calls a combo under maintenance
- **WHEN** an admin turns maintenance on for combo `gpt` and a customer key requests `gpt`
- **THEN** the response is HTTP 503 with `{ error: { code: "model_maintenance", type: "server_error" } }`, no plan credit is consumed and the request appears in the customer's history with status 503

#### Scenario: Not allowed beats maintenance
- **WHEN** a customer whose group does not allow `gpt` requests `gpt` while it is under maintenance
- **THEN** the response is HTTP 403 `model_not_allowed`

#### Scenario: Maintenance off
- **WHEN** an admin turns maintenance off for `gpt`
- **THEN** the next request to `gpt` is served normally

#### Scenario: Nested member (legacy data)
- **WHEN** combo `outer` lists `inner` (under maintenance) and `other`, and a key requests `outer`
- **THEN** `outer` is served by `other` and `inner` is not called

#### Scenario: Listing flag
- **WHEN** a key calls `/v1/models` while `gpt` is under maintenance
- **THEN** the entry for `gpt` carries `maintenance: true`

## MODIFIED Requirements

### Requirement: Platform denials use one error format
Every denial the router produces itself on LLM endpoints (not errors relayed from an upstream provider) SHALL respond with `Content-Type: application/json`, the existing CORS header, and the body `{ "error": { "message": <Vietnamese sentence>, "type": <type>, "code": <code> } }`, plus `resetAt` inside `error` where listed. The codes are fixed:

| HTTP | code | type | when |
|---|---|---|---|
| 401 | `invalid_api_key` | `authentication_error` | key unknown or inactive |
| 403 | `key_expired` | `permission_error` | key past `expiresAt` |
| 403 | `account_suspended` | `permission_error` | owner suspended |
| 403 | `account_unverified` | `permission_error` | owner unverified |
| 403 | `model_not_allowed` | `permission_error` | model outside the allow-list |
| 503 | `model_maintenance` | `server_error` | combo under maintenance |
| 429 | `rate_limit` | `rate_limit_error` | RPM or TPM exceeded; `Retry-After: 60` |
| 402 | `budget_exhausted` | `insufficient_quota` | admin-key budget exhausted; `resetAt` when the window resets |
| 402 | `insufficient_quota` | `insufficient_quota` | no queued plan has credit (see `plan-queue-billing`) |
| 429 | `plan_limit` | `rate_limit_error` | every plan with credit is window-blocked; `Retry-After` and `resetAt` (see `plan-queue-billing`) |

Every such denial SHALL also be recorded in request history as today (request detail plus usage error row with error source `platform`).

#### Scenario: Denial body is OpenAI-compatible
- **WHEN** a request is rejected because the model is outside the group
- **THEN** the body parses as `{ error: { message, type: "permission_error", code: "model_not_allowed" } }` and the message names the model in Vietnamese

#### Scenario: Denials appear in history
- **WHEN** a customer request is rejected with `plan_limit`
- **THEN** the customer's request history shows that request with status 429
