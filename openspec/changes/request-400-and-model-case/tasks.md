## 1. Request-scoped validation errors

- [x] 1.1 `errorConfig.js`: `REQUEST_ERROR_RULES.validation` (patterns, account markers)
- [x] 1.1b Account markers cover quota, region/country, access, disabled/suspended/blocked/restricted, revoked/invalid key, terms (a field name such as `prompt_cache_key` is still the request's)
- [x] 1.2 `accountFallback.js`: `isRequestError` recognises a validation rejection unless an account marker is present
- [x] 1.3 Tests in `test/upstream-errors.test.js`: the exact deepseek `tool_choice` answer, param-only, type-only, 422, null param, account-marker cases, credit rule precedence, other statuses unchanged ← (verify: bad key / Gemini `API key not valid` still locks the account; combo still moves on)

## 2. Case-insensitive combo names

- [x] 2.1 `combosRepo.js`: `canonicalComboName(Sync)` (exact, then unique NOCASE, else unchanged) and `findComboByNameIgnoringCase`
- [x] 2.2 Canonicalise where each handler reads the model: chat (also rewrites `body.model`), embeddings, imageGeneration (also `ctx.publicName`, which masks the response), tts, stt, videoGeneration, search, fetch
- [x] 2.3 Combo create / rename refuse a name that differs from another only by case; saving a combo under its own name is not a rename
- [x] 2.4 `test/model-case.test.js`: all spellings, non-combo and provider ids untouched, exact wins, ambiguity, collision check, customer allowed vs upstream refused, handler logs the combo's own spelling ← (verify: handler test fails without the chat.js change)

## 3. Checks

- [x] 3.1 `npm test` (1540 tests: all pass but the intermittent `client-abort` timing test, which passes alone), eslint on touched files clean; build run on the stacked branch
