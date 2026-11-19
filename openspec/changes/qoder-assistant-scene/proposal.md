## Why

The owner signs in to Qoder (intl) through the browser. Quota works, but the model list fetched for those accounts lacks the newer models such as DeepSeek and GLM.

The Qoder app 0.5.14 (its agent SDK worker, `qoder-worker-runtime.obf.mjs`) reads the same `GET /algo/api/v2/model/list`. It treats the body as an object keyed by scene, and takes its default scene `assistant` (constant `DEFAULT_SCENE = "assistant"`, `client_type "5"`, `business_product "cli"`). The router, written for the IDE, reads only `body.chat`. Models published only in `assistant` were therefore dropped.

## What Changes

- `parseQoderCatalog(body)` (`open-sse/services/qoderModels.js`) reads the `chat` scene, then `assistant`. A key present in both keeps its `chat` entry. Other scenes are not read:
  - `quest` and `service_account` belong to other products and account kinds;
  - `byok_enterprise` is enterprise bring-your-own-key;
  - `external_models` returns only providers named in the request's `outerProviders`.
- The parser returns the model keys of every array-valued key. On a forced refresh (the "Fetch Qoder Models" button, the executor's retry) they are logged ("model catalog: N models; scenes {...}"), so the server log shows which scene holds which model. This is needed because no live account was available while writing the change. Keys and display names are not secrets.
- Chat already sends the catalog entry as `model_config` (the app does the same, `FCa`). An `assistant` model is routed with its own entry.

## Not changed
- Request signing stays COSY. The app signs this call with a new WASM signer, but the server still answers COSY-signed requests, because quota and the `chat` scene work.
- No device identity is changed. The DeepAI per-account machine-id scheme is not applied to Qoder.

## Capabilities
### New Capabilities
- `provider-qoder` (only this requirement; the rest of Qoder is not yet specified)

## Impact
- No schema change. `open-sse/services/qoderModels.js`, `src/app/api/providers/[id]/models/route.js`, `test/qoder-catalog-scenes.test.js`.
