## MODIFIED Requirements

### Requirement: Customer keys take their model access from the owner's current group
A key owned by a user account ("customer key") SHALL take its model allow-list exclusively from the group currently assigned to the owning user, read on every request. On a customer key, these stored values SHALL be ignored:
- group, RPM, TPM, budget, reset-window and allowed-model values stored on the customer key itself;
- any RPM, TPM, budget or reset-window stored on the group.

A group decides only which models its members may call, and which plans they may buy. Only the key's own `isActive` flag and `expiresAt` SHALL still apply to a customer key.

Keys without an owner ("admin keys") are limited by their own values only: RPM, TPM, budget, reset-window, expiry and model list. They SHALL NOT belong to a group: a group value stored on an admin key SHALL be ignored, and creating or updating an admin key SHALL store no group.

Two exceptions SHALL apply:
1. **Business models** (the combos listed in the `businessModels` setting) SHALL be outside every customer key's allow-list except a bot key's, whatever the group allows. Requesting one with a non-bot customer key SHALL be refused with 403 `model_not_allowed`.
2. **A bot key** (a customer key with a `botId`) SHALL ignore the group allow-list. It SHALL be allowed exactly the current business models. Any other model SHALL be refused with 403 `model_not_allowed`.

#### Scenario: Group change applies to the next request
- **WHEN** an admin moves a user from group A (allows `model-x`) to group B (does not allow `model-x`) and the user's key then requests `model-x`
- **THEN** the request is rejected with HTTP 403 and error code `model_not_allowed`, without restarting the server or editing the key

#### Scenario: Group allowing every model
- **WHEN** the owner's group has no model allow-list and the customer key requests any model the router can serve that is not a business model
- **THEN** the request passes the model check

#### Scenario: Stale key-level limits are ignored
- **WHEN** a customer key row still carries `rpm = 1` from an earlier admin edit and the paying plan sets no RPM
- **THEN** no RPM limit is applied to that key

#### Scenario: Legacy group rates are ignored
- **WHEN** a group row still carries `rpm = 1` or `tpm = 1` from before rates moved to plans
- **THEN** no rate limit is applied to its members because of it

#### Scenario: Normal key asks for a business model
- **WHEN** a non-bot customer key whose group allows every model requests `delify-biz`, which is a business model
- **THEN** the response is 403 `model_not_allowed`

#### Scenario: Bot key asks for a normal model
- **WHEN** a bot key requests `gpt-4o`
- **THEN** the response is 403 `model_not_allowed`

### Requirement: Model listing reflects the owner's group
For a non-bot customer key, `/v1/models` (and the kind-specific listings) SHALL list:
- exactly the models allowed by the owner's group, minus the business models;
- or, when the group allows all models, every model the router lists for an unrestricted key, minus the business models.

Purchased plans SHALL NOT narrow the listing.

For a bot key, `/v1/models` SHALL list exactly the current business models, with their labels as `owned_by` or display name. The kind-specific listings for other kinds SHALL be empty.

#### Scenario: Listing follows the group
- **WHEN** the owner's group allows only `combo-a` and `model-b`
- **THEN** `/v1/models` with that customer key lists `combo-a` and `model-b` and nothing else

#### Scenario: Bot key listing
- **WHEN** the business models are `delify-biz` and `delify-biz-pro`
- **THEN** `/v1/models` with a bot key lists exactly those two

## ADDED Requirements

### Requirement: Bot keys reach only chat completions
A bot key SHALL be accepted only on `/v1/chat/completions` (and its `/v1/api/chat`-style aliases that dispatch to the same chat handler) and on `/v1/models`.

On every other LLM endpoint (messages, responses, embeddings, images, audio, search, web, videos), a bot key SHALL be refused with HTTP 403, code `endpoint_not_allowed`, type `permission_error`, and the message "Key chatbot chỉ dùng được với /v1/chat/completions".

A request with a bot key whose bot is inactive SHALL be refused with HTTP 403, code `bot_disabled`, type `permission_error`, and the message "Chatbot này đang tắt".

Both denials SHALL use the platform denial format and be recorded like other platform denials. A business request whose guard cannot run SHALL respond 503 `guard_unavailable` (see business-guard).

#### Scenario: Bot key on the messages endpoint
- **WHEN** a bot key calls `/v1/messages`
- **THEN** the response is 403 `endpoint_not_allowed`

#### Scenario: Disabled bot
- **WHEN** the owner sets the bot inactive and its key calls `/v1/chat/completions`
- **THEN** the response is 403 `bot_disabled`
