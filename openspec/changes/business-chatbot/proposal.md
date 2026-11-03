## Why

The owner wants a second product line, "AI doanh nghiệp": a chatbot service that Vietnamese businesses can put in front of their own customers. Such a business needs three things the plain API resale does not give it:
- a bot that answers only within its business and from its own company data;
- a bot that cannot be tricked into wrong statements on Vietnamese sovereignty or into reactionary (phản động) political content;
- its own plans, pricing, keys and landing page.

Real fine-tuning is impossible on a proxy that forwards to third-party models. This change therefore delivers the safety as a server-side guard layer that a caller cannot switch off.

This is phase 1 of 3. Phase 2 (embeddable website widget) and phase 3 (Zalo OA and Facebook Messenger channels) are out of scope here.

## What Changes

**Plans are split into two product lines.**
- Every plan has a product line: `api` (the default, for existing plans) or `business`.
- Business plans also carry a maximum number of bots and a maximum knowledge-base size.
- The main landing page sells only `api` plans. The new `/doanh-nghiep` page sells only `business` plans.
- The customer plans page groups plans by line.

**Billing is isolated by product line.**
- A bot key is paid only by the owner's business-plan purchases.
- Every other customer key is paid only by `api` purchases, which include credit-only grants.
- Admission, rates and charging all apply this rule. Key-to-plan pinning keeps working.

**Business models are reserved.**
- The admin designates existing combos as business models, for example `delify-biz`.
- Bot keys may call only those models, and only through `/v1/chat/completions`.
- Every other customer key loses access to them.
- `/v1/models` follows the same rule.

**Bots.** A customer with a live business plan creates bots. Each bot has a name, company name, domain description, mode (`strict` or `flexible`), refusal message, extra instructions and a default business model. The number of bots is limited by the plan. Each bot owns its API keys.

**Knowledge base (RAG).**
- Input methods:
  - upload of PDF, DOCX, TXT or MD files, 10 MB per file at most;
  - pasted text;
  - question/answer pairs.
- Only extracted text is stored. It is chunked with overlap and embedded with an admin-chosen embedding model.
- Retrieval uses brute-force cosine similarity, returning the top 5 chunks above a relevance threshold.
- Document lifecycle: processing, ready, failed or stale. The customer can retry a failed or stale document.

**Guard pipeline on every business-model request.**
1. A deterministic keyword pre-check and a guard-model classification sort the input into `ok`, `sovereignty`, `political`, `injection` or `offtopic`.
2. A sovereignty question gets the admin's official-stance text, followed by a steer back to the business. Political and injection inputs are refused. Off-topic inputs get the bot's refusal message.
3. Otherwise, relevant chunks are retrieved and a locked system prompt is built. Client system messages are wrapped as business instructions that cannot override the rules.
4. The mapped model is called non-streaming.
5. A guard-model output check runs. A violating answer is replaced.
6. `stream: true` callers receive the final, checked text as OpenAI SSE chunks.

The pipeline fails closed: if the guard or embedding model is unavailable, the response is 503. Blocked questions are logged per bot.

**Admin.** A new "AI doanh nghiệp" settings page holds:
- the business model list;
- the guard model and embedding model;
- the official sovereignty text and the political refusal text;
- the relevance threshold.

It also lists all bots. The admin plan form edits the product line, bot limit and knowledge-base limit.

**Customer portal.** A new `/account/business` area has:
- a bot list and a bot editor;
- documents, keys and blocked-questions tabs for each bot;
- a playground that goes through the same pipeline and is billed like the API;
- an API code sample.

**Landing.** A new `/doanh-nghiep` page has:
- a hero with an auto-playing SVG pipeline in the delify.vn style: a comet dash runs along the connector and steps light up in sequence on a 7-second loop, with a ping dot. All animation is disabled under `prefers-reduced-motion`.
- feature and how-it-works sections, business plans read from the database, an FAQ, and a call to action.

The main navigation gains a "Doanh nghiệp" link.

**Schema** v27 → v28, additive only:
- new tables: `bizBots`, `bizDocuments`, `bizChunks`, `bizGuardEvents`;
- new columns: `plans.productLine`, `plans.maxBots`, `plans.maxKbBytes`, `apiKeys.botId`.

**New dependencies:** `unpdf` (PDF text extraction) and `mammoth` (DOCX text extraction).

## Capabilities

### New Capabilities
- `business-bots`: bots, bot keys, per-plan bot and knowledge-base quotas, the knowledge base (ingestion, chunking, embeddings, retrieval) and the customer portal area `/account/business`, including the playground and blocked-questions view.
- `business-guard`: the guard pipeline for business-model requests. It covers input classification, sovereignty, political, injection and off-topic handling, the locked system prompt, RAG context, the non-streaming call, the output check, SSE re-emission, fail-closed behaviour, guard event logging and the admin settings page "AI doanh nghiệp".
- `business-landing`: the `/doanh-nghiep` sales page with its animated pipeline hero and business plan cards.

### Modified Capabilities
- `plan-templates`: plans gain a product line, a bot limit and a knowledge-base limit, and the admin plan form edits them.
- `plan-queue-billing`: admission, rates and charging only consider purchases of the requesting key's product line.
- `api-access-enforcement`:
  - bot keys are limited to business models on `/v1/chat/completions`;
  - other customer keys can no longer reach business models;
  - model listing follows these rules;
  - new denial codes are added.
- `public-landing`: the main landing page lists only `api` plans and links to `/doanh-nghiep`.
- `customer-portal`: the plans page groups plans by product line, and the navigation gains "AI doanh nghiệp".

## Impact

- **Schema:** `src/lib/db/schema.js` (v28).
- **New repos:** `src/lib/db/repos/bizBotsRepo.js` and `bizDocumentsRepo.js`.
- **New modules** in `src/lib/biz/*`: chunking, embeddings, retrieval, guard, prompt, pipeline, ingestion worker, settings.
- **Billing:** `src/lib/billing/planQueue.js`, `src/lib/billing/rates.js`, `src/lib/db/repos/usageRepo.js` and `src/lib/auth/keyEnforcement.js` gain product-line scoping.
- **Request handling:**
  - `src/sse/handlers/chat.js` hands bot-key requests to the business pipeline;
  - the other `/v1` handlers refuse bot keys;
  - `/v1/models` filters its listing.
- **APIs:** new `src/app/api/account/biz/**` and `src/app/api/biz-settings/**` (admin).
- **Admin UI:** dashboard page `dashboard/business`, a Sidebar entry and the plan form.
- **Customer UI:** `/account/business/**` and an `AccountShell` nav entry.
- **Landing:** `src/app/doanh-nghiep/page.js` plus landing components. `LandingPage.js` and `Navigation.js` filter plans and add the link.
- **Background work:** an ingestion worker is started from `runHeavyStartup`.
- **Dependencies:** `unpdf` and `mammoth`.
- **Future phases (not in this change):**
  - Phase 2: an embeddable website widget.
  - Phase 3: Zalo OA and Messenger channels. Zalo requires the business's OA to be on the paid "Tăng trưởng" tier or higher; tokens rotate and replies are limited to a 48-hour window. For Messenger, each business uses its own Meta app.
