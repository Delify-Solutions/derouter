# upstream-error-handling Specification

## Purpose
Defines what the router does when an upstream provider answers a proxied LLM request with an error: which errors count against the provider account, how long it is locked, and which status the client finally sees.
## Requirements
### Requirement: A request the upstream refuses for its size does not lock the account
When an upstream answers with HTTP 413, or with HTTP 400 or 422 whose message states that the request is too large (context length or window exceeded, prompt too long, payload or request entity too large, length limit exceeded), the router SHALL treat the error as a property of the request and not of the provider account: it SHALL NOT set a cooldown or model lock, SHALL NOT mark the connection unavailable, and SHALL NOT retry the same request on another account of the same provider. The client SHALL receive the upstream status (400, 413 or 422) and the upstream message, not HTTP 503. Other callers of the same model SHALL keep being served normally.

An HTTP 400 or 422 whose message does not state a size problem (for example a rejected API key) SHALL keep the existing account-level handling. An HTTP 429 SHALL keep its rate-limit backoff even when its message mentions that the request is too large.

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

### Requirement: A combo moves on after a size refusal and reports the upstream status
When a model of a combo fails with a size refusal, the combo SHALL try its next model immediately, without a cooldown wait, because another model may have a larger context window. When every model has failed, the combined response SHALL carry the status of the first failure (for example 400), not a blanket 503.

#### Scenario: Larger model takes over
- **WHEN** a combo lists `small/model` then `big/model` and `small/model` answers HTTP 400 `context_length`
- **THEN** `big/model` is called next and its answer is returned

#### Scenario: Every model refuses
- **WHEN** the only model of a combo answers HTTP 400 `context_length`
- **THEN** the client receives HTTP 400

### Requirement: Retry-After survives a combo
When a combo model is unavailable because of a cooldown, the combined 503 SHALL carry a `Retry-After` header with the shortest remaining wait of the models that reported one, whether the model reported it in the response body (`retryAfter`) or in its `Retry-After` header.

#### Scenario: Locked model behind a combo
- **WHEN** a combo has one model whose answer is HTTP 503 with `Retry-After: 12`
- **THEN** the combined response is HTTP 503 with `Retry-After` of 11 or 12 seconds

### Requirement: The wait for upstream response headers grows with the request body and is not retried
The router SHALL abort a proxied request whose upstream has sent no response headers after a connect timeout of `FETCH_CONNECT_TIMEOUT_MS` (default 60 s) plus `FETCH_CONNECT_TIMEOUT_PER_KB_MS` (default 100 ms) for every KB of request body, capped at `FETCH_CONNECT_TIMEOUT_MAX_MS` (default 300 s), because the upstream prefills the whole prompt before it answers. A provider that sets its own `timeoutMs` SHALL keep that fixed value. A request that hits the connect timeout SHALL NOT be sent again to the same upstream URL by the executor's network-retry loop, since resending a large prompt to a slow or hung upstream only multiplies its load; the account and combo fallback still apply.

#### Scenario: Large prompt answered slowly
- **WHEN** a request body of about 700 KB is answered by the upstream after 90 s
- **THEN** the client receives that answer (the allowed wait is about 130 s)

#### Scenario: Upstream never answers
- **WHEN** a request body of 1 KB reaches an upstream that never sends headers
- **THEN** the router makes one attempt and fails the request after about 60 s, instead of retrying three more times and failing after about 249 s
