# proxy-routing Specification

## Purpose
Routes incoming client requests that name a combo to an upstream AI provider/model fallback chain, enforcing per-key access and rate/budget limits before any upstream call, and logging usage — without exposing the resolved provider/model to the key holder.
## Requirements
### Requirement: Combo resolution

The system SHALL resolve a client-supplied `model` string into an ordered list of `provider/model` candidates. When the `model` string is a bare name containing no `/` and matches a combo in the `combos` table, the system MUST use that combo's `models` array as the candidate list. When the `model` string already contains a `/` (an explicit provider/model) or matches no combo, it MUST be treated as a single direct candidate.

#### Scenario: Client sends a combo name

- **WHEN** a client sends `{"model":"mygpt","messages":[...]}` and `mygpt` is a combo whose `models` is `["openai/gpt-4o","openai-compatible/glm-5.3:pre"]`
- **THEN** the system treats the request as a fallback chain over those two provider/model pairs in order

#### Scenario: Client sends an explicit provider/model

- **WHEN** a client sends `{"model":"openai/gpt-4o",...}` (a string containing `/`)
- **THEN** the system treats it as a single direct candidate and skips combo lookup

#### Scenario: Unknown model

- **WHEN** a client sends a bare name that matches no combo and contains no `/`
- **THEN** the system returns a `model_not_found` error with HTTP 404

### Requirement: Fallback strategy

The system SHALL honor a fallback strategy when a combo resolves to multiple candidates. The strategy is `fallback` (try candidates in order, move to the next on error) or `round-robin` (rotate the starting candidate per request). A combo-specific strategy overrides the global `comboStrategy` setting; when neither is set, the default is `fallback`.

#### Scenario: Fallback on provider error

- **WHEN** strategy is `fallback`, the first candidate's upstream call errors, and a second candidate is available
- **THEN** the system retries the whole request against the second candidate before returning an error to the client

#### Scenario: Round-robin rotation

- **WHEN** strategy is `round-robin` and two consecutive identical requests arrive
- **THEN** the system starts the second request at the candidate following the one that started the first

#### Scenario: Combo-specific strategy wins

- **WHEN** a combo defines its own `fallbackStrategy` and the global `comboStrategy` differs
- **THEN** the system uses the combo-specific strategy for that combo

### Requirement: Per-key access enforcement before upstream call

The system SHALL enforce key access and limits BEFORE issuing any upstream provider call. Enforcement covers: key existence and active status, model allowance (`allowedModels`), expiry (`expiresAt`), requests-per-minute (RPM), tokens-per-minute (TPM), and budget (`windowCostUsd` vs `budgetUsd` within `resetWindow`).

#### Scenario: Unknown or inactive key

- **WHEN** a request carries an API key that does not exist or is inactive
- **THEN** the system returns HTTP 401/403 and makes no upstream call

#### Scenario: Model not allowed for key

- **WHEN** the key's `allowedModels` is set and the requested combo is not in it
- **THEN** the system returns HTTP 403 with a model-not-allowed error and makes no upstream call

#### Scenario: RPM exceeded

- **WHEN** a key has `rpm = 5` and a 6th request arrives within the same 60-second window
- **THEN** the system returns HTTP 429 and makes no upstream call

#### Scenario: TPM exceeded

- **WHEN** a key has `tpm = 40` and a second request that would push the minute's total tokens over 40 arrives before the first completes
- **THEN** the system returns HTTP 429 and makes no upstream call

#### Scenario: Budget exhausted

- **WHEN** a key has `budgetUsd` set and the accumulated `windowCostUsd` for the current `resetWindow` reaches the budget
- **THEN** the system returns HTTP 429 (or 402) and makes no upstream call until the window resets

#### Scenario: Expired key

- **WHEN** a key's `expiresAt` is set and the current time is past it
- **THEN** the system returns HTTP 403 and makes no upstream call

### Requirement: requestedModel preservation

The system SHALL record the bare combo name the client sent (`requestedModel` — the original `model` string when it contains no `/`) through the request-detail pipeline and surface it in usage history and public receipts, distinct from the resolved provider/model. The resolved model MUST NOT replace the client-visible model in key-holder-facing views.

#### Scenario: requestedModel stored in request details

- **WHEN** a client sends `model = "mygpt"` and the proxy resolves it to `openai-compatible/glm-5.3:pre`
- **THEN** the stored request-detail record's `requestedModel` field is `"mygpt"` and its `model` field is `"openai-compatible/glm-5.3:pre"`

#### Scenario: Usage history shows combo name

- **WHEN** an admin or key holder views usage history for a request that called combo `mygpt`
- **THEN** the displayed model is `mygpt` (the `requestedModel`), not the resolved provider/model

### Requirement: Streaming and non-streaming responses

The system SHALL support both streaming (SSE) and non-streaming (JSON) responses for chat completions, matching the OpenAI/Anthropic response shapes the upstream returns, including an SSE-to-JSON aggregation path when the client requests a non-streaming response from a streaming-only upstream.

#### Scenario: Client requests streaming

- **WHEN** a client sends `{"stream":true,...}`
- **THEN** the system returns a `text/event-stream` response forwarding upstream chunks

#### Scenario: Client requests non-streaming from a streaming upstream

- **WHEN** a client sends `{"stream":false,...}` but the resolved upstream only streams
- **THEN** the system aggregates the upstream SSE stream into a single JSON response before returning

### Requirement: Usage logging

The system SHALL log every proxied request's usage (provider, model, connectionId, apiKey, prompt/completion/cost tokens, status) into `usageHistory`, and detailed request/response payloads into `requestDetails` via a buffered flush (batch threshold + background timer), NOT synchronously per request.

#### Scenario: Usage row written

- **WHEN** a proxied chat request completes
- **THEN** a `usageHistory` row exists with the correct tokens, cost, status, and the `requestedModel` in its `meta` JSON

#### Scenario: Request details buffered

- **WHEN** many requests complete faster than the flush interval
- **THEN** their `requestDetails` rows are written in batches, not one INSERT per request

