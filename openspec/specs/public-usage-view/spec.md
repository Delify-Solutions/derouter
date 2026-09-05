# public-usage-view Specification

## Purpose
Lets an API key holder view their own usage receipts, per-model breakdown, and clear their own request history — gated by the key itself, with no admin access required and no leakage of key existence.
## Requirements
### Requirement: Self-serve usage page

The system SHALL provide a public page, reachable by supplying an API key, that shows that key's recent usage: a receipts list and a per-model usage breakdown (requests, input, output, cache, cost) for the selected period.

#### Scenario: View own usage

- **WHEN** a key holder opens `/usage?key=<their-key>` with a valid, active key
- **THEN** the page loads that key's own receipts and per-model breakdown, with the key masked as `sk-…****last4`

#### Scenario: Period selection

- **WHEN** a key holder selects a period (Today / Yesterday / Week / Month) or a custom date range
- **THEN** the receipts and breakdown recompute for that window

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

