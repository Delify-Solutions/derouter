## 1. Preparation (read before any phase)

- [ ] 1.1 Read `AGENTS.md`, the guides under `node_modules/next/dist/docs/01-app/` for route handlers, `proxy.js`, server vs client components and `redirect`/`permanentRedirect`, `openspec/ui-dna.md`, and the "Context" section of this change's `design.md` (money in nano-USD, synchronous transactions, migration order, relative imports for tested modules). Run `npm test` and confirm the 39 existing tests pass before editing anything.
- [ ] 1.2 Work strictly phase by phase (GĐ0 → GĐ4). Finish every task of a phase, then run `npm test`, `npm run lint` and `npm run build`; all three must pass before starting the next phase.
- [ ] 1.3 Create and work on a feature branch (`git switch -c feat/billing-v2-plan-queue`). Commit only when the user asks. Never push to `main`: every push to `main` builds and publishes the production Docker image (`.github/workflows/docker-publish.yml`). Tasks 7.2 and 14.2 are operator steps — when you reach one, stop, report what the operator must do, and hand control back instead of skipping it or waiting.

## 2. GĐ0 — Schema, audit log and start-up bootstrap

- [ ] 2.1 In `src/lib/db/schema.js`: add column `emailSnapshot: "TEXT"` to `orders`; add table `userAuditLog` exactly as in design D1 (columns `id`, `userId`, `actor`, `action`, `reason`, `details`, `createdAt`; index `idx_ual_user_ts`); set `SCHEMA_VERSION = 12`.
- [ ] 2.2 Create `src/lib/billing/audit.js` with `insertAuditSync(db, { userId, actor, action, reason, details, now })` (uuid id, `details` stored with `stringifyJson`) and `listAuditSync(db, userId, { page = 1, pageSize = 50 })` returning `{ entries, total }` newest first. Relative imports only; must not import `src/lib/db/driver.js`.
- [ ] 2.3 Create `src/lib/billing/bootstrap.js` exporting `runPostSyncTasksSync(db)` that runs, each in its own `db.transaction` inside try/catch logging `[bootstrap]` errors: `ensureCustomerGroupsSync` (every start) and the one-time tasks `bootstrap.customerKeys.v1` and `bootstrap.orderEmails.v1` guarded by `getMetaSync`/`setMetaSync` from `src/lib/db/helpers/metaStore.js` (design D10 steps 1–3; settings written with the same upsert as `updateSettings`).
- [ ] 2.4 In `src/lib/db/driver.js` `initAdapter`, right after `await runMigrationOnce(adapter)`, add `const { runPostSyncTasksSync } = await import("../billing/bootstrap.js"); runPostSyncTasksSync(adapter);`. ← (verify: a fresh `DATA_DIR` boots with group `Mặc định` and `defaultUserGroupId` set; a DB containing a user with `groupId = NULL` gets the default group plus a `group_auto_assigned` audit row; customer keys lose their key-level limit columns; a second boot changes nothing)
- [ ] 2.5 Add `test/bootstrap.test.js` covering the four outcomes of 2.4 against a temp `DATA_DIR` (seed rows with direct SQL, then call `runPostSyncTasksSync(db)` twice).

## 3. GĐ0 — Customer groups

- [ ] 3.1 `src/lib/db/repos/userRepo.js` `resolveDefaultGroupId`: the fallback query must select only `isActive = 1` groups (today it picks the oldest group even if inactive, line 97).
- [ ] 3.2 `src/lib/db/repos/keyGroupsRepo.js`: add `getGroupGuard(groupId)` → `{ memberCount, isDefault, isLastActive }` (default = settings `defaultUserGroupId` resolved via `resolveDefaultGroupId`); make `deleteKeyGroup` and `updateKeyGroup` (when the patch sets `isActive` to false) refuse when `memberCount > 0 || isDefault || isLastActive`, returning a value the route can turn into 409 without throwing a generic error.
- [ ] 3.3 `src/app/api/groups/[id]/route.js`: DELETE and PATCH answer 409 `{ error: "<Vietnamese reason>", memberCount, isDefault }` on guard failure; `src/app/api/groups/route.js` GET adds `memberCount` and `isDefault` to every group (one grouped `COUNT` query, not one per group).
- [ ] 3.4 `src/app/api/settings/route.js` PATCH: when `defaultUserGroupId` is present and is not the id of an active group, answer 400 and save nothing.
- [ ] 3.5 `src/app/api/users/[id]/route.js` PATCH: `groupId` must be an active group id; empty, unknown or inactive → 400 (today an empty string clears the group).
- [ ] 3.6 `src/app/(dashboard)/dashboard/groups/GroupsPageClient.js`: add a member-count column and a `Mặc định` badge; show the 409 message with a link to `/dashboard/users?groupId=<id>`.
- [ ] 3.7 `src/app/(dashboard)/dashboard/users/UsersPageClient.js`: read the `groupId` query parameter and filter the loaded list client-side (GĐ3 replaces this with server-side filters); the group select only offers active groups and has no empty option.
- [ ] 3.8 `src/app/(dashboard)/dashboard/profile/page.js`: the default-group select lists active groups only.
- [ ] 3.9 Create `scripts/report-group-coverage.mjs` per spec `customer-groups` (read-only): open `DATA_DIR/db/data.sqlite` read-only with the available driver (`better-sqlite3` `{ readonly: true }`, else `node:sqlite` `DatabaseSync` read-only) and never call `getAdapter()` (it runs migrations); use `matchesAllowed` from `src/lib/auth/modelMatching.js`; the model a member "called" is `json_extract(meta, '$.requestedModel')` falling back to `model`; minute buckets are `substr(timestamp, 1, 16)`; `--days` defaults to 30; exit code 0. ← (verify: run against a copy of a DB; the file's checksum is unchanged; an uncovered model and an over-RPM user are both listed)

## 4. GĐ0 — Access enforcement

- [ ] 4.1 `src/lib/db/repos/apiKeysRepo.js` `getApiKeyForAuth`: implement design D6 — return `owner` (`{ id, status, groupId }`) for keys with `userId`, take `group` from the owner, build `resolved` from that group only (budget and reset window `null`, `expiresAt` from the key); admin keys unchanged.
- [ ] 4.2 `src/lib/db/repos/usageRepo.js`: add `getUserRateUsage(userId, windowMs)` → `{ requests, tokens }` and `getUserOldestTokenAt(userId, windowMs)` over `usageHistory` rows whose `apiKeyId` belongs to the user (design D7).
- [ ] 4.3 Create `src/lib/auth/platformError.js` per design D11 (`platformErrorBody`, `platformErrorResponse`, `logPlatformDenial`, `relativeWaitVi`, exact messages table). Relative imports only; `logPlatformDenial` may dynamically import the logging modules exactly as `enforceKeyAccess` does today.
- [ ] 4.4 `src/lib/auth/keyEnforcement.js`: convert `@/` imports to relative paths; change the signature to `enforceKeyLimits(apiKey, model)` and implement the check order of design D12 for customer keys (status → group present → key expiry → per-user RPM → per-user TPM with lock key `user:<userId>` → model allow-list when `model` is given → existing wallet gate as 402 `insufficient_quota`); keep admin-key behavior (per-key counters, budget, lock key `key:<keyId>`); every denial returns `{ ok: false, status, code, message, retryAfterSec?, resetAt? }`.
- [ ] 4.5 `src/sse/services/auth.js` `enforceKeyAccess`: call the new `enforceKeyLimits(apiKey, model)`, drop its own model check, emit every denial with `platformErrorResponse` and log it with `logPlatformDenial`; keep the existing plan-allowance check for now, but re-emit its 403/429 through `platformErrorResponse` with codes `model_not_allowed` / `plan_limit` (it is deleted in GĐ1).
- [ ] 4.6 `src/app/api/v1/models/route.js` `resolveKeyScopeForModels`: for a customer key whose owner is not `active`, or whose group is missing, return the matching 403 platform error response; the listing uses `auth.resolved.allowedModels` (now the owner's group).
- [ ] 4.7 Admin key surface (design D15): `src/app/api/keys/route.js` GET returns only keys with `userId == null` plus `customerKeyCount`; `src/app/api/keys/[id]/route.js` GET/PUT/DELETE answer 404 for a key with `userId`; `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` shows the line "N key của khách — quản lý ở trang Người dùng" from `customerKeyCount`.
- [ ] 4.8 Add `test/access-enforcement.test.js` (temp DB; insert users, groups, keys and `usageHistory` rows with SQL — do not call `createApiKey`, it dynamically imports an `@/` module; set `TPM_MAX_WAIT_MS=0`; call `enforceKeyLimits(apiKey, model)` and `platformErrorBody` directly and never import `src/sse/services/auth.js`, which uses `@/` imports) covering every scenario of spec `api-access-enforcement`: group change applies on the next call, model outside group → 403 `model_not_allowed`, unrestricted group passes, stale key-level `rpm` ignored, two keys share RPM → 429 `rate_limit`, admin keys counted per key, suspended → 403 `account_suspended`, unverified → 403 `account_unverified`, customer group budget not enforced, body shape `{ error: { message, type, code } }`. ← (verify: every scenario in specs/api-access-enforcement/spec.md has a passing test or, for UI-only lines, a manual check note)

## 5. GĐ0 — Customer API key page

- [ ] 5.1 Create `src/app/account/keys/page.js` (server component; read the `publicBaseUrl` setting with `getSettings` and pass it down) and `src/app/account/keys/components/KeysPageClient.js` implementing spec `customer-portal` "API key page": list from `GET /api/account/keys`, create with `POST /api/account/keys` (name 1–80 characters), show the returned `secret` once with a copy button and the warning "Lưu key ngay — bạn sẽ không xem lại được", delete through `DELETE /api/account/keys/[id]` after a confirmation `Modal`, base URL box `<publicBaseUrl or window.location.origin>/v1` with copy; loading skeleton, empty state ("Bạn chưa có API key" + "Tạo key"), error state with "Thử lại", disabled buttons while saving; Vietnamese copy; follow `openspec/ui-dna.md`. ← (verify: create → secret visible once → reload shows only the prefix; delete removes it; whole page operable by keyboard)

## 6. GĐ0 — Deletion, signup protection, password policy, warnings

- [ ] 6.1 Create `src/lib/auth/adminIdentity.js` exporting `getAdminActor(request)`: move the body of `currentAdminId` from `src/app/api/orders/[id]/route.js:12` (OIDC email, SAML email or JWT `sub`, else `"admin"`) and return it prefixed as `admin:<identity>`; make the orders route use it (it keeps storing the identity without the prefix in `approvedBy`).
- [ ] 6.2 `src/lib/db/repos/billingRepo.js`: `createOrder` stores `emailSnapshot` from the buyer's `users.email`; `ORDER_SELECT` selects `COALESCE(u.email, o.emailSnapshot) AS userEmail`.
- [ ] 6.3 `src/lib/db/repos/userRepo.js` `deleteUser(id, { actor })`: in one transaction delete the user's `apiKeys`, `userSessions`, `emailVerifications`, `userPlans`, `creditLedger`, `giftRedemptions` and `userAuditLog` rows and the `users` row, keep `orders`, then insert the audit entry `user_deleted` with `details: { userId, email }` and the given actor.
- [ ] 6.4 `src/app/api/users/[id]/route.js` DELETE: require body `{ confirmEmail }` equal (case-insensitive) to the user's email, else 400; call `deleteUser(id, { actor: getAdminActor(request) })` and stop deleting keys one by one in the route; `UsersPageClient.js` delete dialog asks the admin to type the email.
- [ ] 6.5 Create `src/lib/auth/actionLimiter.js` per design D16 and apply it: `src/app/api/public/register/route.js` (5/hour/IP), `src/app/api/public/resend-verification/route.js` (3/hour/email and 10/hour/IP), `src/app/api/public/forgot-password/route.js` (3/hour/email and 10/hour/IP); over-limit → 429 with `Retry-After` and a Vietnamese message; the per-email limit applies whether or not the account exists.
- [ ] 6.6 `src/app/api/users/route.js` POST and `src/app/api/users/[id]/route.js` PATCH validate passwords with `validatePassword` from `src/lib/users/register.js` (10–200 characters) instead of the local `length < 8` checks; update the hints in `UsersPageClient.js`.
- [ ] 6.7 Show the exact mail-relay warning of spec `account-registration` in the signup section of `src/app/(dashboard)/dashboard/profile/page.js` and as a banner in `UsersPageClient.js` when `requireEmailVerification` is on and `smtpRelayUrl` is empty.
- [ ] 6.8 Add `test/user-delete.test.js` (cascade removes all listed rows, orders remain and still report the email, one `user_deleted` audit row) and `test/action-limiter.test.js` (limits per bucket, `retryAfterSec`, window expiry). ← (verify: spec admin-user-management "Orders survive deletion" and spec account-registration rate-limit scenarios)

## 7. GĐ0 — Release gate

- [ ] 7.1 `npm test`, `npm run lint`, `npm run build` pass.
- [ ] 7.2 **Operator step — stop here and hand back.** The operator runs `node scripts/report-group-coverage.mjs --days 30` against a copy of the production data, adjusts group allow-lists and RPM/TPM in the admin, and only then merges and deploys GĐ0. The implementer reports this instruction and does not deploy, push to `main`, or skip ahead. ← (verify: operator confirmed no customer relies on a model outside its group or on per-key RPM)

## 8. GĐ1 — Schema for the plan queue

- [ ] 8.1 `src/lib/db/schema.js`: add `plans.limits`, `orders.limits`, `userPlans.priority`, `userPlans.limits`, `creditLedger.usageId`, the index `idx_cl_userplan_ts`, and table `userPlanWindows` with `primaryKey: "PRIMARY KEY (userPlanId, hours)"` (design D1); delete the `planModelLimits` entry from `TABLES`; set `SCHEMA_VERSION = 13`.
- [ ] 8.2 Create `src/lib/db/migrations/006-drop-plan-model-limits.js` (`version: 6`, `up(db)` runs `DROP TABLE IF EXISTS planModelLimits`) and append it to `MIGRATIONS` in `src/lib/db/migrations/index.js`. ← (verify: booting a DB that has `planModelLimits` leaves no such table after the first and the second boot, and a backup folder appears under `DATA_DIR/db/backups/`)

## 9. GĐ1 — Billing engine modules

- [ ] 9.1 Create `src/lib/billing/limits.js` per design D8 and `test/limits.test.js` with one passing and one failing case per validation rule of spec `plan-templates` plus `windowLabel` (5 → "5 giờ", 24 → "1 ngày", 168 → "1 tuần", 12 → "12 giờ") and `describeLimit`.
- [ ] 9.2 Create `src/lib/billing/ledger.js` by moving `insertLedger`, `bookBalanceNano`, `getUserOverdraftNano`, `setUserOverdraftNano` out of `billingRepo.js` as `insertLedgerSync` (plus optional `usageId`), `bookBalanceNanoSync`, `getDebtNanoSync`, `setDebtNanoSync`; `billingRepo.js` imports them; behavior unchanged (existing tests stay green).
- [ ] 9.3 Create `src/lib/billing/grants.js` by moving `grantUserPlan`, `planIdIsNullable`, `isoPlusDays` and `NO_PLAN_ID` out of `billingRepo.js`; add the `limits` argument (normalized, stored in `userPlans.limits`) and write `priority = NULL`; re-export `grantUserPlan` and `NO_PLAN_ID` from `billingRepo.js`.
- [ ] 9.4 Create `src/lib/billing/planQueue.js` with `listQueueSync`, `evaluatePlan`, `admitSync`, `chargeSync`, `reorderSync`, `queueViewSync`, `rebuildWindowsSync`, `runBackfillSync` exactly as specified in design D9/D10 (driver-free, relative imports).
- [ ] 9.5 `src/lib/db/repos/billingRepo.js`: `chargeCreditsSync` becomes a thin wrapper over `chargeSync` (same arguments plus optional `usageId`); `expireStalePlans` additionally deletes `userPlanWindows` rows whose plan status is not `active`.
- [ ] 9.6 Add `test/plan-queue.test.js` with the 17 cases below ← (verify: all 17 pass and `test/billing.test.js`, `test/gift.test.js` remain green)
  1. default order by expiry; explicit priority wins; a new grant goes after manually ordered plans;
  2. `reorderSync`: missing or extra id → 409 `queue_changed`; empty or duplicate → 400; success writes priorities 1..n and a `queue_reordered` audit entry;
  3. plan 1 window-blocked → `admitSync` picks plan 2 and `chargeSync` charges plan 2;
  4. split at the window edge ($19.50 of $20 spent, cost $1) → two ledger rows of $0.50 each;
  5. single plan absorbs the overflow in pass 2 → window spent $20.50, plan blocked until the window closes;
  6. all plans blocked (two plans, one with two windows) → 429 `plan_limit` with `resetAt` = earliest reopen and correct `retryAfterSec`;
  7. no credit → 402; remainder becomes debt; a later grant repays the debt first;
  8. window opens on the first charge and resets after `hours`; windows are independent (5-hour closed but 168-hour full keeps the plan blocked);
  9. retry with the same `requestKey` → no new ledger row and window counters unchanged;
  10. zero cost → no writes;
  11. expired but unswept plan is neither admitted nor charged;
  12. editing a plan does not change purchased plans; `applyLimitsToActiveSync` updates only `active` purchases and deletes state for removed window lengths;
  13. plan gift code snapshots limits; credit gift code has none;
  14. a seeded random sequence of charges and clock jumps leaves counters equal to `rebuildWindowsSync`;
  15. backfill charges only rows at or after the cut-off, only plans active at the usage time, puts the rest into debt, never touches windows, and a second run changes nothing;
  16. `saveRequestUsage` for a customer key writes charge rows with `usageId` and `requestKey "usage:<id>"`, and saving the same entry twice charges once. Under plain `node --test` the built-in price tables (`open-sse/...` bare import) cannot load and the cost silently becomes 0, so first seed a price override with `updatePricing({ testprov: { testmodel: { input: 1, output: 2 } } })` from `src/lib/db/repos/pricingRepo.js` (prices per 1M tokens; 1,000 input + 500 output tokens then cost exactly 2,000,000 nano-USD — verified) and send `provider: "testprov", model: "testmodel"`;
  17. admin keys: `saveRequestUsage` writes no ledger row and admission is not applied.

## 10. GĐ1 — Wire grants, orders, gifts and plans

- [ ] 10.1 `billingRepo.js` plans: `rowToPlan` returns `limits`; `validatePlanInput` calls `validateLimits` against the plan's credit and duration; `createPlan`/`updatePlan` persist `limits`.
- [ ] 10.2 `createOrder` stores `orders.limits` (snapshot); `approveOrder` and `refundOrder` grant with `parseLimits(order.limits)` or, when the order has none (created before GĐ1), the plan's current limits.
- [ ] 10.3 `src/lib/db/repos/giftRepo.js` `redeemGiftCode`: plan gifts pass the plan's limits, credit gifts pass `[]`.
- [ ] 10.4 Create `src/lib/billing/adminActions.js` with `applyLimitsToActiveSync(db, planId, limits, { actor, planCode })` (design D14; the rest of the module comes in GĐ3; the actor comes from `getAdminActor`, task 6.1).
- [ ] 10.5 `src/app/api/plans/route.js` POST and `src/app/api/plans/[id]/route.js` PATCH accept `limits` (400 with the Vietnamese validation message); PATCH with changed limits and `applyToActive: true` runs the plan update and `applyLimitsToActiveSync` in one transaction and returns `{ plan, affectedCount }`; `GET /api/plans/[id]` returns `limits` and no `modelLimits`.
- [ ] 10.6 `GET /api/plans` adds `stats: { activeCount, activeUsers, revenueNanoUsd, consumedNanoUsd }` per plan using three grouped queries (design D18).

## 11. GĐ1 — Wire admission and charging

- [ ] 11.1 `src/lib/db/repos/usageRepo.js` `saveRequestUsage`: delete the `onPlan` branch (line 455) and call `chargeSync(db, { userId, apiKeyId, usageId: insertedUsage.lastInsertRowid, requestKey: "usage:" + insertedUsage.lastInsertRowid, costNanoUsd: entry.costNanoUsd, nowIso: entry.timestamp })` inside the existing try/catch.
- [ ] 11.2 `src/lib/auth/keyEnforcement.js`: replace the wallet gate with `admitSync` for customer keys; map 402 → `insufficient_quota`, 429 → `plan_limit` with `Retry-After = retryAfterSec`, `resetAt`, and the message built with `relativeWaitVi`.
- [ ] 11.3 `src/sse/services/auth.js`: delete the plan-allowance block.
- [ ] 11.4 `src/app/api/v1/models/route.js`: delete the plan-based narrowing (the `planModelAllowList`/`planAcceptsCombo` block).
- [ ] 11.5 `src/lib/billing/bootstrap.js`: add the one-time task `bootstrap.backfill.v1` calling `runBackfillSync(db, { sinceIso: "2026-10-28T19:22:58.000Z", nowIso })`, logging `[bootstrap] backfill` with rows/charged/debt; `deleteUser` (task 6.3) also deletes the user's `userPlanWindows` rows. ← (verify: with a temp DB, a customer request produces a charge row carrying `usageId`, window counters move, and 402/429 bodies match spec plan-queue-billing exactly)

## 12. GĐ1 — Remove per-model ceilings

- [ ] 12.1 Delete `src/lib/auth/planAllowance.js`, `src/lib/db/repos/planLimitsRepo.js`, `src/app/api/plans/[id]/model-limits/route.js`, `src/app/api/account/quota/route.js`, `src/app/(dashboard)/dashboard/plans/components/PlanModelLimits.js`, and every import of them; `grep -rnE "planAllowance|planLimitsRepo|PlanModelLimits|model-limits|PLAN_WINDOWS|planModelLimits|x-plan-" src open-sse test` returns nothing.
- [ ] 12.2 `src/app/account/quota/page.js` becomes a `permanentRedirect("/account/plans")`; remove the `Hạn mức` item from `src/app/account/components/AccountNav.js` and the `/account/quota` links in `src/app/account/page.js`.
- [ ] 12.3 Landing, minimal: `src/app/landing/components/LandingPage.js` stops reading model limits; `salesData.js` `toSalesPlan(plan)` exposes `priceUsd`, `creditUsd`, `durationDays`, `limits` and `limitsText` and drops `monthlyByModel`, `sampleModel`, `USAGE_WINDOWS`, the per-model `DEFAULT_PERKS`, `monthlyLimitFor`, `windowLimitFor`, `modelsForPlan`; `PlansSection`, `PricingSection`, `HeroSection`, `FaqSection`, `ModelsSection`, `GetStarted`, `Footer` render without per-model data. ← (verify: `npm run build` passes and the landing renders with 0, 1 and 3 active plans)

## 13. GĐ1 — Admin plan form

- [ ] 13.1 `src/app/(dashboard)/dashboard/plans/PlansPageClient.js`: remove the per-model block; add the limits editor (rows: window select `5 giờ`/`1 ngày`/`1 tuần`/`Tuỳ chỉnh` + hours input, USD input converted with `usdToNano`, add/remove buttons, inline errors from `validateLimits`), the live preview sentence of spec `plan-templates`, and, when editing a plan whose limits changed, the checkbox "Áp dụng hạn mức mới cho N gói đang chạy" (N = `stats.activeCount`); submit `limits` and `applyToActive`. ← (verify: spec plan-templates "Preview reflects the form" and "Apply to 3 active purchases" pass manually)

## 14. GĐ1 — Release gate

- [ ] 14.1 `npm test`, `npm run lint`, `npm run build` pass.
- [ ] 14.2 **Operator step — stop here and hand back.** The operator boots the new build on a copy of the production DB and confirms: the `[bootstrap] backfill` log line appears, back-charge rows carry `meta.backfill`, `planModelLimits` is gone, each purchase keeps its expiry, and the customer pages still load. ← (verify: every scenario in specs/plan-queue-billing and specs/plan-templates)

## 15. GĐ2 — Customer APIs

- [ ] 15.1 `src/app/api/account/plans/route.js` GET returns the shape of design D18 (`queueViewSync`, history of the 50 newest non-active purchases, catalog with `limits`, `limitsText`, purchasability).
- [ ] 15.2 Create `src/app/api/account/plans/order/route.js` PUT `{ orderedIds }` → `reorderSync` with actor `customer`; 200 `{ queue }`, 400 `invalid_order`, 409 `queue_changed` with the message "Danh sách gói đã thay đổi — đã tải lại".
- [ ] 15.3 Create `src/app/api/account/ledger/route.js` GET `page`, `planId`, `kind` → `{ entries, total, page, pageSize: 25 }`, model and tokens joined from `usageHistory` by `usageId`, scoped to the caller.
- [ ] 15.4 Add tests for the repo-level functions behind 15.2/15.3 (another user's plan id → 409; pagination and filters) in `test/account-plans.test.js`.

## 16. GĐ2 — Shared billing UI components

- [ ] 16.1 Create `src/shared/components/billing/PlanQueue.js`, `QueueEntryCard.js`, `LimitMeter.js`, `StatusTag.js`, `CreditBar.js` per design D19: `@dnd-kit/sortable` with keyboard sensor, ↑/↓ buttons labelled "Đưa gói <name> lên/xuống", dirty-state bar "Lưu thứ tự" / "Huỷ", `aria-live="polite"` announcements, `role="progressbar"` with labels, status as icon + text, times via `toLocaleTimeString`, money via `fmtUsdNano`, styling per `openspec/ui-dna.md`.

## 17. GĐ2 — Customer pages

- [ ] 17.1 Rebuild `/account/plans` (`src/app/account/plans/components/PlansPageClient.js` and siblings): sections "Hàng đợi" (editable `PlanQueue`, save flow with 409 handling and one-line success), "Mua thêm gói" (`BuyPlans.js` shows price, "Nhận $X dùng chung mọi model", "Dùng N ngày", limits, blocking reason, Vietnamese order instruction), "Đơn hàng" (`MyOrders.js` in Vietnamese), "Lịch sử gói" collapsed; `?plan=<code>` highlights and scrolls to that card; loading/empty/error/disabled states.
- [ ] 17.2 Create `/account/ledger` (`src/app/account/ledger/page.js` + `LedgerTable.js`): 25 rows per page, filters by plan and kind, kind labels `Trừ tiền`, `Cấp`, `Hết hạn`, `Điều chỉnh`, `Hoàn tiền`, `Thu hồi`, horizontal scroll on narrow screens.
- [ ] 17.3 Rework `src/app/account/page.js` overview cards per spec `customer-portal` "Overview page".
- [ ] 17.4 `AccountNav.js` items and order per spec; translate every remaining English string in `src/app/account/**` (layout, gift components, usage page and table, plans components) to Vietnamese following the voice rules of `openspec/ui-dna.md`. ← (verify: every scenario of specs/customer-portal, including a keyboard-only pass and the live-region announcement)

## 18. GĐ3 — Admin back end

- [ ] 18.1 `src/lib/db/schema.js`: add `users.adminNote TEXT`; `SCHEMA_VERSION = 14`.
- [ ] 18.2 Complete `src/lib/billing/adminActions.js` per design D13 and spec `admin-user-management` (grant plan, grant credit, extend, adjust credit, edit purchase limits, revoke, `validateReason`), each validating first, then writing ledger rows (money) and one audit entry in the caller's transaction.
- [ ] 18.3 Add `test/admin-actions.test.js`: one valid and one invalid case per action, ledger and audit rows asserted, adjust below zero → 400 and nothing written, revoke writes `-remaining` as `revoke`, missing reason → 400.
- [ ] 18.4 `src/app/api/users/route.js` GET: query parameters, sorting, pagination and set-based aggregates of spec `admin-user-management` "Users list".
- [ ] 18.5 `src/app/api/users/[id]/route.js`: GET adds `summary`; PATCH accepts `adminNote`, requires `reason` unless only `adminNote` changes, writes audit entries (`group_changed`, `status_changed`, `profile_changed`, `note_changed`, `password_reset`), and status `suspended`/`unverified` revokes all sessions.
- [ ] 18.6 Create the plan routes: `src/app/api/users/[id]/plans/route.js` (GET queue + history; POST grant plan/credit), `src/app/api/users/[id]/plans/[userPlanId]/route.js` (PATCH `extend` / `adjust` / `limits` / `revoke`), `src/app/api/users/[id]/plans/order/route.js` (PUT); each opens one `db.transaction`, uses `getAdminActor`, and maps `{ ok: false, status, error }` to the response.
- [ ] 18.7 Create `src/app/api/users/[id]/ledger/route.js`, `usage/route.js` (`range=7d|30d` → `daily` and `byModel` from `usageHistory` of the user's keys), `keys/route.js` + `keys/[keyId]/route.js` (PATCH `{ isActive, reason }`, DELETE `{ reason }`; last use = latest usage timestamp of the key), `sessions/route.js` (GET; DELETE all with reason) + `sessions/[sessionId]/route.js` (DELETE with reason; add `listUserSessions` and `revokeSessionById` to `userRepo.js`), `gifts/route.js` (`listUserRedemptions`), `audit/route.js` (`listAuditSync`). Every route writes the audit entry of its action. ← (verify: each endpoint rejects a missing reason with 400 and writes exactly one audit row on success)

## 19. GĐ3 — Admin pages

- [ ] 19.1 Rebuild `src/app/(dashboard)/dashboard/users/UsersPageClient.js` on the new `GET /api/users`: search box, filters (group, status, "Đang có gói / Không có gói / Đang nợ"), sortable columns, `Pagination`, row click → `/dashboard/users/<id>`, keep "Tạo user" and the relay warning banner.
- [ ] 19.2 Create `src/app/(dashboard)/dashboard/users/[id]/page.js` and `UserDetailClient.js` with the nine tabs selected by `?tab=` (unknown → `Tổng quan`) and a not-found state linking back to the list.
- [ ] 19.3 Create the tab components: Tổng quan (group/status/note/password edits through a reason modal), Gói (`PlanQueue` in admin mode plus modals for grant plan, grant credit, extend, adjust, edit limits, revoke — each with a required reason field), Đơn hàng (reuse the order actions of `OrdersPageClient.js`), Sổ cái, Usage (`recharts` bar chart of daily cost plus per-model table), API key, Phiên đăng nhập, Mã quà tặng, Nhật ký.
- [ ] 19.4 `src/app/(dashboard)/dashboard/plans/PlansPageClient.js`: show the four statistics columns from `stats`. ← (verify: every scenario of specs/admin-user-management executed in the browser, including revoke and cascade delete)

## 20. GĐ4 — Landing and the plan-selection flow

- [ ] 20.1 Create `src/shared/utils/safeNext.js` (design D17) and `test/safe-next.test.js` (accepts `/account/plans?plan=go`; rejects `//evil.example`, `https://x`, `/dashboard`, `/account\x`, non-strings).
- [ ] 20.2 Carry `next`: `src/app/login/components/LoginForm.js` redirects to `safeNext(next) ?? "/account"` (today it always goes to `/account`, line 59); `src/app/register/components/RegisterForm.js` sends `next` and links to `/login?next=…`; `src/app/api/public/register/route.js` passes a valid `next` to `sendVerificationEmail`, which appends `&next=` to the link in `src/lib/users/register.js`; `src/app/verify-email/components/VerifyEmailClient.js` forwards it to its login link.
- [ ] 20.3 Sellable models: in `LandingPage.js` load the default customer group and call `buildModelsList(["llm"], { allowedModels: group.allowedModels, skipDynamicFetch: true })` (exported from `src/app/api/v1/models/route.js`); attach input/output/cached prices from the router pricing (`getPricingForModel` / `resolvePrice`); `ModelsSection.js` renders that list; retire the `opencode-go` registry source in `modelCatalog.js`/`salesData.js`.
- [ ] 20.4 Plan cards and copy: `PlansSection.js` renders the card of spec `public-landing` (price, "Nhận $X dùng chung mọi model", "Dùng N ngày", "Tối đa $Y mỗi <label>", featured badge, inert "Chưa mở bán"); the "Chọn <plan>" link goes to `/register?next=/account/plans?plan=<code>` when signed out and to `/account/plans?plan=<code>` when signed in; `PricingSection.js` explains credit deduction with the 20,000-input / 2,000-output worked example; rewrite the defaults in `src/lib/db/repos/contentRepo.js` (hero, plans, pricing, get-started) and `FaqSection.js` with the five FAQ entries of the spec; no per-model wording remains.
- [ ] 20.5 Deployment note for the operator: review copy already saved in `/dashboard/content` and every `/docs` page for per-model wording, because saved copy overrides the new defaults. ← (verify: every scenario of specs/public-landing, including signed-out "Chọn Go" → register → verify → login → `/account/plans?plan=go` highlighted)

## 21. Final end-to-end check

- [ ] 21.1 In a browser on a fresh `DATA_DIR`, run the QA script below and record any deviation as a bug before closing the change ← (verify: whole change end to end against all eight specs)
  1. Admin creates plan Go ($10 → $250, 30 days, 5 giờ / $20).
  2. A customer registers and buys Go; the admin approves the order.
  3. The customer creates a key and calls a model in the group → charged. Calling a model outside the group → 403.
  4. The admin grants a second Go. Spending past $20 on plan 1 → the next requests are charged to plan 2.
  5. Both plans blocked → 429 with the reopen time.
  6. The customer reorders → the next request is charged to the new first plan.
  7. The admin suspends the account → the API answers 403 immediately.
  8. The admin deletes the user → the user's data is gone and the orders remain.
