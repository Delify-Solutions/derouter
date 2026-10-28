@AGENTS.md

# derouter

Hosted AI proxy sold as OpenCode Go–style plans. Product description (Vietnamese, owner-approved): `openspec/PRODUCT.md`. Planned work lives in OpenSpec changes:
- `openspec/changes/billing-v2-plan-queue/` — GĐ0–GĐ4 (plan queue billing, groups, customer portal, admin, landing)
- `openspec/changes/payment-gateways/` — GĐ5 (VietQR via SePay/web2m/ACB, Binance USDT); implement only after billing-v2-plan-queue

Talk to the owner in Vietnamese. Write code, comments, commit messages and OpenSpec artifacts in English; user-facing UI text in Vietnamese.

## Commands

- `npm run dev` — dev server on port 20127
- `npm test` — `node --test "test/**/*.test.js"` against throwaway SQLite (set `DATA_DIR` to a temp dir before importing `src/lib/db/driver.js`, see `test/billing.test.js`)
- `npm run lint`, `npm run build` — must pass before a phase is considered done

## Rules

- Never push to `main`: every push to `main` builds and publishes the production Docker image (`.github/workflows/docker-publish.yml`). Work on a feature branch; commit only when asked.
- Next.js 16: read `node_modules/next/dist/docs/01-app/` before writing routes/pages. Route `params` is a Promise (`const { id } = await params`). Middleware is `src/proxy.js` → `src/dashboardGuard.js`.
- Money is integer nano-USD (`src/shared/utils/money.js`, 1 USD = 1e9). VND amounts are integer đồng. Never use floats for balances.
- SQLite adapters run `db.transaction(fn)` synchronously — never `await` inside it. Functions meant to run in a transaction are synchronous, take `db` first and end in `Sync`.
- Schema: declare tables/columns in `src/lib/db/schema.js` (`TABLES`, additive auto-sync) and bump `SCHEMA_VERSION` on every schema change (triggers a pre-migration backup). Destructive changes need a versioned migration in `src/lib/db/migrations/` — and removal from `TABLES`, or sync recreates the table. Versioned migrations run before the additive sync.
- Anything a test imports must use relative imports: plain Node does not resolve the `@/` alias, and bare `open-sse/...` imports fail outside Next (cost silently becomes 0 — seed a price with `updatePricing` in tests).
- UI follows `openspec/ui-dna.md` (square, 1px borders, mono numbers, no shadows/gradients, WCAG AA, no colour-only status).
- Secrets at rest go through `encryptSecret`/`decryptSecret` (`src/lib/crypto/secrets.js`); never log URLs, headers or errors containing secrets.

## Layout

- `src/app/api/v1/**` — OpenAI-compatible proxy endpoints; handlers in `src/sse/handlers/`, provider engine in `open-sse/`
- `src/app/(dashboard)/dashboard/**` — admin console (login at hidden `/admin/ss`)
- `src/app/account/**`, `src/app/api/account/**` — customer area (`user_token` session)
- `src/app/landing/**`, `src/app/page.js` — public landing; copy is admin-editable (`src/lib/db/repos/contentRepo.js`)
- `src/lib/db/repos/` — data access (billing, users, keys, groups, gifts, usage, pricing)
- `src/lib/auth/` — key enforcement, sessions, plan checks
