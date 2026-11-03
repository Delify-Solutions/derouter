# Handoff: business-chatbot (phase 1)

Read this file first, then `proposal.md` → `specs/**` → `design.md` → `tasks.md` in this folder. The specs are the contract. `design.md` explains how. `tasks.md` is the checklist: tick `- [x]` as you go.

## Workspace

- Git worktree: `/Users/duogxaolin/orca/router-biz`, branch `feat/business-chatbot`, created from `origin/main` at `3ad2239`.
- `node_modules` is installed (`npm ci` was run).
- Nothing is committed. Everything listed below is uncommitted work in the tree.
- `openspec validate business-chatbot --strict` passes.

## Rules (from CLAUDE.md, mandatory)

- **Git and files**
  - Do not commit, push or open a PR unless the owner asks.
  - Never push to `main`; every push to main publishes the production image.
  - Do not touch `README.md` or `mint.mjs`.
- **Language**
  - Code, comments, commits and OpenSpec: English.
  - All UI text: Vietnamese.
  - Talk to the owner in Vietnamese.
- **Next.js 16**
  - Read `node_modules/next/dist/docs/01-app/` before writing routes or pages.
  - Route `params` is a Promise: `const { id } = await params`.
- **Money:** integer nano-USD (`src/shared/utils/money.js`). Never use floats for balances.
- **SQLite**
  - `db.transaction(fn)` is synchronous. Never `await` inside it.
  - Helpers that run inside a transaction take `db` first and end in `Sync`.
- **Schema:** additive through `TABLES` in `src/lib/db/schema.js`. It is already bumped to **28**; do not bump it again unless you add another schema change.
- **Tests:** anything a test imports must use **relative imports**, not `@/` and not bare `open-sse/...`. Tests set `DATA_DIR` to a temp dir before importing `src/lib/db/driver.js`. Patterns are in `test/billing.test.js` and `test/telegram-notify.test.js`. In tests, seed prices with `updatePricing`.
- **UI:** follows `openspec/ui-dna.md`: square corners, 1px borders, mono numbers, no shadows or gradients, WCAG AA, no colour-only status.
- **Secrets**
  - Store secrets through `encryptSecret` / `decryptSecret` (`src/lib/crypto/secrets.js`).
  - Never log URLs, headers or errors that contain secrets.
- **Background jobs:** copy the `src/lib/billing/expiry.js` / `src/lib/notify/planReminders.js` pattern: a `globalThis` guard, unref'd timers, a build-phase skip, and a start line in `runHeavyStartup` (`src/shared/services/initializeApp.js`).
- **Before every commit**, run `npm test`, `npm run lint` and `npm run build`, then `/verify` (the osf-verify agent).

## Owner decisions (locked)

- **Safety**
  - Safety is a 4-step guard layer, not real fine-tuning: a locked prompt, an input filter (keywords plus a guard LLM), RAG, and an output check.
  - **Sovereignty** (Hoàng Sa, Trường Sa, Biển Đông…): answer with the admin's official-stance text, then steer back to the business.
  - **Political / reactionary content and prompt injection:** refuse.
  - **Fail closed:** if the guard or embeddings are unavailable, return 503. There is never an unguarded answer.
- **Per-bot scope modes**
  - `strict`: answer only from documents; with no hit, reply with the refusal message.
  - `flexible`: greetings and general knowledge within the business domain are allowed.
- **Billing**
  - Billing uses the existing credit engine.
  - A bot key is paid only by business-plan purchases. Other keys are paid only by api purchases and credit-only grants.
  - Guard and embedding calls run on the default admin key and are not billed to the customer.
  - The business model **is an existing combo**, listed in the `businessModels` setting and priced through combo pricing.
- **Data:** PDF, DOCX, TXT and MD uploads up to 10 MB, plus pasted text and Q&A pairs. No URL crawling. Only the extracted text is stored, never the original file.
- **Pages:** the landing is at `/doanh-nghiep` on the same domain. The customer area is `/account/business`.
- **Phasing:** phase 2 (website widget) and phase 3 (Zalo OA + Messenger) are **out of scope**.

## Current state (what the previous agent finished)

| Task | State | Notes |
|---|---|---|
| 1.1 deps | ✅ done | `unpdf@2.1.0` and `mammoth@1.13.0` added to package.json and lock |
| 1.2 schema v28 | ✅ done | `plans.productLine/maxBots/maxKbBytes`, `apiKeys.botId` + index, `deletedApiKeys.botId`, tables `bizBots`, `bizDocuments`, `bizChunks`, `bizGuardEvents` |
| 2.1 plan API storage | 🟡 partly done | `billingRepo.js` covers `rowToPlan`, `normalizeProductLine`, `validateProductLineInput` (wired into `validatePlanInput`), `createPlan` and `updatePlanSync`. **Remaining:** a test only. Verify confirmed that POST passes the body straight to `createPlan` and that PATCH merges `{...current, ...patch}`, so an omitted `productLine` keeps the stored line. |
| 2.2 admin plan form | ❌ todo | |
| 2.3 scoping | ✅ done | `planQueue.js`: `listQueueSync` selects `p.productLine`; `rowToEntry.productLine` (a credit-only grant counts as api); `scopeQueue(queue, planId, productLine)`; `admitSync`, `chargeSync` and `ratePlanIdSync` take `productLine`; `productLineOfKey(key)` exported. `rates.js`: `payingRatesSync` takes `productLine`. |
| 2.4 call sites | 🟡 partly done | **Done:** `usageRepo.js` charge and rate plan (reads `botId` from the key row or its tombstone); `billingRepo.resolveApiKeyOwner` returns `botId`. **Remaining:** `src/lib/auth/keyEnforcement.js` (lines ~219–265: pass `productLine: productLineOfKey(key)` to `payingRatesSync` and `admitSync`; on a 402 for a bot key use the message key `insufficient_quota_business`), `src/app/api/usage/key/route.js:136`, `src/app/api/account/plans/route.js:33`, and `src/lib/db/repos/billingRepo.js:190` (`chargeSync` caller: check whether it needs a line). Then grep again for every caller. |
| 2.5 tests | ❌ todo | |
| 3.1 | ✅ mostly done | `apiKeysRepo.js`: `rowToKey.botId`; `createApiKey({botId})` (a bot key is never pinned); tombstone keeps `botId`; `getApiKeyForAuth` returns `bot: {id, isActive, modelId}`, and a missing bot or one with a different owner reads as inactive. |
| platform messages | ✅ done | `src/lib/auth/platformError.js` `PLATFORM_MESSAGES` gained `insufficient_quota_business`, `endpoint_not_allowed`, `bot_disabled`, `guard_unavailable`. **Still needed:** `typeForStatus` (`src/lib/auth/platformError.js:19-27`) derives `type` from the HTTP status and has no 503 case. Add `case 503: return "service_unavailable"` so that `guard_unavailable` meets the spec. The 403 and 402 cases already map correctly. |
| 3.2 → 9.2 | ❌ todo | Everything else in tasks.md |

Tasks 2.3 and 3.1 are deliberately left unticked in `tasks.md`: their code is done, but the tests (2.5, 3.6) are not written yet. Tick them once those tests pass.

The WIP checkpoint commit passed a verify with 0 CRITICAL findings and 831/831 tests passing. Run `git show --stat HEAD` to see exactly what exists.

## Key facts about the existing code (verified)

- **Chat entry:** `src/sse/handlers/chat.js` `handleChatRequest`.
  - It calls `enforceKeyAccess(apiKey, modelStr, { clientIp })` at about line 95.
  - Then `getComboInfo(modelStr)` → the combo branch (`handleComboChat` / fusion) or the single model → `handleChatCore`.
  - Usage and charging happen downstream in `usageRepo.saveRequestUsage` → `chargeSync`.
  - **Pipeline hook (design D4):** after `enforceKeyAccess` passes and the key is a bot key, run `runBusinessPipeline`. Its `dispatch` is a closure over the existing combo branch with `body.stream = false`.
- **Web chat pattern:** `src/app/api/account/chat/route.js` + `src/lib/account/chatKey.js`. These build a request and call `handleChat` with a real customer key. Copy this for the playground, using a per-bot key named "Chat thử" that is hidden from the bot's key list.
- **System prompt injection:** `open-sse/rtk/systemInject.js` `injectSystemPrompt(body, format, prompt)`.
- **Combo pricing:** `src/lib/db/repos/comboPricingRepo.js` (price by combo name, checked first in `resolvePrice`). Unpriced models are refused for customer keys (`refuseUnpricedModelResponse` in `src/sse/services/auth.js`). The admin must therefore price the business combo.
- **Embeddings:** `src/sse/handlers/embeddings.js` `handleEmbeddings`, wrapped with `withErrorLog`.
- **Default admin key** for internal guard and embedding calls: `ensureDefaultAdminKey(machineId)` in `src/lib/db/repos/apiKeysRepo.js`. Admin keys bypass admission.
- **Limiter pattern:** `src/lib/auth/actionLimiter.js`.
- **Landing**
  - `src/app/landing/components/LandingPage.js` uses `listPlans({ onlyActive: true })`; filter it to `productLine === 'api'`.
  - `Navigation.js` has hardcoded anchors (`#plans` …). Add an `items` prop and a "Doanh nghiệp" link.
  - Plan cards come from `salesData.js` `toSalesPlan` and `PlansSection.js`.
- **Account nav:** `src/app/account/components/AccountShell.js`. Order: Tổng quan, Chat, Gói của tôi, Nhật ký credit, Mã quà tặng, API key, **AI doanh nghiệp (new)**, Lịch sử dùng.
- **Account plans:** `src/app/api/account/plans/route.js` and `src/app/account/plans/`. Group plans under "Gói API" and "Gói AI doanh nghiệp".
- **Admin sidebar:** `src/shared/components/Sidebar.js`. The admin pages live under `src/app/(dashboard)/dashboard/`.
- **Animation reference:** the delify.vn CSS (`/_nuxt/entry.DyvIXRzJ.css`) uses an SVG path with `stroke-dasharray` and a `stroke-dashoffset` keyframe (a "comet"), chip stroke and icon colour keyframes switching at offsets within one 7-second linear infinite cycle, a ping dot, and `animation:none!important` under reduced motion. Recreate the idea; do not copy their assets.

## Remaining work, in order

Follow `tasks.md` groups 2 → 9. Summary:

1. **Finish group 2.**
   - Finish the plan API pass-through and the remaining call sites.
   - Build the admin plan form: a "Dòng sản phẩm" selector (API / AI doanh nghiệp), "Số bot tối đa" and "Dung lượng tài liệu (MB)", and a product-line badge in the plan list.
   - Write tests: test/biz-billing.test.js or similar.
2. **Group 3.**
   - `src/lib/biz/settings.js`: defaults are in spec business-guard "Business settings"; validate that combos exist.
   - In `enforceKeyAccess`:
     - an `endpoint` option, wired into every `/v1` handler;
     - `endpoint_not_allowed` and `bot_disabled`;
     - a bot key may call only business models;
     - business models are hidden from and refused for every other customer key.
   - `/v1/models` filtering.
   - Hide and refuse bot keys in `/api/account/keys`.
   - Tests.
3. **Group 4.**
   - `bizBotsRepo` (CRUD, quota, cascade delete).
   - Pure modules: `chunking.js`, `vector.js`.
   - `extract.js` (unpdf, mammoth).
   - `bizDocumentsRepo`.
   - `internalCall.js` (admin key, 15 s timeout, `GuardUnavailableError`).
   - `ingestWorker.js`.
   - `retrieval.js` (LRU cache).
   - The `/api/account/biz/**` routes.
   - Tests.
4. **Group 5.**
   - `guard.js`: normalisation (NFD, đ→d) and keyword lists from the spec, `classifyInput`, `checkOutput`, a JSON parser that tolerates code fences.
   - `prompt.js`: locked prompt in spec order, client system/developer messages wrapped.
   - `reply.js`: JSON or SSE output, `X-Guard-Category`, zero usage.
   - `pipeline.js` and its hook into `chat.js`.
   - Admin `/api/biz-settings`.
   - Unit tests and an integration test with a stubbed upstream.
5. **Group 6:** the admin page "AI doanh nghiệp" (settings plus a bot overview) and a Sidebar item.
6. **Group 7:** the account nav item, grouped plans, `/account/business`, and `/account/business/[id]` with tabs Cài đặt / Tài liệu / Key API / Câu hỏi bị chặn / Chat thử.
7. **Group 8:** the Navigation `items` prop, api-only plans on the main landing, the `/doanh-nghiep` page, and `PipelineDiagram`.
8. **Group 9 (E2E and checks).**
   - Install Playwright: `/Users/duogxaolin/.npm/_npx/e41f203b7505f1fb/node_modules/`.
   - Run `npm run build`, then `node .next/standalone/custom-server.js` with a temp `DATA_DIR` and the env vars `PORT`, `HOSTNAME=127.0.0.1`, `INITIAL_PASSWORD` and `DISABLE_TELEGRAM_REMINDERS=true`.
   - Admin JWT: sign it with jose using `DATA_DIR/jwt-secret`, payload `{authenticated:true}`, HS256.
   - The register form has two password fields; fill both.
   - Stub the upstream with a tiny local OpenAI-compatible HTTP server for chat and embeddings, configured as a provider connection plus a combo.
   - `npm test`, `npm run lint` and `npm run build` must all pass.

## Definition of done

- Every box in `tasks.md` is ticked, and every scenario in `specs/**` has a test or an E2E check.
- No path returns unguarded model text for a bot key.
- Guarded replies are free; model calls are charged exactly like the combo.
- No queue walk ignores the product line. Check with `grep -rn "admitSync\|chargeSync\|payingRatesSync\|ratePlanIdSync" src`.
- Existing tests still pass.
- `/verify` (osf-verify) reports zero CRITICAL findings.
- Then report to the owner in Vietnamese and wait to be told to commit.
