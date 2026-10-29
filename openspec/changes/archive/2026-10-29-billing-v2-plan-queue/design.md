## Context

See `proposal.md` (Why / What Changes) and the eight specs under `specs/` for the required behavior. This document fixes HOW to build it so an implementer can work task by task without re-deriving decisions.

Current state that shapes the approach (verified in the code on 2026-10-29):

- **Money** is integer nano-USD everywhere (`src/shared/utils/money.js`; 1 USD = 1e9). Never introduce floats into balances; floats exist only in display strings (`fmtUsdNano`).
- **SQLite adapters are synchronous inside transactions.** `db.transaction(fn)` runs `fn` immediately; `fn` must not `await` (see header of `src/lib/db/repos/billingRepo.js`). Every function that must run inside a transaction is synchronous and takes the adapter `db` as its first argument (suffix `Sync`).
- **Schema** is declared in `TABLES` (`src/lib/db/schema.js`) and auto-synced additively (missing tables/columns/indexes are created) by `syncSchemaFromTables` in `src/lib/db/migrate.js`. Destructive changes need a versioned migration in `src/lib/db/migrations/` registered in `migrations/index.js`. **Order inside `runMigrationOnce`: pre-change backup (only when `SCHEMA_VERSION` grew) → versioned migrations → additive sync → stamp.** A versioned migration therefore runs before new columns exist; data work that needs new columns must run after the sync (see D10).
- **Usage and charging**: `saveRequestUsage` (`src/lib/db/repos/usageRepo.js:360`) inserts the `usageHistory` row and, in the same transaction, charges the owner (today via `chargeCreditsSync`, skipped at `usageRepo.js:455` when the user holds a plan with per-model limits). The request key is `"usage:" + usageHistory.id`; follow-up ledger rows of the same charge use `"usage:<id>#2"`, `"#3"`… (UNIQUE `requestKey`).
- **Request admission** happens in `enforceKeyAccess` (`src/sse/services/auth.js:371`), called by every LLM handler in `src/sse/handlers/*.js` with the requested model. It calls `enforceKeyLimits` (`src/lib/auth/keyEnforcement.js:47`) then the per-model plan allowance (`src/lib/auth/planAllowance.js`, to be deleted).
- **Key → limits resolution**: `getApiKeyForAuth` (`src/lib/db/repos/apiKeysRepo.js:206`) merges the key with the key's own `groupId`. Customer keys are created without a group (`src/app/api/account/keys/route.js:53`), so groups never apply to customers today.
- **Tests** use `node --test "test/**/*.test.js"` against a throwaway SQLite created by setting `process.env.DATA_DIR` to a temp dir before importing `src/lib/db/driver.js` (pattern: `test/billing.test.js`). 39 tests pass today. Plain Node does not understand the `@/` path alias (it only exists for Next.js via `jsconfig.json`), so **every module a test imports — directly or transitively — must use relative imports**. This applies to everything new under `src/lib/billing/`, to `src/lib/auth/{keyEnforcement,platformError,actionLimiter,adminIdentity}.js`, `src/shared/utils/safeNext.js` and to the repos; convert `@/` imports in `src/lib/auth/keyEnforcement.js` to relative paths. Dynamic `await import("@/...")` inside functions a test never calls is tolerated.
- **Model listing**: `buildModelsList(kindFilter, { allowedModels, skipDynamicFetch })` is already exported from `src/app/api/v1/models/route.js:245`; the landing reuses it with `["llm"]`.
- **Next.js 16** (`AGENTS.md`): read `node_modules/next/dist/docs/01-app/` (route handlers, `proxy.js`, server/client components, `redirect`/`permanentRedirect`) before writing route or page code. In route handlers `params` is a Promise: `const { id } = await params` (as every existing dynamic route does). Middleware is `src/proxy.js` → `src/dashboardGuard.js`: `/api/account/*` requires the customer `user_token`; other `/api/*` require the admin JWT; `/account/*` pages require a customer token; `/dashboard/*` requires the admin JWT.
- **UI** must follow `openspec/ui-dna.md` (square corners, 1px borders, mono numbers, 150ms colour transitions only, WCAG AA, no colour-only status). Existing shared components live in `src/shared/components/` (`Button`, `Input`, `Select`, `Modal`, `Drawer`, `Badge`, `Card`, `Toggle`, `Pagination`, `Tooltip`, `SegmentedControl`). `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/modifiers`, `@dnd-kit/utilities` and `recharts` are already dependencies.
- **Platform denial logging pattern**: `enforceKeyAccess` records each denial with `saveRequestDetail(buildRequestDetail(...))` and `saveUsageError(...)` from `open-sse/handlers/chatCore/requestDetail.js`, `errorSource: "platform"`, wrapped in try/catch so logging can never break the deny path. Keep this, centralised in one helper (D11).
- **OpenAI error body**: `buildErrorBody(status, message)` in `open-sse/utils/error.js:9` returns `{ error: { message, type, code } }` with type/code derived from the status. Platform denials need explicit codes, so they use their own builder with the same shape (D11).
- **Admin identity**: `currentAdminId(request)` in `src/app/api/orders/[id]/route.js:12` returns the OIDC/SAML email or JWT `sub`, else `"admin"`. Reuse it (moved to a shared helper) as the audit actor.
- **DB file** for read-only tooling: `DATA_DIR/db/data.sqlite` (`src/lib/db/paths.js`). `src/lib/auth/modelMatching.js` (`matchesAllowed`) has no imports and is safe to use from scripts.

## Goals / Non-Goals

**Goals:**
- One synchronous, driver-free billing engine (`src/lib/billing/`) that admission, charging, back-charge, admin actions and both UIs share, so every surface agrees on queue order, eligibility and window state.
- Window enforcement in O(number of queued plans) indexed reads per request, without summing usage history.
- Every money movement auditable from the ledger alone; every admin or customer action auditable from `userAuditLog`.
- Each phase (GĐ0…GĐ4) shippable on its own with `npm test`, `npm run lint`, `npm run build` green.

**Non-Goals:**
- Payment automation (VietQR/gateway) — deferred; orders stay manual.
- Per-model ceilings inside a plan, group-specific pricing (`keyGroups.priceOverrides` stays unused), plan-level RPM/TPM, quota headers on successful responses, multiple admin accounts/roles, limits on keys per customer, auto-renewal.
- Changing how token cost is computed (`calculateCostNano` + pricing tables stay as they are).
- Changing the existing refund semantics (`refundOrder` grants the order's credit again); it only gains the limits snapshot.

## Decisions

### D1 — Data model

All money columns are INTEGER nano-USD. JSON columns use `stringifyJson`/`parseJson` from `src/lib/db/helpers/jsonCol.js`.

| Table | Column / object | Definition | Phase |
|---|---|---|---|
| `orders` | `emailSnapshot` | `TEXT` — buyer email copied at order creation; back-filled once for existing orders. Named `emailSnapshot` (not `userEmail`) because `ORDER_SELECT` in `billingRepo.js:668` already aliases `u.email AS userEmail`; change that select to `COALESCE(u.email, o.emailSnapshot) AS userEmail` so deleted users' orders still show an email | GĐ0 |
| `userAuditLog` (new) | `id TEXT PRIMARY KEY` (uuid), `userId TEXT NOT NULL`, `actor TEXT NOT NULL`, `action TEXT NOT NULL`, `reason TEXT`, `details TEXT` (JSON `{ before, after, ... }`), `createdAt TEXT NOT NULL`; index `idx_ual_user_ts ON userAuditLog(userId, createdAt DESC)` | GĐ0 |
| `plans` | `limits` | `TEXT` JSON array `[{ "hours": 5, "maxNanoUsd": 20000000000 }]`, sorted by `hours`; `NULL`/`[]` = no limits | GĐ1 |
| `orders` | `limits` | `TEXT` JSON — snapshot of the plan's limits at order creation; `NULL` for orders created before GĐ1 | GĐ1 |
| `userPlans` | `priority` | `INTEGER` nullable — explicit queue position | GĐ1 |
| `userPlans` | `limits` | `TEXT` JSON — snapshot at grant time; `NULL`/`[]` = no limits | GĐ1 |
| `userPlans` | `status` values | `active`, `exhausted`, `expired`, **`revoked`** (no schema change, TEXT) | GĐ1 |
| `userPlans` | `source` values | `purchase`, `refund`, `gift`, **`admin`** (no schema change) | GĐ1 |
| `userPlanWindows` (new) | `userPlanId TEXT NOT NULL`, `hours INTEGER NOT NULL`, `startedAt TEXT NOT NULL`, `spentNanoUsd INTEGER NOT NULL DEFAULT 0`, `updatedAt TEXT`; `primaryKey: "PRIMARY KEY (userPlanId, hours)"` (the `kv` table shows the `primaryKey` syntax) | GĐ1 |
| `creditLedger` | `usageId` | `INTEGER` nullable — `usageHistory.id` for `charge` rows | GĐ1 |
| `creditLedger` | index | `idx_cl_userplan_ts ON creditLedger(userPlanId, createdAt)` | GĐ1 |
| `creditLedger` | `kind` values | `grant`, `charge`, `expire`, `adjust`, `refund`, **`revoke`**; back-charge rows are `charge` with `meta.backfill = true` and `meta.usageTimestamp` | GĐ1 |
| `planModelLimits` | — | **dropped**: migration `006-drop-plan-model-limits.js` (`DROP TABLE IF EXISTS planModelLimits`) **and** the entry removed from `TABLES`; otherwise the additive sync re-creates it on the same boot | GĐ1 |
| `users` | `adminNote` | `TEXT` | GĐ3 |

`SCHEMA_VERSION` (`src/lib/db/schema.js:6`, currently 11): set to 12 in GĐ0, 13 in GĐ1, 14 in GĐ3. Each bump triggers the automatic lightweight backup before the schema changes.

Audit `action` values: `group_auto_assigned`, `group_changed`, `status_changed`, `profile_changed`, `note_changed`, `password_reset`, `sessions_revoked`, `session_revoked`, `key_disabled`, `key_enabled`, `key_deleted`, `plan_granted`, `credit_granted`, `plan_extended`, `credit_adjusted`, `plan_limits_changed`, `plan_revoked`, `queue_reordered`, `user_deleted`. Actor values: `admin:<identity>`, `customer`, `system`.

### D2 — Per-purchase pools drained through a queue (replaces summed per-model ceilings)
Each `userPlans` row is its own pool; the queue order is `(priority IS NULL) ASC, priority ASC, expiresAt ASC, createdAt ASC, id ASC` over rows with `status = 'active' AND expiresAt > now`.
*Alternative rejected*: keep `mergeLimitsAcrossPlans` (sum ceilings across plans). It cannot answer "plan 1 is limited, use plan 2", cannot honor a customer-chosen order, and ignores `creditNanoUsd` — the opposite of the requested product.

### D3 — "First-use fixed" windows stored as counters
A window opens on the first charge when none is open, lasts `hours`, then resets. State lives in `userPlanWindows`, updated in the same transaction as the ledger insert.
*Alternatives rejected*: rolling windows ("last 5 hours") reopen a plan a few cents at a time, so the queue would flip between plans on every request and "mở lại lúc …" could not be stated; calendar windows (00:00/05:00…) let a customer burn two maxima around a boundary and feel arbitrary. Computing spent by `SUM` over `creditLedger` on every admission was rejected for hot-path cost; counters are O(1) and can be rebuilt from the ledger (`rebuildWindowsSync`) to prove consistency in tests.

### D4 — Two-pass charging at completion time
Pass 1 respects windows and splits a charge at a window edge; pass 2 ignores windows so an admitted request is always paid; the rest becomes debt (existing overdraft mechanics). The queue is re-evaluated at charge time rather than pinning the plan chosen at admission.
*Alternative rejected*: pin the admission plan. Concurrent streams admitted on the same plan would all be charged to it after it hit its limit even when another plan could pay, overshooting the limit by the sum of all in-flight requests. Re-evaluation bounds the overshoot to requests that have no other plan to go to.

### D5 — Snapshots: limits copied at order creation and at grant
`orders.limits` is written by `createOrder`; `approveOrder`/`refundOrder` grant `order.limits ?? currentPlan.limits`. Gift and admin grants copy `plan.limits` at grant time. Editing a plan changes nothing already sold unless the admin sends `applyToActive: true` (D14). This matches the existing rule that orders snapshot price/credit/duration.

### D6 — Customer keys resolve the owner's group at request time
`getApiKeyForAuth` returns `{ key, group, resolved, owner }`. For a key with `userId`: `owner = { id, status, groupId }` read from `users`; `group` = that user's group (`null` if missing/inactive); `resolved = { rpm: group.rpm, tpm: group.tpm, budgetUsd: null, resetWindow: null, allowedModels: group.allowedModels, expiresAt: key.expiresAt }`. Key-level limit columns of customer keys are ignored (and cleared once by GĐ0 bootstrap). Admin keys keep the current merge.
*Alternative rejected*: copy `groupId` onto keys at creation — goes stale on every group change and on every key created before the change.
Guard: if the owner's group is `null` (should not happen after GĐ0 invariants), deny with 403 `model_not_allowed`, message "Tài khoản chưa được gán nhóm hợp lệ — liên hệ admin". Do not rely on `isModelAllowed` here: it treats an empty allow-list as "allow all".

### D7 — Per-user RPM/TPM for customer keys
New `usageRepo` functions `getUserRateUsage(userId, windowMs)` and `getUserOldestTokenAt(userId, windowMs)` count `usageHistory` rows whose `apiKeyId IN (SELECT id FROM apiKeys WHERE userId = ?)` with `timestamp >= since` (index `idx_uh_apikeyid_ts`). The TPM wait lock key becomes `user:<userId>` for customer keys and `key:<keyId>` for admin keys.

### D8 — Engine modules under `src/lib/billing/` are synchronous and driver-free
Rule: **no module in `src/lib/billing/` may import `src/lib/db/driver.js`, `src/lib/localDb.js` or any repo that does.** They take `db` as an argument. This lets `src/lib/db/migrate.js` import them for the post-sync bootstrap (D10) without an import cycle, and lets tests call them with the test adapter.

| Module | Exports (contract) |
|---|---|
| `src/lib/billing/limits.js` (pure, may import `src/shared/utils/money.js`) | `WINDOW_PRESETS` = `[{hours:5,label:"5 giờ"},{hours:24,label:"1 ngày"},{hours:168,label:"1 tuần"}]`; `windowLabel(hours)` → `"5 giờ" \| "1 ngày" \| "1 tuần" \| "<N> giờ"`; `normalizeLimits(raw)` → `[{hours, maxNanoUsd}]` sorted, integers, or throws `TypeError` on a non-array; `validateLimits(limits, { creditNanoUsd, durationDays })` → `null` or a Vietnamese error string (rules in spec `plan-templates`); `parseLimits(text)` → array (bad JSON → `[]`); `serializeLimits(limits)` → JSON string or `null` when empty; `describeLimit(limit)` → `"Tối đa $20 mỗi 5 giờ"`. |
| `src/lib/billing/ledger.js` | Moved out of `billingRepo.js` unchanged in behaviour: `insertLedgerSync(db, entry)` (adds optional `usageId`), `bookBalanceNanoSync(db, userId)`, `getDebtNanoSync(db, userId)`, `setDebtNanoSync(db, userId, value)`. `billingRepo.js` imports them instead of its private copies. |
| `src/lib/billing/audit.js` | `insertAuditSync(db, { userId, actor, action, reason = null, details = null, now })`; `listAuditSync(db, userId, { page, pageSize })` → `{ entries, total }`. |
| `src/lib/billing/grants.js` | `grantUserPlan(db, { userId, planId, orderId, source, creditNanoUsd, durationDays, limits = [], meta, now, ledgerKind })` moved from `billingRepo.js` (see D13), plus `NO_PLAN_ID`. |
| `src/lib/billing/planQueue.js` | see D9 |
| `src/lib/billing/bootstrap.js` | see D10 |
| `src/lib/billing/adminActions.js` | see D13 (imports `planQueue`, `ledger`, `audit`, `limits`; still driver-free) |

### D9 — Engine contract (`src/lib/billing/planQueue.js`)

- `listQueueSync(db, userId, nowIso)` → array of entries ordered per D2: `{ id, userId, planId, planCode, planName, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, priority, createdAt, limits, windows }`, where `limits` is the parsed snapshot and `windows` maps `hours → { startedAt, spentNanoUsd }` from `userPlanWindows`.
- `evaluatePlan(entry, nowMs)` (pure) → `{ eligible, blocked, reopenAt, roomNanoUsd, windows: [{ hours, maxNanoUsd, spentNanoUsd, startedAt, resetAt, open, full }] }`:
  - a window is `open` when a state row exists and `nowMs < startedAt + hours·3 600 000`; `spentNanoUsd` is the stored value when open, else 0; `resetAt` is `startedAt + hours` when open, else `null`; `full` = open and spent ≥ max;
  - `blocked` = any window full; `reopenAt` = latest `resetAt` among full windows (ISO) or `null`;
  - `roomNanoUsd` = min over limits of `max(0, max − spent)`; `null` when the plan has no limits (unlimited);
  - `eligible` = `creditRemainingNanoUsd > 0` and `expiresAt > now` and not `blocked`.
- `admitSync(db, userId, nowIso)` → `{ ok: true, planId }` for the first eligible entry; else, if any entry has credit and is only blocked, `{ ok: false, status: 429, code: "plan_limit", resetAt, retryAfterSec }` with `resetAt` = earliest `reopenAt` and `retryAfterSec = max(1, ceil((resetAt − now)/1000))`; else `{ ok: false, status: 402, code: "insufficient_quota" }`.
- `chargeSync(db, { userId, apiKeyId = null, usageId = null, requestKey, costNanoUsd, nowIso })` → `{ charged, alreadyCharged, parts: [{ userPlanId, amountNanoUsd, pass }], debtNanoUsd }`:
  1. if `requestKey` already has a ledger row → `alreadyCharged: true`, **no writes at all** (this is what keeps window counters from double-counting on retry);
  2. cost ≤ 0 → no writes;
  3. pass 1 over `listQueueSync` (fresh read): `take = min(left, creditRemaining, roomNanoUsd ?? ∞)` for entries with credit > 0 and unexpired;
  4. pass 2: `take = min(left, creditRemaining)` over the same entries in order, ignoring windows;
  5. per take: update `userPlans.creditRemainingNanoUsd` (status `exhausted` at 0), `insertLedgerSync` kind `charge` with `requestKey` (first row) or `requestKey#n`, `usageId`, `apiKeyId`; then for each limit of the plan upsert `userPlanWindows`: no row or closed → `startedAt = nowIso, spentNanoUsd = take`, open → `spentNanoUsd += take`;
  6. remainder → debt exactly as today (`setDebtNanoSync` + `charge` row with `meta.overdraft = true`).
- `reorderSync(db, userId, orderedIds, { actor, nowIso })` → `{ ok: true }`, `{ ok: false, status: 400, code: "invalid_order" }` (empty, non-string or duplicate ids) or `{ ok: false, status: 409, code: "queue_changed" }` (set ≠ current queue ids). On success: `priority = index + 1` per id, one audit entry `queue_reordered` with `details.before`/`details.after` id lists.
- `queueViewSync(db, userId, nowIso)` → entries of `listQueueSync` merged with `evaluatePlan` plus `statusLabel`: `"paying"` for the entry `admitSync` would pick, `"blocked"` for blocked entries, `"waiting"` otherwise. Both UIs and APIs use this; no UI computes eligibility itself.
- `rebuildWindowsSync(db, userPlanId, nowIso)` → `hours → { startedAt, spentNanoUsd }` recomputed from the plan's `charge` ledger rows (excluding `meta.backfill`) in time order using the same open/close rule. Used by tests to prove the counters equal the ledger.
- `runBackfillSync(db, { sinceIso, nowIso })` → `{ rows, chargedNanoUsd, debtNanoUsd }` (D10).

`billingRepo.chargeCreditsSync(db, args)` stays exported as a thin wrapper over `chargeSync` so existing callers/tests keep working; `walletSummary`/`getAvailableNanoUsd` keep their formula (active, unexpired credit minus debt, floored at 0), which already excludes `revoked`.

### D10 — Post-sync bootstrap (`src/lib/billing/bootstrap.js`)
`runPostSyncTasksSync(db)` is called from `initAdapter` in `src/lib/db/driver.js`, immediately after `await runMigrationOnce(adapter)`, loaded with a dynamic `import("../billing/bootstrap.js")` exactly like `migrate.js` is. It is not placed inside `runMigrationOnce` because that function returns early on the legacy-JSON-import path, which would skip it. Each step runs in its own `db.transaction`; each failure is caught and logged with `console.error("[bootstrap] …")` so a data task can never prevent the server from starting; a one-time marker is written only after its step succeeded.

Every start (cheap, idempotent):
1. `ensureCustomerGroupsSync(db)`: if no `keyGroups` row has `isActive = 1`, insert `Mặc định` (id uuid, all limit columns `NULL`, `createdAt`/`updatedAt` now). Read the raw settings JSON (`SELECT data FROM settings WHERE id = 1`, `{}` when absent) — if `defaultUserGroupId` is empty or not an active group id, set it to the oldest active group id and write the JSON back with the same read-merge-write upsert `updateSettings` uses (`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`). Then set `users.groupId` to that default for every user whose `groupId` is `NULL` or not an active group id, writing one audit entry `group_auto_assigned` (actor `system`, details `{ before, after }`) per user.

One-time (guarded by `_meta` keys via `getMetaSync`/`setMetaSync` from `src/lib/db/helpers/metaStore.js`):
2. `bootstrap.customerKeys.v1` (GĐ0): `UPDATE apiKeys SET groupId = NULL, rpm = NULL, tpm = NULL, budgetUsd = NULL, resetWindow = NULL, allowedModels = NULL WHERE userId IS NOT NULL`.
3. `bootstrap.orderEmails.v1` (GĐ0): fill `orders.emailSnapshot` from `users.email` where `NULL`.
4. `bootstrap.backfill.v1` (GĐ1): `runBackfillSync(db, { sinceIso: "2026-10-28T19:22:58.000Z", nowIso })`:
   - candidate rows: `usageHistory` joined to `apiKeys` on `apiKeyId` with `apiKeys.userId IS NOT NULL`, `costNanoUsd > 0`, `timestamp >= sinceIso`, and no `creditLedger` row with `requestKey = 'usage:' || usageHistory.id`; ascending `timestamp, id`;
   - for each row, plans considered = that user's `userPlans` with `creditRemainingNanoUsd > 0`, `startsAt <= row.timestamp`, `expiresAt > row.timestamp`, status not `revoked`, in D2 order; take credit only (no windows); remainder → debt; ledger rows `charge` with `requestKey 'usage:<id>'`/`#n`, `usageId`, `meta: { backfill: true, usageTimestamp }`, `createdAt = nowIso`; **never touch `userPlanWindows`**.

### D11 — Platform errors in one place (`src/lib/auth/platformError.js`)
- `platformErrorBody({ status, code, message, resetAt })` → `{ error: { message, type, code, resetAt? } }` with `type` by status: 401 `authentication_error`, 402 `insufficient_quota`, 403 `permission_error`, 429 `rate_limit_error`.
- `platformErrorResponse({ status, code, message, resetAt, retryAfterSec })` → `Response` with `Content-Type: application/json`, `Access-Control-Allow-Origin: *`, and `Retry-After` when given.
- `logPlatformDenial({ apiKey, model, status, message, resetAt })` → the existing `saveRequestDetail` + `saveUsageError` pair, fully try/caught. The three duplicated logging blocks in `enforceKeyAccess` are replaced by it.
- `relativeWaitVi(ms)` → `"1 giờ 12 phút"`, `"45 phút"`, `"30 giây"` for messages.

Messages (exact):

| code | message |
|---|---|
| `invalid_api_key` | `API key không hợp lệ hoặc đã bị tắt.` |
| `key_expired` | `API key đã hết hạn.` |
| `account_suspended` | `Tài khoản đang bị khoá — liên hệ admin.` |
| `account_unverified` | `Tài khoản chưa xác minh email.` |
| `model_not_allowed` | `Model <model> không nằm trong nhóm của bạn.` (missing group: `Tài khoản chưa được gán nhóm hợp lệ — liên hệ admin.`) |
| `rate_limit` | `Vượt giới hạn RPM của nhóm, thử lại sau 60 giây.` / `Vượt giới hạn TPM của nhóm, thử lại sau 60 giây.` |
| `budget_exhausted` | `Key đã dùng hết ngân sách.` |
| `insufficient_quota` | `Hết quota — mua gói hoặc nhập mã quà tặng tại /account/plans.` |
| `plan_limit` | `Các gói đang chạm hạn mức, mở lại sau <relativeWaitVi>.` |

### D12 — Order of checks for a customer key
In `enforceKeyLimits`: (1) owner status → 403; (2) owner group present → else 403; (3) key `expiresAt` → 403 `key_expired`; (4) RPM per user → 429; (5) TPM per user (wait then 429); (6) model allow-list (in `enforceKeyAccess`, unchanged position) → 403; (7) `admitSync` → 402/429. Budget (step 4 of today) runs for admin keys only. Admission runs last so a request rejected for access reasons reports that reason, not quota.

GĐ0 ships before the engine exists, so in GĐ0 step (7) is the existing wallet gate (`getAvailableNanoUsd(userId) <= 0` → 402 `insufficient_quota` in the new error format) and the existing per-model allowance check in `enforceKeyAccess` stays, with its 403/429 denials re-emitted through `platformErrorResponse` (`model_not_allowed` / `plan_limit`). GĐ1 replaces the wallet gate with `admitSync` and deletes the allowance check. For that reason `enforceKeyLimits` must run admission (or the wallet gate) only after the model check: move the model allow-list check from `enforceKeyAccess` into `enforceKeyLimits(apiKey, model)` as step (6) so the order above holds in one function.

### D13 — Admin actions (`src/lib/billing/adminActions.js`)
Synchronous, driver-free, each runs inside one `db.transaction` opened by its API route, validates first and writes nothing on error, then writes ledger (when money moves) and exactly one audit entry. Functions: `grantPlanSync`, `grantCreditSync`, `extendPlanSync`, `adjustCreditSync`, `setPurchaseLimitsSync`, `revokePlanSync`, `applyLimitsToActiveSync(db, planId, limits, { actor })`, `validateReason(reason)` (3–500 chars after trim). Each returns `{ ok: true, ... }` or `{ ok: false, status: 400 | 404 | 409, error: "<Vietnamese message>" }`; routes translate that into the HTTP response. Rules per action: spec `admin-user-management`.

`grantUserPlan` (today in `billingRepo.js`, together with its helpers `planIdIsNullable`, `isoPlusDays`, `NO_PLAN_ID`) moves to the new driver-free module `src/lib/billing/grants.js`, gains a `limits` argument (normalized, serialized into `userPlans.limits`) and writes `priority = NULL`. `billingRepo.js` re-exports `grantUserPlan` and `NO_PLAN_ID` so existing importers (`giftRepo.js`, `approveOrder`, `refundOrder`, `src/lib/db/index.js`, `src/lib/localDb.js`, tests) keep working unchanged.

### D14 — Apply-to-active
`PATCH /api/plans/[id]` with changed `limits` and `applyToActive: true` calls `applyLimitsToActiveSync` in the same transaction as the plan update: every `userPlans` row of that plan with `status = 'active'` gets the new snapshot; `userPlanWindows` rows whose `hours` no longer exist are deleted; one audit entry per affected user (`plan_limits_changed`, reason `Áp dụng hạn mức mới của gói <code>`); response `{ plan, affectedCount }`.

### D15 — Admin vs customer key surfaces
`GET /api/keys` filters `userId IS NULL`; `/api/keys/[id]` returns 404 when the key has a `userId`. Customer keys are managed through `/api/users/[id]/keys*` (GĐ3). The Endpoint & Key page filters the same way and shows "N key của khách — quản lý ở trang Người dùng".

### D16 — Public endpoint limiter (`src/lib/auth/actionLimiter.js`)
In-memory sliding-window counter: `hitLimit(bucket, { limit, windowMs })` → `{ allowed, retryAfterSec }`, buckets `register:ip:<ip>`, `resend:email:<email>`, `resend:ip:<ip>`, `forgot:email:<email>`, `forgot:ip:<ip>`; client IP via `getClientIp` from `src/lib/auth/loginLimiter.js`; entries older than the window are pruned on access; the map is capped at 10 000 buckets (oldest evicted). Counters reset on restart — acceptable for a single instance.

### D17 — Safe `next` (`src/shared/utils/safeNext.js`)
`safeNext(value)` returns the value only if it is a string starting with `/account`, not containing `//`, `\` or `:`; else `null`. Used by `LoginForm`, `RegisterForm`, the verify-email page and `sendVerificationEmail` (link gets `&next=<encoded>`). Login redirects to `safeNext(next) ?? "/account"`.

### D18 — API shapes

Customer (session via `resolveAccountUser`, data scoped to the caller):
- `GET /api/account/plans` → `{ availableNanoUsd, debtNanoUsd, queue: QueueEntry[], history: HistoryEntry[], plans: CatalogPlan[] }`. `QueueEntry = { id, planId, planCode, planName, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, priority, statusLabel, reopenAt, windows: [{ hours, label, maxNanoUsd, spentNanoUsd, startedAt, resetAt, open, full }] }`; `HistoryEntry` = same identity fields + `status` for `exhausted`/`expired`/`revoked` rows (newest first, max 50); `CatalogPlan` = existing fields + `limits` + `limitsText[]` + `purchasable`, `blockedReason`, `blockedCode`.
- `PUT /api/account/plans/order` body `{ orderedIds: string[] }` → 200 `{ queue }` | 400 `{ error: { code: "invalid_order", message } }` | 409 `{ error: { code: "queue_changed", message: "Danh sách gói đã thay đổi — đã tải lại" } }`.
- `GET /api/account/ledger?page=1&planId=&kind=` → `{ entries: [{ id, createdAt, kind, planName, model, promptTokens, completionTokens, deltaNanoUsd, balanceAfterNanoUsd }], total, page, pageSize: 25 }` (model/tokens joined from `usageHistory` via `usageId`).

Admin (admin JWT; actor from the shared admin-identity helper):
- `GET /api/users` (query per spec) → `{ users, total }`.
- `GET /api/users/[id]` → `{ user, summary: { availableNanoUsd, debtNanoUsd, spend7dNanoUsd, spend30dNanoUsd, keyCount, sessionCount } }`; `PATCH` accepts `groupId`, `status`, `displayName`, `email`, `adminNote`, `password`, `reason` (reason required unless the body only changes `adminNote`); `DELETE` body `{ confirmEmail }`.
- `GET|POST /api/users/[id]/plans`: GET → `{ queue, history }`; POST `{ type: "plan", planId, reason }` or `{ type: "credit", amountNanoUsd, durationDays, reason }`.
- `PATCH /api/users/[id]/plans/[userPlanId]` `{ action: "extend", days? , expiresAt?, reason }` | `{ action: "adjust", deltaNanoUsd, reason }` | `{ action: "limits", limits, reason }` | `{ action: "revoke", reason }`.
- `PUT /api/users/[id]/plans/order` `{ orderedIds }`.
- `GET /api/users/[id]/ledger?page&planId&kind`, `GET /api/users/[id]/usage?range=7d|30d` → `{ daily: [{ date, requests, costNanoUsd }], byModel: [{ model, requests, promptTokens, completionTokens, costNanoUsd }] }`, `GET /api/users/[id]/keys`, `PATCH|DELETE /api/users/[id]/keys/[keyId]` (`{ isActive, reason }` / `{ reason }`), `GET|DELETE /api/users/[id]/sessions` (`{ reason }`), `DELETE /api/users/[id]/sessions/[sessionId]` (`{ reason }`), `GET /api/users/[id]/gifts`, `GET /api/users/[id]/audit?page`.
- Orders per user: existing `GET /api/orders?userId=`.
- Plans: `GET /api/plans` adds `limits` and `stats: { activeCount, activeUsers, revenueNanoUsd, consumedNanoUsd }` per plan (computed with three grouped queries, not per plan); `POST`/`PATCH` accept `limits`; `PATCH` accepts `applyToActive`.

Admin API errors keep the existing simple shape `{ error: "<Vietnamese message>" }` with 400/404/409.

### D19 — UI composition
- Shared presentational components in `src/shared/components/billing/`: `PlanQueue.js` (ordered list, drag handle via `@dnd-kit/sortable` with keyboard sensor, ↑/↓ buttons, dirty-state bar "Lưu thứ tự / Huỷ", `aria-live="polite"` region; props `entries`, `editable`, `onSave(orderedIds)`, `renderActions(entry)`), `QueueEntryCard.js`, `LimitMeter.js` (progressbar semantics, label "5 giờ: $12.40 / $20 · reset 15:30"), `StatusTag.js` (icon + text for paying/waiting/blocked/exhausted/expired/revoked), `CreditBar.js`. Both `/account/plans` and the admin user `Gói` tab use them.
- Times render with `toLocaleTimeString`/`toLocaleDateString` in the browser.
- Money renders with `fmtUsdNano`.

## Risks / Trade-offs

- [Money engine bug charges wrongly] → 17 engine tests (tasks GĐ1), `rebuildWindowsSync` consistency test, all writes in one transaction with the usage row, idempotency on `requestKey`.
- [GĐ0 suddenly blocks customers relying on unrestricted keys or many keys] → run `scripts/report-group-coverage.mjs` against production data and fix allow-lists/RPM before deploying; announce via the landing announcement banner.
- [Concurrent streams overshoot a plan's window] → bounded to requests that have no other plan with room (D4); accepted and documented in the FAQ.
- [Back-charge surprises a customer with debt] → limited to rows since `6fbcc1d` and to plans active at the time; ledger rows are tagged `backfill` so support can identify and, if decided, compensate with an admin credit grant.
- [Bootstrap failure blocks startup] → each task in its own transaction, errors logged and swallowed; one-time markers only set after success.
- [In-memory rate limiter resets on restart] → acceptable for one instance; documented.
- [Admin-saved landing copy still mentions per-model limits] → deployment checklist item: review `/dashboard/content` and `/docs` pages after GĐ4.
- [Removing `planModelLimits` loses old ceilings] → automatic pre-migration backup (SCHEMA_VERSION bump) keeps them recoverable.

## Migration Plan

Per phase:
1. Copy the production `DATA_DIR/db/data.sqlite` to a local `DATA_DIR`, start the new build against it, check the bootstrap logs and the affected pages, run the phase's QA steps.
2. GĐ0 only: run `node scripts/report-group-coverage.mjs --days 30` on the production data and adjust groups first.
3. Deploy (CI publishes the image on push to `main`; the VPS pulls it). The first boot backs up the DB automatically (SCHEMA_VERSION bump) under `DATA_DIR/db/backups/`.
4. Verify: `/api/health`, one customer request end-to-end, the ledger row it produced.

Rollback: stop the container, restore the pre-migration backup file to `DATA_DIR/db/data.sqlite`, redeploy the previous image tag. Data written after the upgrade is lost on rollback, so roll back only within the first hours.

## Open Questions

- Payment automation (VietQR + SePay/Casso or other) is deferred by the operator; it only adds an order-confirmation path and does not change any spec in this change.
