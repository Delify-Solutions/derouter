## 1. Implementation
- [x] 1.1 `parseQoderCatalog`: `chat` then `assistant` scene, first entry per key wins, scene counts returned
- [x] 1.2 On a forced catalog refresh (dashboard "Fetch Qoder Models", executor retry), log the model keys of every scene the server published

## 2. Tests
- [x] 2.1 `test/qoder-catalog-scenes.test.js`: assistant models listed and routable, chat entry wins, other scenes ignored, IDE-only shape unchanged, scene keys reported; a chat request for an assistant-only key sends that entry as `model_config`
- [x] 2.2 Live catalog check on the owner's server (2026-11-20, revision eb13ac14). The catalog publishes chat, assistant, inline, quest, nap, qwork, experts, qwake, app, qcode, byok_teams and byok_enterprise. `chat` and `assistant` hold the same 14 keys. DeepSeek and GLM are there under Qoder's code names (`dmodel`/`dfmodel`, `gmodel`/`gfmodel`), not under `external_models`. The owner's missing models were a provider-page problem (follow-up change `qoder-live-catalog-page`).
- [ ] 2.3 Live chat check: send one request to `dmodel` and one to `gmodel` and confirm the answering model
