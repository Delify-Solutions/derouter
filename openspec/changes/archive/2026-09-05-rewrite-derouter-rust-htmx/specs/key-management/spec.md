## Purpose

Manages API keys (CRUD) and key groups, where each key may carry per-key limits (RPM, TPM, budget, reset window, expiry, allowed models) and inherit defaults from its group.

## ADDED Requirements

### Requirement: API key CRUD

The system SHALL allow an admin to create, read, update, and delete API keys. Each key has a unique `key` string (generate-on-create, `sk-…` style), a display `name`, an `isActive` flag, a `groupId`, and optional per-key limits.

#### Scenario: Create a key

- **WHEN** an admin submits a new key with name "ci" and no custom limits
- **THEN** the system generates a unique key string, stores the row in `apiKeys`, and the key is immediately usable for `/v1/*` requests

#### Scenario: Deactivate a key

- **WHEN** an admin sets `isActive = false` on an existing key
- **THEN** subsequent requests carrying that key are rejected before any upstream call

#### Scenario: Delete a key

- **WHEN** an admin deletes a key via the admin UI
- **THEN** the key row is removed and the key immediately fails authentication

### Requirement: Per-key limits

The system SHALL support optional per-key `rpm`, `tpm`, `budgetUsd`, `resetWindow`, `expiresAt`, and `allowedModels`. When any limit is unset at the key level, the key inherits the value from its group; when the group also leaves it unset, the limit is unlimited (or unset for `allowedModels`).

#### Scenario: Key inherits group RPM

- **WHEN** a key has `rpm = NULL` and its group has `rpm = 60`
- **THEN** the key is rate-limited at 60 RPM

#### Scenario: Key overrides group TPM

- **WHEN** a key has `tpm = 40` and its group has `tpm = 1000`
- **THEN** the key is limited at 40 TPM, not 1000

#### Scenario: Unlimited key

- **WHEN** a key and its group both leave `rpm` and `tpm` unset and `budgetUsd` unset
- **THEN** the key has no RPM/TPM/budget limits (only expiry and `allowedModels`, if set, still apply)

### Requirement: Reset window

The system SHALL reset a key's accumulated window cost/requests when `resetWindow` elapses. Supported windows: 5 hours (`5h`), daily (`daily`), monthly (`monthly`). The window is tracked from `windowStartedAt`; when the window elapses, `windowStartedAt` and `windowCostUsd` reset.

#### Scenario: 5h window resets

- **WHEN** a key has `resetWindow = "5h"`, a `windowStartedAt` of 5 hours ago, and `windowCostUsd = 0.42`
- **THEN** on the next request the system detects the window elapsed, resets `windowCostUsd` to 0 and `windowStartedAt` to now, then proceeds

#### Scenario: Daily window not yet elapsed

- **WHEN** a key has `resetWindow = "daily"` and the window started 3 hours ago
- **THEN** the system continues accumulating against the existing window

### Requirement: Allowed models

The system SHALL restrict a key to a defined set of allowed models/combos when `allowedModels` is set. When unset (both key and group), the key may call any combo/model.

#### Scenario: Key restricted to a combo

- **WHEN** a key has `allowedModels = ["mygpt"]` and a request names `mygpt`
- **THEN** the request proceeds

#### Scenario: Key blocked from a combo

- **WHEN** a key has `allowedModels = ["mygpt"]` and a request names `myhaiku`
- **THEN** the system returns HTTP 403 and makes no upstream call

### Requirement: Key groups

The system SHALL allow an admin to create key groups, each with default `rpm`, `tpm`, `budgetUsd`, `resetWindow`, `allowedModels`, and `priceOverrides`. A key assigned to a group inherits unset per-key limits from the group.

#### Scenario: Create a group with defaults

- **WHEN** an admin creates group "free" with `rpm = 10`, `tpm = 200`, `budgetUsd = 1`
- **THEN** keys assigned to "free" with null per-key limits are constrained to those values

#### Scenario: Per-key limit overrides group

- **WHEN** a key in group "free" sets `rpm = 5`
- **THEN** the key uses 5 RPM, not the group's 10
