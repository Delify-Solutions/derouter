## MODIFIED Requirements

### Requirement: Customer keys take their model access from the owner's current group
A key owned by a user account ("customer key") SHALL take its model allow-list from the group currently assigned to the owning user, read on every request, **narrowed by the plans the customer can currently pay with**. Group, RPM, TPM, budget, reset-window and allowed-model values stored on the customer key itself SHALL be ignored, and so SHALL any RPM, TPM, budget or reset-window stored on the group: a group decides only which models its members may call (and which plans they may buy), and a plan may restrict that set further but SHALL never widen it. The allow-list SHALL apply to image combos exactly as it does to text combos, so an image model outside the effective set is refused on `/v1/images/generations` with the same 403 before any upstream call. Only the key's own `isActive` flag and `expiresAt` SHALL still apply to a customer key.

The effective set SHALL be computed as follows:
- A group with no allow-list SHALL allow every model, as before.
- A live purchase whose `allowedModels` snapshot is `null` SHALL NOT narrow anything.
- A live purchase whose snapshot lists models SHALL contribute exactly those.
- The effective set SHALL therefore be the group's list (or everything, when it has none) when at least one live purchase is unrestricted, and otherwise the union of the live purchases' lists, intersected with the group's list.
- "Live" means `active`, not yet started-later-than-now excluded, and unexpired — the same window admission uses.

A customer holding no live purchase at all SHALL keep the group's full list: the model list is also what the account page advertises before the first purchase, and hiding it there would make a fresh account look broken. Admission then answers 402 for every request, which is the honest reason.

A model the effective set excludes SHALL be refused with HTTP 403 `model_not_allowed`, the same code and message the group alone produces today.

#### Scenario: Group change applies to the next request
- **WHEN** an admin moves a user from group A (allows `model-x`) to group B (does not allow `model-x`) and the user's key then requests `model-x`
- **THEN** the request is rejected with HTTP 403 and error code `model_not_allowed`, without restarting the server or editing the key

#### Scenario: Group allowing every model
- **WHEN** the owner's group has no model allow-list, the customer holds only purchases that do not restrict models, and the key requests any model the router can serve
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

#### Scenario: Plan narrows the group
- **WHEN** the group allows `claude-sonnet`, `gpt-5` and `gemini-pro`, and the customer's only live purchase allows `claude-sonnet`
- **THEN** a request for `gpt-5` is rejected with HTTP 403 `model_not_allowed`

#### Scenario: A plan cannot widen the group
- **WHEN** the group allows only `claude-sonnet` and a live purchase lists `claude-sonnet` and `gpt-5`
- **THEN** a request for `gpt-5` is rejected with HTTP 403 `model_not_allowed`

#### Scenario: Two plans, two model sets
- **WHEN** the customer holds a live purchase allowing `claude-sonnet` and another allowing `gpt-5`
- **THEN** both models are callable

#### Scenario: An expired plan stops granting its models
- **WHEN** the only purchase allowing `gpt-5` expires and the customer requests `gpt-5`
- **THEN** the request is rejected with HTTP 403 `model_not_allowed`

### Requirement: Model listing reflects the owner's group
For a customer key, `/v1/models` (and the kind-specific listings) SHALL list exactly the models in the effective set defined by "Customer keys take their model access from the owner's current group" — the owner's group allow-list, narrowed by the live purchases' model restrictions, and the union of several purchases' lists. A customer holding no live purchase SHALL see the group's full list.

#### Scenario: Listing follows the group
- **WHEN** the owner's group allows only `combo-a` and `model-b` and every live purchase is unrestricted
- **THEN** `/v1/models` with that customer key lists `combo-a` and `model-b` and nothing else

#### Scenario: Listing follows the plans
- **WHEN** the group allows five models and the customer's live purchases allow `combo-a` and `combo-c`
- **THEN** `/v1/models` lists `combo-a` and `combo-c` and nothing else

#### Scenario: Listing with no live purchase
- **WHEN** a customer's only purchase has expired and the group allows `combo-a` and `model-b`
- **THEN** `/v1/models` still lists both, and a chat request answers 402 rather than 403
