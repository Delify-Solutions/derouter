## MODIFIED Requirements

### Requirement: A request the upstream refuses for its size does not lock the account
When an upstream answers with HTTP 413, or with HTTP 400 or 422 whose message states that the request is too large (context length or window exceeded, prompt too long, payload or request entity too large, length limit exceeded), or with HTTP 400 or 422 that is the provider's own validation error for the request (its body carries `"type":"invalid_request_error"`, or a non-null `"param"` naming the field it refused), the router SHALL treat the error as a property of the request and not of the provider account: it SHALL NOT set a cooldown or model lock, SHALL NOT mark the connection unavailable, and SHALL NOT retry the same request on another account of the same provider. The client SHALL receive the upstream status (400, 413 or 422) and the upstream message, not HTTP 503. Other callers of the same model SHALL keep being served normally.

An HTTP 400 or 422 whose message does not state a size problem and is not such a validation error (for example a rejected API key) SHALL keep the existing account-level handling. A validation-shaped 400 or 422 whose message names a credential, API key, token, permission, organization, billing, subscription or account problem SHALL also keep the account-level handling. An HTTP 429 SHALL keep its rate-limit backoff even when its message mentions that the request is too large, and the credit and rate-limit message rules SHALL take precedence over the validation rule.

#### Scenario: Context window exceeded
- **WHEN** the only connection of a provider answers one request with HTTP 400 and `"details":{"type":"context_length","limit":1048572,"actual":1099691}`
- **THEN** that request receives HTTP 400 with the upstream message
- **AND** the next request for the same model, from any key, is sent upstream immediately and is not answered with HTTP 503

#### Scenario: Body over the upstream limit
- **WHEN** the upstream answers HTTP 413 `length limit exceeded`
- **THEN** the client receives HTTP 413 and no lock is written on the connection

#### Scenario: Bad API key keeps its fallback
- **WHEN** an upstream answers HTTP 400 `API key not valid` for one account
- **THEN** the account is locked as before and the next account of the provider is tried

#### Scenario: Token-per-minute 429 is still a rate limit
- **WHEN** an upstream answers HTTP 429 `Request too large ... on tokens per min`
- **THEN** the account backs off exponentially as for any 429

#### Scenario: One client's malformed request does not lock the model for others
- **WHEN** an upstream answers one request with HTTP 400 `{"error":{"message":"Invalid input","type":"invalid_request_error","param":"tool_choice"}}`
- **THEN** that request receives HTTP 400 with the upstream message
- **AND** no connection is marked unavailable, and the next valid request for the same model is sent upstream immediately

#### Scenario: A combo moves on after a validation error
- **WHEN** a combo's first model answers HTTP 400 `invalid_request_error` for a parameter it does not accept
- **THEN** the combo tries its next model without waiting and without a cooldown on the first

#### Scenario: Validation-shaped error about the account
- **WHEN** an upstream answers HTTP 400 `{"error":{"message":"Invalid API key provided","type":"invalid_request_error"}}`
- **THEN** the account is locked as before and the next account of the provider is tried

#### Scenario: Low credit is still a backoff
- **WHEN** an upstream answers HTTP 400 `{"type":"invalid_request_error","message":"Your credit balance is too low"}`
- **THEN** the account backs off as for any credit exhaustion
