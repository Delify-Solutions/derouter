## Purpose

The 22 specialized provider executors that build upstream HTTP calls (auth headers, endpoint URL, body transform, streaming) for providers that do not conform to the plain OpenAI-compatible shape — including cursor (Connect-RPC protobuf), kiro (token refresh), codex, and the other CLI/web executors. Each implements the existing `ProviderExecutor` trait so the proxy `/v1/*` routes reach them via `select_executor`.

## ADDED Requirements

### Requirement: Executor trait implementation parity

Every ported executor MUST implement the existing `ProviderExecutor` trait (`stream` + `complete` → `UpstreamResponse`) with upstream HTTP behavior matching the Node executor it replaces (same endpoint URL construction, auth header scheme, request body transform, and response/stream decoding). The Rust `select_executor` MUST route each specialized provider id (and its aliases, e.g. `cu` → cursor, `gcli`/`gb` → grok-cli, `mmf` → mimo-free, `vertex-partner` → vertex) to the correct executor; unknown compatible providers MUST fall back to the existing OpenAI-compatible executor.

#### Scenario: cursor executor routes via alias
- **WHEN** a combo resolves a model to provider `cu` (cursor alias)
- **THEN** the request is handled by the CursorExecutor (same as provider `cursor`)

#### Scenario: unknown provider falls back
- **WHEN** a combo resolves to a provider id with no specialized executor and no OpenAI-compatible override
- **THEN** the request is handled by the OpenAI-compatible executor (the existing fallback)

### Requirement: Cursor executor with Connect-RPC protobuf framing

The cursor executor MUST construct the upstream request body using the Connect-RPC protobuf framing ported from `open-sse/utils/cursorProtobuf.js` (field encoding, envelope wrapping, GZIP/trailer flags) and MUST set the checksum headers ported from `open-sse/utils/cursorChecksum.js` (`buildCursorHeaders`). It MUST decode the upstream Connect-RPC frames back to SSE chunks the client expects (`chatChunkSse`/`sseChunk` shapes). Streaming MUST use http2 when available (mirroring Node's lazy `http2` import), falling back to reqwest http1 when not.

#### Scenario: cursor streaming request
- **WHEN** a client sends a streaming chat request whose combo resolves to provider `cursor`
- **THEN** the executor encodes the body as Connect-RPC protobuf, sets the checksum headers, sends it to the cursor upstream, decodes the frames, and returns an SSE stream of the same chunk shapes the Node cursor executor produces

### Requirement: Kiro executor with token refresh

The kiro executor MUST resolve models via the ported `kiroConstants` (resolveKiroModel) and MUST refresh the kiro access token via the ported `tokenRefresh` logic when the connection's token is expired or near-expiry, using the stored refresh credentials, before issuing the upstream call. The executor MUST produce the kiro event shapes (assistantResponseEvent, reasoningContentEvent, toolUseEvent, messageStopEvent, etc.) as SSE.

#### Scenario: kiro token expired
- **WHEN** a kiro connection's access token is expired and a request arrives
- **THEN** the executor refreshes the token from the stored refresh credentials, updates the connection, and proceeds with the upstream call (not a 401 to the client)

### Requirement: OAuth/CLI executor auth

The codex, gemini-cli, github, grok-cli, perplexity-web, iflow, qoder, trae, windsurf, zed, kimchi, codebuddy-cn/-intl executors MUST apply their provider-specific auth (OAuth bearer, API key, cookie, or signed headers) exactly as the Node executor does, reading credentials from the connection's `data` JSON. A missing required credential MUST surface as a clear 401/400 JSON error to the client (not a panic).

#### Scenario: missing oauth token
- **WHEN** a codex connection has no stored OAuth token and a request arrives
- **THEN** the response is an error indicating the missing credential (no upstream call is made, no panic)

### Requirement: Default executor for unrecognized compatible providers

The existing OpenAI-compatible executor MUST remain the fallback for any provider id without a specialized executor, preserving Phase 0-2 behavior for OpenAI/Anthropic-compatible and custom-embedding providers.

#### Scenario: openai-compatible provider
- **WHEN** a combo resolves to a provider id classified as OpenAI-compatible with no specialized executor
- **THEN** the request is handled by the OpenAI-compatible executor (baseUrl + apiKey from the connection)
