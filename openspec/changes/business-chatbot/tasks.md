## 1. Setup and schema

- [x] 1.1 Run `npm ci` in the worktree, then add the dependencies `unpdf` and `mammoth` (exact versions in package.json and package-lock).
- [x] 1.2 Schema v28 in `src/lib/db/schema.js`:
  - new columns: `plans.productLine` (`TEXT DEFAULT 'api'`), `plans.maxBots`, `plans.maxKbBytes`, `apiKeys.botId` plus its index;
  - new tables: `bizBots`, `bizDocuments`, `bizChunks`, `bizGuardEvents`, with the indexes from design D9;
  - bump `SCHEMA_VERSION` to 28. ← (verify: additive only, an existing DB syncs, existing plans read productLine 'api')

## 2. Plans and product-line billing

- [ ] 2.1 Plan API validation and storage of `productLine`, `maxBots` and `maxKbBytes` (`/api/plans`, `/api/plans/[id]`, billingRepo). Business plans require both limits; api plans store NULL.
- [ ] 2.2 Admin plan form: "Dòng sản phẩm" selector, the business inputs (MB → bytes) with inline validation, and a product-line text badge in the plan list.
- [ ] 2.3 Product-line scoping:
  - `listQueueSync` exposes `productLine`;
  - `scopeQueue(queue, planId, productLine)`, where credit-only grants count as `api`;
  - optional `productLine` on `admitSync`, `chargeSync`, `payingRatesSync` and `ratePlanIdSync`.
- [ ] 2.4 Pass the key's line (`botId` → `business`) at every call site: `keyEnforcement.js`, `usageRepo.js` (rate plan and charge), `api/usage/key/route.js`, `api/account/plans/route.js`. In keyEnforcement, choose the business 402 message by line.
- [ ] 2.5 Unit tests for the line rules:
  - a bot key with only an api purchase gets 402 with the business message;
  - an api key never drains a business purchase;
  - gift credit counts as api;
  - pinning still narrows within the line;
  - the charge never crosses lines. ← (verify: every queue walk goes through scopeQueue with the line; no call site missed — grep admitSync/chargeSync/payingRatesSync/ratePlanIdSync)

## 3. Bot keys and access enforcement

- [ ] 3.1 `getApiKeyForAuth` returns `botId` and the bot's `isActive`. `createApiKey` accepts `botId`.
- [ ] 3.2 Business settings module `src/lib/biz/settings.js`: defaults, read and validate (combos must exist, no duplicates).
- [ ] 3.3 `enforceKeyAccess` changes:
  - add an `endpoint` option;
  - a bot key gets `endpoint_not_allowed` on non-chat kinds and `bot_disabled` when its bot is inactive;
  - a bot key is allowed exactly the business models;
  - business models are excluded for every other customer key.
  Wire the endpoint kind into every `/v1` handler: chat, messages, responses, embeddings, images, audio (tts, stt), search, fetch, videos.
- [ ] 3.4 `/v1/models` (and the kind listings): a bot key sees only business models; other customer keys see their group's models minus business models.
- [ ] 3.5 Customer key list (`/api/account/keys` and its `[id]` routes) hides `botId` keys and refuses to create or delete them.
- [ ] 3.6 Unit tests for the access rules: normal key on a business model → 403 `model_not_allowed`; bot key on another model → 403; bot key on `/v1/messages` → 403 `endpoint_not_allowed`; disabled bot → 403 `bot_disabled`; listings for both key types. ← (verify: denials use the platform error format and are logged as platform denials)

## 4. Bots, quota and knowledge base (server)

- [ ] 4.1 `bizBotsRepo.js`:
  - CRUD with field validation (Vietnamese messages);
  - quota computation (`maxBots`, `maxKbBytes`, `kbBytesUsed`, `hasBusinessPlan`) over live business purchases;
  - cascade delete of keys, documents, chunks and events in one transaction.
- [ ] 4.2 Pure modules with relative imports:
  - `src/lib/biz/chunking.js`: paragraph split, 1,000 characters with 200 overlap, long-paragraph split, Q&A chunks;
  - `src/lib/biz/vector.js`: Float32 BLOB encode/decode, cosine, top-k with threshold.
- [ ] 4.3 `src/lib/biz/extract.js`:
  - PDF via unpdf, DOCX via mammoth, TXT and MD via UTF-8;
  - 10 MB check → 413, unsupported type → 415;
  - fewer than 20 non-whitespace characters → failed document with the scan message.
- [ ] 4.4 `bizDocumentsRepo.js`:
  - create a document plus its chunks in one transaction (KB quota → 413);
  - list with computed `stale` status;
  - delete; retry (409 unless failed or stale).
- [ ] 4.5 `src/lib/biz/internalCall.js`:
  - guard chat call and embeddings call through `handleChat` / `handleEmbeddings` with the default admin key;
  - 15-second timeout;
  - throws `GuardUnavailableError` on any failure.
- [ ] 4.6 `src/lib/biz/ingestWorker.js`:
  - kick plus 30-second sweep, batches of 32;
  - sets the document ready or failed;
  - resumes `processing` documents at startup;
  - `globalThis` guard and build-phase skip;
  - started from `runHeavyStartup`.
- [ ] 4.7 `src/lib/biz/retrieval.js`: embed the question, scan the bot's chunks for the current model, return the top 5 at or above the threshold, with an LRU vector cache (200 MB cap) invalidated on document or model change.
- [ ] 4.8 Customer APIs under `src/app/api/account/biz/`:
  - `quota`; `bots`; `bots/[id]`;
  - `keys`, `keys/[keyId]`, `keys/[keyId]/secret` (owner only, no-store, 60/min);
  - `documents` (multipart / text / qa), `documents/[docId]`, `retry`;
  - `guard-events`.
  All require a customer session; another user's bot answers 404.
- [ ] 4.9 Unit tests:
  - chunking (long text, overlap, Q&A);
  - cosine top-k (the threshold scenario from the spec);
  - quota (max over live business purchases, expired plan);
  - bot over quota → 403;
  - cascade delete;
  - KB over size → 413; unsupported type → 415; scan PDF → failed;
  - embedding failure → failed with chunks kept;
  - model change → stale. ← (verify: spec business-bots scenarios each have a test)

## 5. Guard pipeline

- [ ] 5.1 `src/lib/biz/guard.js`:
  - normalisation (NFD, đ→d) and the keyword lists;
  - `classifyInput`: pre-check, then the guard model with the last 4 messages;
  - JSON parser that accepts code fences and rejects unknown categories;
  - `checkOutput`.
- [ ] 5.2 `src/lib/biz/prompt.js`:
  - message normalisation: text only; drop tools, `tool_choice`, `functions`, `response_format` and non-text parts; collect system/developer messages;
  - `buildLockedSystemPrompt` in the spec order, with the wrapped business instructions and numbered chunks.
- [ ] 5.3 `src/lib/biz/reply.js`: guarded reply texts per category, plus JSON `chat.completion` and SSE chunk sequence (role chunk, content chunks, stop chunk, `[DONE]`), with the `X-Guard-Category` header and zero usage.
- [ ] 5.4 `src/lib/biz/pipeline.js` `runBusinessPipeline`:
  - classify → guarded reply or retrieval;
  - strict mode with no context → refusal;
  - inject the locked prompt (systemInject) → `dispatch` non-streaming → output check → format;
  - 503 `guard_unavailable` on missing settings or guard/embedding failure;
  - guard events recorded;
  - guarded-reply limiter per key (plan RPM or 60).
- [ ] 5.5 Hook into `src/sse/handlers/chat.js`: after `enforceKeyAccess`, a bot key goes through `runBusinessPipeline`, with `dispatch` = the existing combo branch forced to `stream: false`. Upstream errors pass through unchanged.
- [ ] 5.6 Admin settings API `GET`/`PATCH /api/biz-settings` (dashboard session) with validation.
- [ ] 5.7 Unit tests for guard parsing (fenced JSON, malformed → unavailable, unknown category), normalisation and keywords, prompt order and wrapping, and the SSE formatter.
- [ ] 5.8 Integration test of the business chat handler with a stubbed upstream and guard. Cases:
  - sovereignty (no model call, not charged);
  - political, injection, off-topic;
  - strict mode with no documents;
  - an ok answer that is charged like the combo;
  - output violation replaced (still charged);
  - guard failure → 503;
  - missing settings → 503;
  - `stream: true` produces SSE ending with `[DONE]`. ← (verify: no path returns unguarded model text; guarded replies are free; charges equal normal combo pricing)

## 6. Admin UI

- [ ] 6.1 Dashboard page "AI doanh nghiệp" (`src/app/(dashboard)/dashboard/business/`) and a Sidebar item. The page contains:
  - the business model list editor (combo picker plus label);
  - guard model and embedding model inputs;
  - sovereignty and political texts;
  - threshold;
  - the "requests answer 503 until set" warning;
  - a warning before changing the embedding model.
- [ ] 6.2 Admin bot overview: owner email, bot/company, model, active as text, document counts by status, blocked count over 7 days. Read through an admin API `GET /api/biz-settings/bots`.

## 7. Customer UI

- [ ] 7.1 AccountShell nav item "AI doanh nghiệp" (`/account/business`) between "API key" and "Lịch sử dùng".
- [ ] 7.2 `/account/plans` groups plans under "Gói API" and "Gói AI doanh nghiệp", with the business lines "Tối đa N bot" and "Dung lượng tài liệu X". `?plan=` highlighting must keep working.
- [ ] 7.3 `/account/business`:
  - quota line, bot list and create form;
  - no-plan notice linking to `/doanh-nghiep`, with the create button disabled and the reason shown;
  - loading, empty and error states with retry.
- [ ] 7.4 `/account/business/[id]` with these tabs:
  - **Cài đặt**: edit, plus delete with confirmation.
  - **Tài liệu**: upload, text and Q&A forms; status with icon and text; error text; retry and delete.
  - **Key API**: create with the secret shown once, reveal/copy through the secret endpoint, delete, and a code sample with the base URL and model.
  - **Câu hỏi bị chặn**.
  - **Chat thử**: playground through `POST /api/account/biz/bots/[id]/chat` with the "Chat thử" key; guarded replies are labelled with their category.
  Keyboard reachable, visible focus, ui-dna. ← (verify: every list and form has loading/empty/error/disabled states; no colour-only status)

## 8. Landing

- [ ] 8.1 `Navigation` accepts an `items` prop. The main landing nav adds "Doanh nghiệp" → `/doanh-nghiep`.
- [ ] 8.2 The main `LandingPage` lists only `productLine = api` plans. The model catalogue still takes those plan ids.
- [ ] 8.3 `src/app/doanh-nghiep/page.js` with metadata, and the sections in the spec order:
  - hero with CTAs (session-aware link);
  - features, how it works, FAQ, closing CTA;
  - the business plans section reusing the salesData/PlansSection patterns, plus the bot and size lines and the empty state "Gói doanh nghiệp sắp mở bán".
- [ ] 8.4 `PipelineDiagram`:
  - inline SVG with five chips, `aria-hidden`, plus visually hidden step text;
  - comet `stroke-dashoffset`, chip highlight sequence and ping dot, all `7s linear infinite`;
  - everything disabled under `prefers-reduced-motion`;
  - theme tokens, AA contrast in light and dark. ← (verify: reduced-motion disables all animation; diagram matches ui-dna — square, 1px, no shadow/gradient)

## 9. End-to-end and checks

- [ ] 9.1 Playwright E2E against the standalone build, with a stubbed upstream or an admin-configured fake combo:
  - `/doanh-nghiep` renders five steps and the animation is running;
  - with reduced motion, no animation;
  - a customer with a business plan creates a bot, uploads a TXT, sees it ready, and gets a reply from the playground.
- [ ] 9.2 `npm test`, `npm run lint` and `npm run build` all pass. ← (verify: whole change against all specs; no regressions in existing billing/access tests)
