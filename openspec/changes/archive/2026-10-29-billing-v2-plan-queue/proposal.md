## Why

derouter already ships signup, plans, manual orders, gift codes and groups, but its billing core contradicts the product the operator wants to sell (an OpenCode Go–style subscription). Commit `6fbcc1d` turned plans into per-model ceilings that are summed across every plan a customer holds and never draw down credit, while the operator wants each purchase to be its own shared credit pool (e.g. "Go": pay $10 → $250 usable on any model), drained one plan at a time in an order the customer chooses, with spending limits per time window that the admin configures per plan. Several foundation gaps also block selling it: groups are not enforced on customer keys, suspended accounts can still call the API, customers have no page to create API keys, and the admin cannot inspect or act on a single customer in depth.

## What Changes

Delivered in five phases (GĐ0 → GĐ4). Payment automation is explicitly out of scope; buying keeps the existing "pending order → admin approves" flow.

**GĐ0 — Foundation fixes**
- **BREAKING** A customer key (an `apiKeys` row with `userId`) resolves its group from the owner's `users.groupId` on every request: model allow-list, RPM and TPM come from that group. Calling a model outside the group returns 403. `apiKeys.groupId` is ignored and cleared for customer keys.
- **BREAKING** RPM/TPM for customer keys are counted across all keys of the same user (today each key gets its own allowance, so creating keys bypasses the limit).
- **BREAKING** Accounts whose status is not `active` (`suspended`, `unverified`) are rejected on every LLM endpoint and on `/v1/models` with 403.
- **BREAKING** Every platform-level denial (key, group, account, plan) returns the OpenAI error shape `{ error: { message, type, code } }` with a Vietnamese message and a stable `code`; this changes the bodies of the existing RPM/TPM/budget/expiry denials.
- Every customer always has exactly one active group: a "Mặc định" group is seeded when none is active, the default-group setting only accepts active groups, and a group that still has members or is the default cannot be deleted or deactivated.
- The admin Endpoint & Key page and `GET /api/keys` only list admin keys (no `userId`); customer keys and their secrets are never returned there.
- New customer page `/account/keys` (linked from the account UI today but missing): list, create (secret shown once), delete.
- Deleting a user removes all of that user's data in one transaction; orders are kept with an email snapshot (`orders.emailSnapshot`) and one audit entry records the deletion.
- Per-IP/per-email rate limits on register, resend-verification and forgot-password; an admin warning when email verification is on but no mail relay is configured; password minimum is 10 characters everywhere (admin create/reset currently allows 8).
- A read-only report script lists, per group, models its users called in the last 30 days that the group does not allow, and users whose combined per-minute traffic would exceed the group RPM — run before deploying GĐ0.

**GĐ1 — Plan queue billing core**
- **BREAKING** Each purchased plan (`userPlans` row) is an independent credit pool with its own expiry and its own time-window limits (snapshotted at grant). Plans form a queue per user ordered by explicit `priority`, then earliest expiry, then creation time.
- **BREAKING** Admission: a request runs if any queued plan has credit, is unexpired and has room in every window; otherwise 429 `plan_limit` (with `Retry-After`) when some plan is only window-blocked, or 402 `insufficient_quota`.
- **BREAKING** Charging (after the request completes): pass 1 walks the queue taking at most min(credit left, tightest window room) per plan; pass 2 takes any remainder from plans with credit ignoring windows; anything left becomes overdraft. Windows are "first-use fixed": opened by the first charge, reset to zero after their length.
- Plan templates gain a `limits` list (window hours + max USD), validated; orders snapshot limits at creation; grants (order approval, refund, gift, admin) snapshot limits.
- **BREAKING** Per-model ceilings are removed: the `planModelLimits` table (migration 006 and its removal from `schema.js`), `planAllowance.js`, `planLimitsRepo.js`, `/api/plans/[id]/model-limits`, `/api/account/quota` (the page redirects to `/account/plans`), the `x-plan-model-*` headers, the "skip charge while on a plan" branch, and the plan-based narrowing of `/v1/models`.
- New tables `userPlanWindows` (window counters) and `userAuditLog`; `creditLedger` gains `usageId` and an index by plan.
- One-time backfill charges tenant usage rows since `2026-10-28T19:22:58Z` that were never charged, only against plans active at the usage time, without touching window counters.
- The admin plan form replaces the per-model block with a limits editor and a plain-language preview.

**GĐ2 — Customer portal**
- `/account/plans` becomes "Gói của tôi": a reorderable queue (drag or ↑/↓, explicit save) showing per-plan credit, expiry, each window's usage and reset time, and status (Đang trả / Chờ / Tạm khoá đến HH:MM); purchase cards show credit, duration and limits; order list; plan history.
- New `/account/ledger` page; reworked `/account` overview; every account page localized to Vietnamese.

**GĐ3 — Admin user and plan management**
- Paginated, searchable, filterable users list with credit and 30-day spend; new `/dashboard/users/[id]` detail page with tabs (overview, plans, orders, ledger, usage, API keys, sessions, gift codes, audit log).
- Admin actions with a mandatory reason, each writing ledger rows (money) and an audit entry: grant plan, grant credit, extend, adjust credit, edit a purchased plan's limits, revoke, reorder, disable/enable/delete key, revoke sessions, change group/status/note, reset password, delete user.
- Plans page shows active count, users, revenue and consumed credit per plan, and can apply edited limits to the plan's active purchases.

**GĐ4 — Landing and content**
- Plan cards state price, total credit "dùng chung mọi model", duration and limits; the model list comes from the default group with token prices; rewritten default copy and FAQ; "Chọn gói" goes through register/login with a validated `next` back to the chosen plan.

## Capabilities

### New Capabilities
- `api-access-enforcement`: how an LLM request with an API key is authorized — owner group resolution, per-user RPM/TPM, account status, admin vs customer key separation, platform error format and denial logging.
- `customer-groups`: group lifecycle for customers — always one active group per user, default group selection and seeding, delete/deactivate guards, the pre-deploy coverage report.
- `account-registration`: signup/verification/reset abuse limits, mail-relay warning, password policy, post-auth `next` redirect.
- `plan-queue-billing`: purchased-plan queue, admission, two-pass charging, time windows, grants and snapshots, expiry, overdraft, backfill.
- `plan-templates`: admin-defined plans with time-window limits, validation, order snapshot, apply-to-active, per-plan statistics, removal of per-model ceilings.
- `customer-portal`: customer-facing account pages — API keys, plan queue management, ledger, overview, localization.
- `admin-user-management`: users list, user detail, admin actions with reasons, audit log, cascade delete.
- `public-landing`: landing page plan cards, sellable model list, copy/FAQ and the plan-selection entry flow.

### Modified Capabilities
<!-- openspec/specs/ contains no specs yet; every capability above is new. -->

## Impact

- **Code**: `src/lib/db/schema.js`, `src/lib/db/migrate.js`, `src/lib/db/migrations/`, `src/lib/db/repos/{billingRepo,apiKeysRepo,keyGroupsRepo,userRepo,usageRepo,giftRepo,settingsRepo}.js`, new `src/lib/billing/{limits,planQueue}.js`, new `src/lib/db/repos/auditRepo.js`, `src/lib/auth/keyEnforcement.js`, `src/sse/services/auth.js`, `src/app/api/v1/models/route.js`, `src/app/api/{keys,groups,users,plans,orders,account,public,settings}/**`, `src/app/account/**`, `src/app/(dashboard)/dashboard/{users,plans,groups,endpoint,profile,orders}/**`, `src/app/landing/**`, `src/app/{login,register,verify-email}/**`, `src/lib/db/repos/contentRepo.js`, `scripts/`, `test/`.
- **Removed**: `src/lib/auth/planAllowance.js`, `src/lib/db/repos/planLimitsRepo.js`, `src/app/api/plans/[id]/model-limits/route.js`, `src/app/api/account/quota/route.js`, `src/app/(dashboard)/dashboard/plans/components/PlanModelLimits.js`.
- **Database**: new columns (`orders.emailSnapshot`, `orders.limits`, `plans.limits`, `userPlans.priority`, `userPlans.limits`, `creditLedger.usageId`, `users.adminNote`), new tables (`userPlanWindows`, `userAuditLog`), dropped table (`planModelLimits`), `SCHEMA_VERSION` bumped in each phase that changes schema (automatic pre-change backup), one-time post-sync tasks recorded in `_meta`.
- **API contract**: platform denial bodies change shape (OpenAI error object with `code`); 402/429 semantics now come from the plan queue; `/v1/models` lists the owner group's models only.
- **Live customers**: GĐ0 can start returning 403/429 to customers who relied on unrestricted keys or many keys — run the coverage report and fix group allow-lists before deploying. GĐ1 converts existing purchases to shared pools and back-charges the uncharged usage since `6fbcc1d`.
- **Dependencies**: none new (`@dnd-kit/*` and `recharts` are already installed).
