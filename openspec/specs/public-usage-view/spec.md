# public-usage-view Specification

## Purpose
Lets an API key holder view their own usage receipts, per-model breakdown, and clear their own request history — gated by the key itself, with no admin access required and no leakage of key existence.
## Requirements
### Requirement: public key-holder usage as JSON

The public key-holder usage view MUST be available as a JSON endpoint (in addition to the existing behavior of returning 404 for unknown/inactive keys with no existence leak), so a key holder can fetch their own usage with their API key.

#### Scenario: valid key returns usage

- **WHEN** `GET /api/usage/key?key=<active-key>&period=7d` is called
- **THEN** it returns `{key (masked), name, groupName, isActive, budgetUnlimited, budgetSpent, budgetLimit, budgetPct, resetWindow, rpmLimit, rpmLive, tpmLimit, tpmLive, peakTpm, totalRequests, totalCost, totalTokens, period, models:[{model,requests,input,output,cacheRead,cost}], rows:[...]}` as JSON
- **AND** the key is returned masked as `sk-…****` + last 4 chars (>=10 chars) or `****` (<10 chars); the full key is never in the response

#### Scenario: unknown or inactive key

- **WHEN** `GET /api/usage/key?key=<bogus>` or `?key=<inactive-key>` is called
- **THEN** the response is 404 with a JSON body (no distinction between "not found" and "inactive" — existence must not leak)

#### Scenario: missing key

- **WHEN** `GET /api/usage/key` is called with no `key` param
- **THEN** the response is 400 `{"error":"key is required"}`

#### Scenario: clear history

- **WHEN** `DELETE /api/usage/key/history?key=<active-key>` is called
- **THEN** the usage history rows for that key are cleared and an empty success response returned

### Requirement: No key-existence leak

The system SHALL return HTTP 404 (Not Found) — never 401/403 — when the supplied key is unknown or inactive, so the existence of a key cannot be probed.

#### Scenario: Unknown key

- **WHEN** a visitor opens `/usage?key=<random-string>` that is not a real key
- **THEN** the server returns 404 and reveals nothing about whether the key exists

#### Scenario: Inactive key

- **WHEN** a visitor opens `/usage?key=<deactivated-key>`
- **THEN** the server returns 404 (same as unknown — no distinction)

### Requirement: requestedModel shown, resolved model hidden

The public usage view SHALL display the combo name the key holder called (`requestedModel`) and MUST NOT expose the resolved provider/model or the provider identity.

#### Scenario: Combo shown not resolved

- **WHEN** a key holder called combo `mygpt` (resolved internally to `openai-compatible/glm-5.3:pre`)
- **THEN** the receipts row shows model `mygpt`; neither `glm-5.3:pre` nor `openai-compatible` appears

### Requirement: Clear own history

The system SHALL let a key holder delete their own `usageHistory` and `requestDetails` rows via a "Clear history" action gated by the key. The action MUST require a confirmation step before executing.

#### Scenario: Clear history with confirmation

- **WHEN** a key holder clicks "Clear history" and confirms
- **THEN** the system deletes all `usageHistory` and `requestDetails` rows for that key (not the admin `usageDaily` lifetime counters) and reloads the receipts

#### Scenario: Clear history without confirmation

- **WHEN** a key holder clicks "Clear history" but the confirmation popover is dismissed
- **THEN** no deletion occurs

#### Scenario: Clear history on unknown key

- **WHEN** a clear-history request arrives with an unknown key
- **THEN** the system returns 404 and deletes nothing

### Requirement: Admin lifetime counters preserved

The "Clear history" action SHALL NOT delete the admin-facing `usageDaily` lifetime aggregate counters; it deletes only the key's `usageHistory` and `requestDetails` rows.

#### Scenario: Daily counters survive clear

- **WHEN** a key holder clears their history
- **THEN** the admin usage overview's lifetime/daily totals are unchanged

### Requirement: Public detail redaction by default

The system SHALL NOT return raw `providerRequest`/`providerResponse`/`request`/`response` payloads from the public detail endpoint unless the key holder explicitly opts in (e.g. `includeRaw=1`). By default those fields are replaced with a `redacted` marker.

#### Scenario: Default detail is redacted

- **WHEN** a key holder views their own request detail without `includeRaw`
- **THEN** the `providerRequest`, `providerResponse`, `request`, and `response` fields are `{redacted: true}`

#### Scenario: Owner opts into raw

- **WHEN** a key holder views their own request detail with `includeRaw=1`
- **THEN** the actual stored payloads (truncated to `observabilityMaxJsonSize`) are returned

