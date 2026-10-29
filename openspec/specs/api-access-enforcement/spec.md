# api-access-enforcement Specification

## Purpose
Defines how the router authorizes an LLM API request made with an API key: which models and request rates apply, which accounts may call at all, how admin keys and customer keys differ, and the exact shape of every denial the router produces itself.
## Requirements
### Requirement: Customer keys take their model access from the owner's current group
A key owned by a user account ("customer key") SHALL take its model allow-list exclusively from the group currently assigned to the owning user, read on every request. Group, RPM, TPM, budget, reset-window and allowed-model values stored on the customer key itself SHALL be ignored, and so SHALL any RPM, TPM, budget or reset-window stored on the group: a group decides only which models its members may call (and which plans they may buy). Only the key's own `isActive` flag and `expiresAt` SHALL still apply to a customer key. Keys without an owner ("admin keys") are limited by their own values only — RPM, TPM, budget, reset-window, expiry and model list — and SHALL NOT belong to a group: a group value stored on an admin key SHALL be ignored, and creating or updating an admin key SHALL store no group.

#### Scenario: Group change applies to the next request
- **WHEN** an admin moves a user from group A (allows `model-x`) to group B (does not allow `model-x`) and the user's key then requests `model-x`
- **THEN** the request is rejected with HTTP 403 and error code `model_not_allowed`, without restarting the server or editing the key

#### Scenario: Group allowing every model
- **WHEN** the owner's group has no model allow-list and the customer key requests any model the router can serve
- **THEN** the request passes the model check

#### Scenario: Stale key-level limits are ignored
- **WHEN** a customer key row still carries `rpm = 1` from an earlier admin edit and the paying plan sets no RPM
- **THEN** no RPM limit is applied to that key

#### Scenario: Legacy group rates are ignored
- **WHEN** a group row still carries `rpm = 1` or `tpm = 1` from before rates moved to plans
- **THEN** no rate limit is applied to its members because of it

### Requirement: One default admin key is kept by the server
The dashboard SHALL NOT offer screens to create, edit or delete admin keys. The server SHALL guarantee that at least one admin key (named `Default Key`, no group, no limits) exists, creating it at start-up and whenever the admin key list is read and none exists, so that CLI configuration, usage examples and the dashboard's model test always have a key to use. Creating it SHALL be idempotent, including under concurrent calls. On upgrade, an admin key that inherited its model list from a group SHALL receive that list as its own before the group is removed, so no key gains access it did not have.

#### Scenario: Fresh install
- **WHEN** the admin key list is read and no admin key exists
- **THEN** one `Default Key` is created and returned, and a second read creates no further key

#### Scenario: Group list carried over
- **WHEN** an upgraded database has an admin key with no model list whose group allows `glm-5` and `kimi`
- **THEN** the key afterwards allows exactly `glm-5` and `kimi` and has no group

### Requirement: Spending budgets do not apply to customer keys
Group and key `budgetUsd`/`resetWindow` SHALL NOT be enforced for customer keys; customer spending is governed only by the plan queue (capability `plan-queue-billing`). Admin keys keep their existing budget enforcement and its 402 denial.

#### Scenario: Customer key with a budgeted group
- **WHEN** the owner's group has `budgetUsd = 1` and the customer has already spent $5 through plans this window
- **THEN** the request is not rejected for budget reasons

### Requirement: Customer request rates come from the paying plan and are counted per user
For customer keys, the RPM and TPM limits SHALL be those of the plan (`plans.rpm` / `plans.tpm`, empty = unlimited) that the purchase at the head of the user's queue was bought from, read live on every request. A purchase with no plan (admin credit, gift credit) and a user with no purchase able to pay SHALL have no rate limit applied; the latter is then answered by plan admission (402 or 429). RPM SHALL be the number of recorded requests across all keys of the same user in the trailing 60 seconds, and TPM the sum of prompt and completion tokens across all keys of that user in the trailing 60 seconds. When TPM is exceeded the request SHALL wait for room up to `TPM_MAX_WAIT_MS` (default 30000) with waiting serialized per user, then fail with 429 `rate_limit` if still over. Admin keys keep per-key counting.

#### Scenario: Two keys share one RPM allowance
- **WHEN** the paying plan allows 10 RPM and the user has made 6 requests with key K1 and 4 with key K2 in the last 60 seconds
- **THEN** the next request with either key is rejected with HTTP 429, error code `rate_limit` and header `Retry-After: 60`

#### Scenario: The head of the queue sets the rate
- **WHEN** a user holds plan A (1 RPM) ahead of plan B (100 RPM) in the queue and has made 1 request in the last minute
- **THEN** the next request is rejected with 429 `rate_limit`, and after the user moves plan B to the head it is accepted

#### Scenario: Editing a plan applies at once
- **WHEN** an admin raises a plan's RPM while customers hold purchases of it
- **THEN** the new value applies to those customers' next request

#### Scenario: Credit without a plan
- **WHEN** a user pays from an admin or gift credit that has no plan and has made 20 requests in the last minute
- **THEN** the request is not rejected for RPM

#### Scenario: Admin keys unaffected
- **WHEN** two admin keys each made 6 requests in the last minute and each key has RPM 10
- **THEN** neither key is rejected for RPM

### Requirement: Only active accounts may call the API
Before any other limit check, a request with a customer key whose owner status is not `active` SHALL be rejected with HTTP 403: error code `account_suspended` when the status is `suspended`, `account_unverified` when it is `unverified`. The status SHALL be read per request so a change applies to the next request. The same rejection SHALL apply to `/v1/models` and its kind-specific variants.

#### Scenario: Suspension blocks the API immediately
- **WHEN** an admin sets a user's status to `suspended` and the user's existing key sends a chat completion one second later
- **THEN** the response is HTTP 403 with error code `account_suspended` and the request is not forwarded to any provider

#### Scenario: Unverified owner
- **WHEN** a key belongs to a user whose status is `unverified`
- **THEN** every LLM endpoint and `/v1/models` respond HTTP 403 with error code `account_unverified`

### Requirement: Model listing reflects the owner's group
For a customer key, `/v1/models` (and the kind-specific listings) SHALL list exactly the models allowed by the owner's group, or every model the router lists for an unrestricted key when the group allows all models. Purchased plans SHALL NOT narrow the listing.

#### Scenario: Listing follows the group
- **WHEN** the owner's group allows only `combo-a` and `model-b`
- **THEN** `/v1/models` with that customer key lists `combo-a` and `model-b` and nothing else

### Requirement: Admin key surface excludes customer keys
`GET /api/keys` SHALL return only admin keys. `GET`, `PUT` and `DELETE /api/keys/[id]` SHALL respond 404 for a customer key. The admin Endpoint & Key page SHALL show only admin keys plus a line stating how many customer keys exist and that they are managed on the user's page. No admin key API SHALL return a customer key's secret.

#### Scenario: Customer secret never listed
- **WHEN** an admin calls `GET /api/keys` while customers own 3 keys
- **THEN** the response contains no key with an owner and no customer secret

#### Scenario: Customer key not editable through the admin key API
- **WHEN** an admin sends `PUT /api/keys/<customer-key-id>`
- **THEN** the response is HTTP 404 and the key is unchanged

### Requirement: Platform denials use one error format
Every denial the router produces itself on LLM endpoints (not errors relayed from an upstream provider) SHALL respond with `Content-Type: application/json`, the existing CORS header, and the body `{ "error": { "message": <Vietnamese sentence>, "type": <type>, "code": <code> } }`, plus `resetAt` inside `error` where listed. The codes are fixed:

| HTTP | code | type | when |
|---|---|---|---|
| 401 | `invalid_api_key` | `authentication_error` | key unknown or inactive |
| 403 | `key_expired` | `permission_error` | key past `expiresAt` |
| 403 | `account_suspended` | `permission_error` | owner suspended |
| 403 | `account_unverified` | `permission_error` | owner unverified |
| 403 | `model_not_allowed` | `permission_error` | model outside the allow-list |
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

