## 1. Implementation
- [x] 1.1 `parseQoderCatalog`: `chat` then `assistant` scene, first entry per key wins, scene counts returned
- [x] 1.2 On a forced catalog refresh (dashboard "Fetch Qoder Models", executor retry), log the model keys of every scene the server published

## 2. Tests
- [x] 2.1 `test/qoder-catalog-scenes.test.js`: assistant models listed and routable, chat entry wins, other scenes ignored, IDE-only shape unchanged, scene keys reported; a chat request for an assistant-only key sends that entry as `model_config`
- [ ] 2.2 Live check on the owner's server (after deploy): "Fetch Qoder Models", read the `model catalog:` log line to see which scene holds DeepSeek/GLM, then send one chat to that key. If they sit under `external_models`, open a follow-up change for `outerProviders`.
