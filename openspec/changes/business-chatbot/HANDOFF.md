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

## Current state: every task is done

All groups in `tasks.md` are ticked. The E2E driver and its helpers live in
`scripts/biz-e2e*.mjs`; the unit and integration tests are
`test/biz-billing.test.js`, `test/biz-access.test.js`, `test/biz-knowledge.test.js`
and `test/biz-guard.test.js`.

A review of the whole change found one CRITICAL defect and several smaller ones;
all are fixed and pinned by tests:

- **Prompt-lock bypass (CRITICAL).** `buildModelBody` spread the client body, so a
  request carrying `system` / `contents` / `systemInstruction` / `request` was
  translated as Claude/Gemini/Antigravity and the locked prompt was replaced by the
  client's own system text — or dropped entirely. The body is now built from an
  allow-list (`SAFE_BODY_FIELDS` in `src/lib/biz/prompt.js`).
- **Fail-open forward (HIGH).** A 2xx whose body the pipeline could not read was
  returned after its stream had been consumed; it now answers 503
  `guard_unavailable` (the body is read once, never forwarded).
- The guard deadline is enforced by `Promise.race` (the in-process handlers never
  read `Request.signal`), the output check sees the whole answer, plan-scoped
  discounts follow the key's product line, a NULL knowledge-base limit means zero,
  a bot key's `/v1/models` listing skips the group check, the Claude-CLI bypass no
  longer runs for bot keys, a real answer reports the upstream usage, and a
  binary file sent as text is refused with 415.

Two defects the E2E caught and the tests now pin:

- `encodeVector` used `Array.isArray`, which is false for the `Float32Array` an
  embedding call returns: every chunk was stored as a zero-length BLOB and nothing
  was retrievable.
- The bot create form needed the admin's model list; the customer-safe
  `GET /api/account/biz/models` now serves it.

How to re-run the E2E (build first; it starts its own stub upstream and server):

```sh
npm run build
node scripts/biz-e2e.mjs
```

## Definition of done

- Every box in `tasks.md` is ticked.
- `npm test` (908 tests), `npm run lint` (0 errors) and `npm run build` pass.
- `node scripts/biz-e2e.mjs` passes 29 checks against the standalone build (pages, animation, reduced motion, plan grouping, bot create, upload, playground, guard labels, the bot-key endpoint fence, the bot-key listing and the admin page).
