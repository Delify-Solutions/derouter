## Context

See proposal.md for motivation, and the specs for the behaviour contract. The parts of the current system this design leans on are:

- **Chat entry.** `/v1/chat/completions` → `src/sse/handlers/chat.js` `handleChatRequest`:
  1. `enforceKeyAccess(apiKey, model)`: key lookup, account status, group allow-list, rates, concurrency cap and admission.
  2. combo / single-model dispatch into `handleChatCore`.
  3. usage history.
  4. `chargeSync`, which runs from `usageRepo` when usage is recorded.
- **Pricing.** Combos are priced by name through `comboPricingRepo`, which is checked first in `resolvePrice`. Unpriced models are refused for customer keys (`refuseUnpricedModelResponse`).
- **Plan queue.** `src/lib/billing/planQueue.js`:
  - `listQueueSync` → `scopeQueue(queue, planId)` → `admitSync` / `chargeSync`;
  - `payingRatesSync` in `rates.js`;
  - `ratePlanIdSync` and `chargeSync` call sites in `usageRepo.js`.
  - Every queue walk funnels through `scopeQueue`.
- **Prompt injection helper.** `open-sse/rtk/systemInject.js` injects a system prompt into any wire format.
- **Web-chat key pattern.** `src/lib/account/chatKey.js` runs the web chat through a real customer key, so every rule applies.
- **Background job pattern.** `expiry.js` / `planReminders.js` use a `globalThis` guard, unref'd timers, a build-phase skip, and are started from `runHeavyStartup` in `src/shared/services/initializeApp.js`.
- **Storage.** SQLite through `getAdapter()`. Transactions are synchronous. The schema is additive through `TABLES` plus a `SCHEMA_VERSION` bump.

## Goals / Non-Goals

**Goals:**
- One choke point per concern:
  - product-line scoping inside `scopeQueue`;
  - bot-key model and endpoint rules inside key enforcement;
  - the business pipeline as a single wrapper around the existing combo dispatch.
- The main model call stays a normal router request: same pricing, usage, request details, error log and charge. No parallel billing path.
- Pure, unit-testable modules for chunking, cosine, classifier parsing, prompt building and SSE re-emission, using relative imports only.

**Non-Goals:**
- A vector database or SQLite vector extension.
- Streaming tokens through to the client. The output check needs the whole answer.
- Per-document original-file storage.
- Per-bot model fine-tuning.
- The widget, Zalo and Messenger (phases 2 and 3).
- Editable `/doanh-nghiep` copy. The copy is fixed in code in this phase.

## Decisions

### D1. A business model *is* a combo, flagged in settings
`businessModels: [{id, label}]` lists combo names. Consequences:
- The request's `model` stays the combo name all the way through, so combo pricing, `refuseUnpricedModel`, usage and analytics need no change.
- Reservation comes from the flag: the group allow-list check excludes these ids for non-bot keys, and allows exactly these ids for bot keys.

*Alternative: a new alias table mapping a public id to a target.* Rejected. It would need its own pricing resolution and usage attribution.

### D2. Product line resolved from the key, applied in `scopeQueue`
- `scopeQueue(queue, planId, productLine)` filters entries by `plans.productLine`. `listQueueSync` must expose it: join `plans` and select `p.productLine`.
- Credit-only grants (`planId IS NULL`) count as `api`.
- `admitSync`, `chargeSync`, `payingRatesSync` and `ratePlanIdSync` gain an optional `productLine` (default `api`). Their call sites in `keyEnforcement.js`, `usageRepo.js`, `api/usage/key/route.js` and `api/account/plans/route.js` pass `key.botId ? 'business' : 'api'`.
- The default `api` keeps today's behaviour for existing data, because every existing plan reads as `api`.
- The 402 message is chosen by line in `keyEnforcement` (spec plan-queue-billing).

*Alternative: separate wallets or tables per line.* Rejected. It would duplicate the queue engine.

### D3. Bot-key detection and endpoint fence
`getApiKeyForAuth` already returns the key row. Add `botId` to what it returns, and resolve the bot's `isActive`.

`enforceKeyAccess` gains `{ endpoint }`:
- Chat passes `chat`.
- Other handlers (messages, responses, embeddings, images, audio, search, fetch, videos) pass their kind.
- A bot key on any non-chat kind gets `endpoint_not_allowed`.
- `/v1/models` filters through the same rule.

The fence lives in the shared enforcement function, so no handler can forget it.

### D4. Pipeline placement: wrap the combo dispatch inside `handleChatRequest`
After `enforceKeyAccess` passes and the key is a bot key, `chat.js` calls `runBusinessPipeline({ body, key, bot, settings, dispatch })`. `dispatch(bodyForModel)` is a closure over the existing combo branch with `stream: false`. The pipeline:
1. Normalises the messages: text only; strips tools, `response_format` and non-text parts; collects client system/developer messages.
2. `classifyInput`: keyword pre-check, then a guard-model call.
3. Returns a guarded reply (no dispatch) for `sovereignty`, `political`, `injection` and `offtopic`.
4. Calls `retrieve` (embedding call plus cosine over the bot's chunks).
5. For a strict bot with no hits, returns the refusal (category `strict_no_context`).
6. `buildLockedSystemPrompt` + `injectSystemPrompt` (from `systemInject.js`) on an OpenAI-shaped body.
7. `dispatch(body)` → reads the JSON response. Non-2xx upstream errors pass through unchanged, as the normal path does.
8. `checkOutput` with the guard model.
9. `formatReply(text, { stream, model, category, usage })` builds a JSON `chat.completion`, or an SSE `chat.completion.chunk` sequence ending with `[DONE]`.

Because `dispatch` reuses the existing path, usage and charging happen exactly as for a normal combo request.

### D5. Internal guard and embedding calls use the default admin key
`src/lib/biz/internalCall.js` builds a server-side `Request` with `Authorization: Bearer <default admin key>` (`ensureDefaultAdminKey`) and calls `handleChat` / `handleEmbeddings` directly:
- No HTTP hop.
- Admin keys bypass admission, so these calls are free to the customer.
- They still appear in usage under the admin key, so the operator can see what the guard costs.
- The guard call uses `temperature: 0`, `max_tokens: 200` and `stream: false`, with a 15-second timeout via `AbortController`.

Any non-2xx response, timeout or unparseable JSON throws `GuardUnavailableError`. The pipeline maps that error to 503 `guard_unavailable`.

*Alternative: calling providers directly.* Rejected. It would bypass combos, fallbacks and the credentials the router already manages.

### D6. Classifier contract
The guard system prompt describes the five categories and demands strict JSON. The parser:
- accepts plain JSON or JSON inside a code fence;
- takes the first `{…}` object;
- validates `category` against the enum.

Anything else is unavailable, which fails closed.

The output check uses its own prompt and returns `{verdict, category}`.

Normalisation for the keyword pre-check is NFD, stripping combining marks, mapping `đ`→`d`, lower case and collapsing whitespace. Phrases are matched as whole-word substrings.

### D7. Retrieval in JS
- Chunks store `embedding` as a Float32 `BLOB`, plus `embeddingModel` and `dims`.
- Retrieval loads the bot's chunks for the current model (`SELECT id, text, embedding FROM bizChunks WHERE botId=? AND embeddingModel=?`), computes cosine, and keeps the top 5 at or above the threshold.
- Scale bound: at 1,000-character chunks, 10 MB of text ≈ 10k chunks; at 1,536 dims that is ≈ 61 MB of floats per scan. That is acceptable at phase-1 plan sizes.
- An in-process LRU cache per bot holds decoded `Float32Array`s. It is invalidated on any document change for that bot or on an embedding model change.

*Alternative: `sqlite-vec`.* Rejected for now: native extension packaging inside the Docker image.

### D8. Ingestion
- Text extraction runs inside the upload request:
  - `unpdf` `extractText` for PDF;
  - `mammoth.extractRawText` for DOCX;
  - UTF-8 decode for TXT and MD.
- Quota is checked against the UTF-8 byte length of the extracted text.
- The document row and its chunks (embedding NULL) are written in one transaction. The response is 202.
- The ingestion worker (`src/lib/biz/ingestWorker.js`, started from `runHeavyStartup`, skipped during the build phase):
  - is woken by an in-process kick, with a 30-second sweep as fallback;
  - embeds the `processing` documents' chunks in batches of 32;
  - sets the document `ready` or `failed`;
  - on startup, resumes documents still in `processing`.
- Stale status is computed on read: the document has a chunk whose `embeddingModel` ≠ the current setting. It is not stored.
- Retry clears the error, sets the document to `processing` and kicks the worker.

Multipart parsing uses `request.formData()` (Next 16 route handlers). The size check uses `file.size` before reading the bytes.

### D9. Schema (v28)
New tables:

| Table | Columns | Indexes |
|---|---|---|
| `bizBots` | id, userId, name, companyName, domainDescription, mode, refusalMessage, extraInstructions, modelId, isActive, createdAt, updatedAt | `(userId)` |
| `bizDocuments` | id, botId, userId, title, sourceType, mime, bytes, status, error, chunkCount, createdAt, updatedAt | `(botId, createdAt)` |
| `bizChunks` | id INTEGER PK AUTOINCREMENT, docId, botId, ord, text, embedding BLOB, embeddingModel, dims | `(botId, embeddingModel)`, `(docId)` |
| `bizGuardEvents` | id INTEGER PK AUTOINCREMENT, botId, apiKeyId, category, excerpt, createdAt | `(botId, createdAt DESC)` |

New columns:
- `plans.productLine` (`TEXT DEFAULT 'api'`), `plans.maxBots` (INTEGER), `plans.maxKbBytes` (INTEGER);
- `apiKeys.botId` (TEXT) with index `(botId)`.

All of this is additive, so no versioned migration is needed.

### D10. Settings storage
The business settings live in the existing settings blob under `business`, read through `src/lib/biz/settings.js`, which applies defaults. Admin API: `GET`/`PATCH /api/biz-settings` (dashboard session). Combo existence is checked against `getCombos()`.

### D11. Guarded-reply limiter
An in-process sliding window per bot key. The limit is the paying plan's RPM (from `payingRatesSync` with the business line), or 60 when unset. It reuses the pattern in `src/lib/auth/actionLimiter.js`. It counts only guarded replies; model calls are already counted through usage.

### D12. Landing animation
`src/app/doanh-nghiep/components/PipelineDiagram.js` is a server component rendering inline SVG, with CSS in a component-scoped stylesheet. Animations, all `7s linear infinite`:
- `@keyframes biz-comet` animates `stroke-dashoffset` on a dash-array path whose visible segment is short;
- per-chip keyframes switch stroke and icon colour at 0%, 20%, 40%, 60% and 80% of the cycle;
- `biz-ping` scales and fades the dot.

`@media (prefers-reduced-motion: reduce) { * { animation: none !important } }` is scoped to the diagram. Colours come from theme tokens (`text-main`, `border`, `brand-*`). There are no gradients or shadows.

`Navigation` gains an optional `items` prop so `/doanh-nghiep` can show its own anchors plus a link back to `/`. The main landing's items gain "Doanh nghiệp".

### D13. Customer area
- **Pages:** `src/app/account/business/page.js` and `src/app/account/business/[id]/page.js`, both client components using the `ui.js` primitives.
- **APIs** under `src/app/api/account/biz/`: `quota`, `bots`, `bots/[id]`, `bots/[id]/keys`, `bots/[id]/keys/[keyId]`, `bots/[id]/keys/[keyId]/secret`, `bots/[id]/documents`, `bots/[id]/documents/[docId]`, `bots/[id]/documents/[docId]/retry`, `bots/[id]/guard-events`, `bots/[id]/chat`.
- **Playground:** uses the per-bot key "Chat thử", following the `ensureChatKey` pattern keyed by botId. It calls `handleChat` with a constructed `Request`, as `api/account/chat` does.
- **Key list:** `GET /api/account/keys` filters out `botId` keys, and its POST and DELETE refuse them.

## Risks / Trade-offs

- **[Guard model false positives block legitimate questions]** → The business sees blocked questions per bot and can tune `domainDescription`. The admin can switch the guard model. Sovereignty keywords are high-precision phrases only. Political content is left to the model, not to keywords such as "đảng", which collide with "đăng".
- **[Higher latency: two guard calls, one embedding call, no streaming]** → The guard uses `max_tokens` 200 and `temperature` 0, the latency is documented in the FAQ, and the SSE output still satisfies clients that require streaming.
- **[Guard costs borne by the operator]** → They are visible in usage under the admin key. The admin prices the business combos to cover them.
- **[Brute-force retrieval memory and CPU on large knowledge bases]** → The plan's `maxKbBytes` bounds it. The LRU cache is capped at 200 MB total of decoded vectors and evicts least-recently-used bots.
- **[Embedding model change invalidates every knowledge base]** → Stale status plus a retry action, and a warning on the admin settings page before saving a different model.
- **[In-process limiter and worker do not survive multi-instance deployments]** → Production runs a single container (host network), matching the existing in-process limiters.
- **[Keyword lists can be evaded with obfuscation]** → The guard model and output check are the second and third layers. The keyword list is only a fast path.

## Migration Plan

1. Deploy. Schema v28 auto-syncs, and a pre-migration backup is taken because the version was bumped. Every existing plan reads as `api`, so nothing changes for current customers.
2. Admin:
   - create a combo (for example `delify-biz`) and set its combo price;
   - open "AI doanh nghiệp" and set the business models, guard model and embedding model;
   - create business plans.
3. Until the guard and embedding models are set, bot requests answer 503. No unguarded path exists.

Rollback: redeploy the previous image. The new columns and tables are ignored by the old code.

## Open Questions

- Whether a future phase should let businesses edit the `sovereigntyAnswer` per bot. This phase keeps it admin-only, to keep the stance uniform.
