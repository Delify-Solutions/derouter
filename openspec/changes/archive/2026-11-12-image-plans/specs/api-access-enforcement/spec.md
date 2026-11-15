## MODIFIED Requirements

### Requirement: Customer keys take their model access from the owner's current group
A key owned by a user account ("customer key") SHALL take its model allow-list exclusively from the group currently assigned to the owning user, read on every request. Group, RPM, TPM, budget, reset-window and allowed-model values stored on the customer key itself SHALL be ignored, and so SHALL any RPM, TPM, budget or reset-window stored on the group: a group decides only which models its members may call (and which plans they may buy). The allow-list SHALL apply to image combos exactly as it does to text combos, so an image model outside the group's list is refused on `/v1/images/generations` with the same 403 before any upstream call. Only the key's own `isActive` flag and `expiresAt` SHALL still apply to a customer key. Keys without an owner ("admin keys") are limited by their own values only — RPM, TPM, budget, reset-window, expiry and model list — and SHALL NOT belong to a group: a group value stored on an admin key SHALL be ignored, and creating or updating an admin key SHALL store no group.

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

#### Scenario: Image model outside the group
- **WHEN** the owner's group allow-list holds no image combo and the key calls `/v1/images/generations`
- **THEN** the request is rejected with HTTP 403 `model_not_allowed` before any upstream call
