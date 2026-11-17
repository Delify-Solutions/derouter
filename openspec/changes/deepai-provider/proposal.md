## Why

The owner wants DeepAI Code (deepai.org, hosted models behind the DeepAI Code desktop app) as a provider, with several accounts added side by side like antigravity and codex. The protocol was read from the desktop app (v0.3.40); it is not a documented public API.

## What Changes

- **Provider `deepai`** (category free tier, OAuth only). Models: `glm-5.3-flash`, `deepseek-v4.1-flash`, `deepai-cyber`, `muse-ember`; the live catalog (`GET /deepai_code/models`) replaces the bundled list when reachable.
- **Sign-in**: the dashboard opens `api.deepai.org/deepai_code/desktop_auth/?state&port`; DeepAI redirects the browser to `127.0.0.1:<port>/auth-callback?code`. The hosted dashboard cannot receive loopback, so the admin pastes the callback URL; the code is exchanged (`POST .../desktop_auth/exchange/`) for a long-lived `api_key` stored encrypted as the connection's `accessToken`. No refresh token, no expiry. Each sign-in is its own connection, de-duplicated by username.
- **Requests**: `POST /deepai_code/chat/completions` (OpenAI format) with header `api-key`, lane header `X-DeepAI-Code-Theos`, and a per-account check-in nonce (`GET /deepai_code/theos`, renewed at half its lifetime, shared by concurrent requests, never blocking: a check-in has a 5 s timeout, a failed or refused one is not retried for 60 s, and the chat request still goes out and fails with DeepAI's own error).
- **Identity headers are deployment-level, never per account**: every account reports the same machine digest (this host's own identifier, or one id generated once and kept in the data dir) and the beacon carries only version and uptime. Presence signals the desktop app derives from a window (focus, agent activity) are omitted, as the app itself omits unknown facts.

## Non-goals

- No per-account machine ids, no synthetic focus/activity beacons, no attempt to bypass DeepAI's once-per-machine daily grant or its sponsored-content step. Accounts on one deployment therefore share one machine's daily allowance.
- Not an official, documented API: DeepAI may change or withdraw it, and its terms may restrict this use. The owner accepted that risk.
- No usage/allowance panel yet (`fetchDeepAIAllowance` exists for it).

## Capabilities

### New Capabilities
- `provider-deepai`

## Impact

- No schema change, no `SCHEMA_VERSION` bump.
- New: `open-sse/providers/registry/deepai.js`, `open-sse/executors/deepai.js`, `open-sse/services/deepaiClient.js`, `open-sse/services/deepaiAuth.js`, `src/lib/oauth/providers/deepai.js`, `test/deepai.test.js`.
- Changed: registry index, executors index, OAuth providers index/constants/exchange route, `OAuthModal.js` (redirect URI + paste), `/api/providers/[id]/models`, connection test, `/v1/models` live resolver.
