## 1. Implementation
- [x] 1.1 `deepaiClient`: keep `theosPerRequest` / `premier` from the catalog, `isDeepAIModelMetered`, `resolveDeepAIModels({ forceRefresh })`, `fetchDeepAIIsPro` (`/get_usage_summary`)
- [x] 1.2 `usage/deepai.js` + `USAGE_HANDLERS.deepai` + registry `features.usage`: Theos bar, plan, free/metered summary
- [x] 1.3 Quota card: plan label for any provider reporting one; DeepAI model summary
- [x] 1.4 `DeepAIExecutor.parseError`: exhausted answers → `resetsAtMs` = now + 30 min (model lock); heavy load unchanged
- [x] 1.5 Provider page: live DeepAI catalog, "Tải model mới nhất" (`?refresh=1`), Free / Theos / Premium badges

- [x] 1.6 Verify fixes: `/get_usage_summary` at the API origin; quota read shares the single in-flight `/theos`; balance without a grant stated as text; "unknown" plans hidden

## 2. Tests
- [x] 2.1 `test/deepai-usage.test.js` (loopback DeepAI server): Theos bar and credit fallback, plan precedence, catalog prices, exhausted vs busy errors, dispatcher, forced refresh, single-flight /theos, error pipeline → per-model lock
- [x] 2.2 `npm test`, `npm run lint`
