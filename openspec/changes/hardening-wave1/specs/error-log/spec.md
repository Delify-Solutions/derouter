## MODIFIED Requirements

### Requirement: Every failed proxy request is kept as one error log entry
The router SHALL store one entry for each request to a proxied model endpoint (chat completions, messages, responses, embeddings, image generation, search, fetch, speech, video creation) that ends with HTTP status 400 or above, and for each streamed response that fails after its headers were sent. An entry SHALL record the time, endpoint, final status, error code and message, the model the client asked for (the string the client sent, not the id the router resolved), the provider, upstream model and connection of the last failed upstream call, the key id and an owner label (the owner's email, or the key name), whether the request streamed, the request size in bytes, an estimated token count and number of turns, the latency, and every failed upstream attempt (provider, model, connection, status, error text, time since the request started). Not logged: audio transcription (multipart upload), a video status lookup, and the Gemini-native `/v1beta` forwarding to Google (the `/v1beta` calls that go through the chat engine are logged). Recording SHALL happen after the response is returned and SHALL NOT delay, change or fail the request it describes. A request whose client disconnected before the answer is not a failure and SHALL NOT be logged, whatever status the router settled on.

Each entry SHALL carry a source: `upstream` (at least one upstream call failed), `stream` (the response failed after it started; the status is 200), `router` (no upstream call was made and the status is 5xx: no credentials, every account cooling down, an internal error), `request` (no upstream call and a 4xx other than 401, 402, 403, 429: invalid body, unknown model), or `platform` (the router's own verdict on the key, group or plan: 402, 403, 429).

#### Scenario: Upstream refuses the context length
- **WHEN** a client calls `GLM-5.3` with a prompt over the context window and the upstream answers 400 `context_length`
- **THEN** one entry exists with source `upstream`, status 400, the requested model `GLM-5.3`, the upstream provider, model and connection, the error message, the prompt, the body actually sent upstream, and one attempt with status 400

#### Scenario: Combo falls through two models
- **WHEN** a combo request fails on its first model with 502 and on its second with 400
- **THEN** the entry lists both attempts in order; its provider, upstream model and connection are those of the last attempt, and its status is the one the client received

#### Scenario: Stream dies half way
- **WHEN** a streamed response stops after 12 chunks because the upstream stalls
- **THEN** an entry with source `stream` and status 200 is stored with the number of chunks and bytes received before the failure

#### Scenario: Successful requests are not logged
- **WHEN** a request returns 200 and streams to the end
- **THEN** no entry is created

#### Scenario: Client disconnects
- **WHEN** a client gives up on a request before the upstream answered
- **THEN** no error log entry is written for it
