## MODIFIED Requirements

### Requirement: Combo resolution

The system SHALL resolve a client-supplied `model` string into an ordered list of `provider/model` candidates sourced from the full 123-entry provider registry. When the `model` string is a bare name containing no `/` and matches a combo in the `combos` table, the system MUST use that combo's `models` array as the candidate list. When the `model` string already contains a `/` (an explicit provider/model) or matches no combo, it MUST be treated as a single direct candidate. Each resolved `provider` MUST be looked up in the registry to obtain its transport (baseUrl, format, headers, auth) and to select the specialized executor when one exists for that provider's id/alias, else the format's default executor. The OpenAI-compatible fallback remains for providers with no specialized executor.

#### Scenario: Client sends a combo name

- **WHEN** a client sends `{"model":"mygpt","messages":[...]}` and `mygpt` is a combo whose `models` is `["openai/gpt-4o","openai-compatible/glm-5.3:pre"]`
- **THEN** the system treats the request as a fallback chain over those two provider/model pairs in order, looking each provider up in the registry for transport + executor

#### Scenario: Client sends an explicit provider/model

- **WHEN** a client sends `{"model":"claude/claude-sonnet-4-20250514",...}` (provider `claude`, alias `cc`)
- **THEN** the system resolves the `claude` registry entry (transport format `claude`, anthropic headers) and routes to the specialist/anthropic executor for that transport

#### Scenario: Unknown model

- **WHEN** a client sends a bare name that matches no combo and contains no `/`
- **THEN** the system returns a `model_not_found` error with HTTP 404
