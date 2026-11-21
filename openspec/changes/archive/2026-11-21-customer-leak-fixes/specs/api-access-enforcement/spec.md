## ADDED Requirements

### Requirement: One API key extraction for the guard and the handlers
The router SHALL read the API key of an LLM request in one way everywhere: the request guard, every `/v1`, `/v1beta` and Gemini-native handler, the model listings and the error log SHALL use one shared extractor that takes, in this order, the `Authorization: Bearer` token, the `x-api-key` header, the `x-goog-api-key` header and the `key` query parameter. A key the guard accepted SHALL therefore always be the key the handler enforces, masks, rate-limits and charges; a request SHALL never pass the guard with a key and then be served as keyless.

#### Scenario: Key in the query string
- **WHEN** `requireApiKey` is off and a customer key is sent only as `?key=<key>` to `/v1/chat/completions`
- **THEN** the handler enforces that key exactly as for a Bearer token: combos only, plan admission, charge and masked response

#### Scenario: Google header
- **WHEN** a client sends its key only in `x-goog-api-key`
- **THEN** the guard and the handler read the same key
