# admin-user-management Specification

## Purpose
Gives the operator a complete view of every customer — plans, money, usage, keys and sessions — and a set of audited actions to support, correct or stop an account, each one traceable to who did it, when and why.
## Requirements
### Requirement: Users list
`GET /api/users` SHALL accept `q` (substring of email or display name, case-insensitive), `groupId`, `status`, `planState` (`active` = holds at least one queued plan, `none` = holds none, `debt` = has debt), `sort` (`createdAt`, `lastLoginAt`, `available`, `spend30d`), `dir` (`asc`/`desc`), `page` (from 1) and `pageSize` (default 50, max 100), and SHALL return `{ users, total }` where each user carries id, email, display name, group id and name, status, number of queued plans, available credit, spend over the last 30 days, last API use, creation time and last login. Aggregates SHALL be computed with set-based queries, not one query per user. `/dashboard/users` SHALL offer the search box, the three filters, column sorting, pagination, the existing "Tạo user" action, and SHALL open the user's detail page when a row is clicked.

#### Scenario: Filter users in debt
- **WHEN** the admin selects "Đang nợ"
- **THEN** only users with debt greater than zero are listed and `total` counts them

### Requirement: User detail page
`/dashboard/users/[id]` SHALL show the tabs `Tổng quan`, `Gói`, `Đơn hàng`, `Sổ cái`, `Usage`, `API key`, `Phiên đăng nhập`, `Mã quà tặng`, `Nhật ký`, selected by the `tab` query parameter (unknown values fall back to `Tổng quan`). An unknown user id SHALL show a not-found state with a link back to the list.
- `Tổng quan`: email, display name, group (select of active groups), status, internal note, available credit, debt, spend over 7 and 30 days, key count, open session count.
- `Gói`: the queue (same presentation as the customer page, with admin actions per plan) and the plan history.
- `Đơn hàng`: the user's orders with the existing approve/cancel/refund actions.
- `Sổ cái`: the user's ledger, paginated and filterable by plan and kind.
- `Usage`: for 7 or 30 days, cost per day as a chart and a per-model table of requests, input tokens, output tokens and cost across all of the user's keys.
- `API key`: name, prefix, creation date, last use, status, and a copy button that fetches the full key on that press only (`POST /api/users/[id]/keys/[keyId]/secret`, never by GET or in the list) so the admin can test with it; each copy writes a `key_revealed` audit entry without asking for a reason.
- `Phiên đăng nhập`: creation, expiry, IP, user agent of each open session.
- `Mã quà tặng`: the user's redemptions.
- `Nhật ký`: audit entries newest first with time, actor, action, reason and before/after details.

#### Scenario: Deep link to a tab
- **WHEN** the admin opens `/dashboard/users/<id>?tab=ledger`
- **THEN** the `Sổ cái` tab is shown

### Requirement: Audited admin actions
Each action below SHALL require a reason of 3–500 characters after trimming, except where marked, and SHALL write one audit entry (actor = the signed-in admin identity, action, reason, before/after details). Actions that move money SHALL also write their ledger rows in the same transaction. Invalid input SHALL be rejected with HTTP 400 and leave everything unchanged.

| Action | Input | Allowed when | Effect | Ledger |
|---|---|---|---|---|
| Grant plan | plan id | any plan, including inactive ones | new purchase with source `admin`, limits snapshotted | `grant` |
| Grant credit | $0.01–$10,000, 1–3650 days | always | new purchase without limits | `grant` |
| Extend | +1–3650 days, or a new expiry later than now and than the start | purchase `active` or `exhausted` | expiry changed | — |
| Adjust credit | non-zero signed amount, absolute value ≤ $10,000 | purchase `active` or `exhausted`, result ≥ 0 | result 0 → `exhausted`; from 0 to > 0 with expiry in the future → `active` | `adjust` |
| Edit limits | limits valid per `plan-templates` against this purchase's credit and duration | purchase `active` or `exhausted` | window state of removed lengths deleted; spent kept for kept lengths | — |
| Revoke | — | purchase `active` or `exhausted` | status `revoked`, remaining credit set to 0 | `revoke` (negative remaining) |
| Reorder queue | full ordered id list (reason not required) | as in `plan-queue-billing` | priorities 1..n | — |
| Disable / enable / delete key | key id; delete needs confirmation | key belongs to the user | effective on the next request | — |
| Copy key (reason not required) | key id | key belongs to the user (otherwise HTTP 404); at most 30 per minute per admin identity (then HTTP 429) | the full key is returned to the admin; the audit entry `key_revealed` names the key, never its value | — |
| Revoke one / all sessions | session id or all | session belongs to the user | session(s) can no longer authenticate | — |
| Change group | active group id | always | effective on the next request | — |
| Change status | `active`, `suspended`, `unverified` | always | `suspended`/`unverified` also revokes all sessions and blocks the API | — |
| Edit note (reason not required) | text ≤ 2000 characters | always | `adminNote` saved | — |
| Reset password | password per `account-registration` | always | all sessions revoked; the password is never logged | — |

#### Scenario: Adjust below zero refused
- **WHEN** the admin subtracts $30 from a purchase with $20 remaining
- **THEN** the response is HTTP 400 and neither the purchase nor the ledger changes

#### Scenario: Revoke records money and audit
- **WHEN** the admin revokes a purchase with $120 remaining and reason "Hoàn tiền ngoài hệ thống"
- **THEN** the purchase is `revoked` with $0 remaining, one `revoke` ledger row of -$120 exists, and the audit log shows the action, the admin and the reason

#### Scenario: Copy key is audited without the secret
- **WHEN** the admin presses "Sao chép" on a key of the user
- **THEN** the full key is copied to the clipboard and the audit log shows `key_revealed` with the admin, the key id and name, and no key value

#### Scenario: Missing reason
- **WHEN** the admin submits "Grant credit" with an empty reason
- **THEN** the response is HTTP 400 and no purchase is created

### Requirement: Cascade delete
`DELETE /api/users/[id]` SHALL require a body `{ confirmEmail }` equal to the user's email (case-insensitive) and otherwise answer HTTP 400. On success it SHALL, in one transaction, delete the user's keys, sessions, verification tokens, purchases, window state, ledger rows, gift redemptions and audit entries and the user row; keep the user's orders (which carry the email snapshot); and write one audit entry `user_deleted` holding the user id and email.

#### Scenario: Orders survive deletion
- **WHEN** a user with 2 paid orders is deleted
- **THEN** both orders remain with the user's email visible on the orders page and the plan revenue figures are unchanged


### Requirement: Usage by customer
The admin usage page SHALL have a "Users" tab (`/dashboard/usage?tab=users`; the old `?tab=keys` opens it) that groups usage by the customer who owns the key, because one customer may hold many keys. For a chosen period (today, 24 hours, 7, 30 or 60 days; default 30 days) each customer SHALL be one row with: email (linked to their user detail page), display name and group, active and total key count, requests, input, output and input-cache tokens (marked `≈` when part of the figure is estimated), cost, peak requests and peak tokens in one minute summed over all of their keys, and the time of their last request. Opening a row SHALL show each of their keys (name, masked key showing only the prefix and last four characters, status, requests, tokens, cost, last request) and each model they called (by the model name the client asked for). Customers who own keys but made no request in the period SHALL be listed with zero figures; a "With requests" filter SHALL hide them. Keys with no owner SHALL be grouped as one "Admin keys" row, where requests made without any key (local traffic) appear as a "No key (local)" line, and usage whose key no longer exists as one "Deleted or unknown keys" row. An invalid period bound SHALL be answered with HTTP 400. Rows SHALL be sorted by cost, highest first, and searchable by email, name, group, key name or masked key. The data SHALL come from the admin-only `GET /api/usage/user-summary`, which SHALL NOT return any key secret or request payload.

#### Scenario: One customer, two keys
- **WHEN** a customer made 3 requests with their laptop key and 2 with their server key in the period
- **THEN** the Users tab shows one row for that customer with 5 requests and the summed tokens and cost, and opening it lists both keys with 3 and 2 requests

#### Scenario: Idle customer
- **WHEN** a customer owns a key but made no request in the period
- **THEN** they are listed with 0 requests and "—" as last request, and disappear when "With requests" is selected

### Requirement: Request details show the key owner
Every row of the admin request details (`/dashboard/usage?tab=details`) and its detail panel SHALL show who made the request: the owner's e-mail for a customer key, "Key admin" for a key with no owner, or "Key đã xóa / không rõ" for a key that no longer exists, then the key's name and its masked value. `GET /api/usage/request-details` SHALL return this as `keyInfo` per row and SHALL accept `userId` to list the requests of every key that customer owns. The page SHALL offer a "Người dùng" filter searching customers by e-mail, and clicking an owner's e-mail in the table SHALL apply that filter. The raw key SHALL NOT be shown.

#### Scenario: Whose request is this
- **WHEN** an admin opens request details and a row came from the key "A laptop" of a@x.vn
- **THEN** the row shows "a@x.vn" over "A laptop · sk-…****…", and clicking "a@x.vn" lists only requests from a@x.vn's keys
