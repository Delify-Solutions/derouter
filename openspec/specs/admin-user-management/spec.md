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
| Set expiry | an exact `expiresAt`, or signed `days` (non-zero, absolute value 1–3650) | purchase `active` or `exhausted`; the resulting expiry later than now and later than the purchase's `startsAt` | `expiresAt` replaced, earlier or later; balance, windows and status unchanged | — |
| Adjust credit | non-zero signed amount, absolute value ≤ $10,000 | purchase `active` or `exhausted`, result ≥ 0 | result 0 → `exhausted`; from 0 to > 0 with expiry in the future → `active` | `adjust` |
| Edit limits | limits valid per `plan-templates` against this purchase's credit and duration | purchase `active` or `exhausted` | window state of removed lengths deleted; spent kept for kept lengths | — |
| Edit RPM/TPM | per purchase: empty (follow the plan), 0 (no limit) or an integer up to 1,000,000,000 | purchase `active` or `exhausted`; an unlimited-credit purchase must keep a window limit or a rate | the purchase's override is saved and applies on the next request (spec plan-templates "Per-purchase rate override"); audit `plan_rates_changed` | — |
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

#### Scenario: Shortening keeps what the customer holds
- **WHEN** an admin moves a $250 purchase from 12 Dec to 20 Nov with reason "khách xin rút ngắn"
- **THEN** the expiry becomes 20 Nov, the purchase stays `active` with $250 remaining, no `expire` ledger row is written, and the audit entry `plan_expiry_set` records `direction: "shortened"`

#### Scenario: Extending by days
- **WHEN** an admin adds 10 days to a purchase expiring tomorrow
- **THEN** the expiry moves 10 days later than the current expiry and the audit entry records `direction: "extended"`

#### Scenario: A past expiry is revoke's job
- **WHEN** an admin sets an expiry earlier than now, or subtracts more days than the purchase has left
- **THEN** the response is HTTP 400 with a message pointing at "Thu hồi", and nothing changes

### Requirement: Cascade delete
`DELETE /api/users/[id]` SHALL require a body `{ confirmEmail }` equal to the user's email (case-insensitive) and otherwise answer HTTP 400. On success it SHALL, in one transaction, delete the user's keys, sessions, verification tokens, purchases, window state, ledger rows, gift redemptions, support-chat messages and audit entries and the user row; keep the user's orders (which carry the email snapshot); and write one audit entry `user_deleted` holding the user id, email and, when the caller supplied one, the deletion reason.

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
Every row of the admin request details (`/dashboard/usage?tab=details`) and its detail panel SHALL show who made the request: the owner's e-mail for a customer key, "Key admin" for a key with no owner, or "Key đã xóa / không rõ" for a key whose owner is not known, then the key's name and its masked value. The owner SHALL be recorded on the row when the request is logged, so a request made with a key that was deleted afterwards still shows that owner (marked "key đã xóa") and still appears under that customer's `userId` filter. Deleting the account SHALL drop that recorded owner from its request rows. `GET /api/usage/request-details` SHALL return this as `keyInfo` per row and SHALL accept `userId` to list the requests of every key that customer owns. The page SHALL offer a "Người dùng" filter searching customers by e-mail, and clicking an owner's e-mail in the table SHALL apply that filter. The raw key SHALL NOT be shown.

#### Scenario: Whose request is this
- **WHEN** an admin opens request details and a row came from the key "A laptop" of a@x.vn
- **THEN** the row shows "a@x.vn" over "A laptop · sk-…****…", and clicking "a@x.vn" lists only requests from a@x.vn's keys

#### Scenario: Key deleted after the request
- **WHEN** a@x.vn makes a request with key "A old laptop" and then deletes that key
- **THEN** the row still shows "a@x.vn" with "key đã xóa", and filtering by a@x.vn still lists it

### Requirement: Bulk delete
`DELETE /api/users` SHALL accept `{ userIds: string[], reason }` and delete up to 50 distinct accounts per request. `reason` SHALL be required (3–500 characters) because the single-account email confirmation is unusable for a batch; `userIds` SHALL be de-duplicated and empty ids dropped. A request with no ids, or more than 50, SHALL be answered with HTTP 400 and delete nothing. Each account SHALL be deleted through the same cascade as `DELETE /api/users/[id]`, and each SHALL receive its own `user_deleted` audit entry carrying the reason. A failure on one account SHALL NOT abort the rest; the response SHALL report `deleted`, `missing` and `failed` separately.

The users list SHALL offer a checkbox per row, a select-all for the current page, the number selected, and a confirmation that lists the exact emails, requires the reason, and is disabled until the reason is long enough. Changing page, filter or sort SHALL clear the selection, so no account is deleted while off screen.

#### Scenario: Deleting a batch
- **WHEN** an admin selects 2 accounts, gives the reason "dọn tài khoản test" and confirms
- **THEN** both are deleted, the response reports 2 deleted with their emails, and each has a `user_deleted` audit row carrying that reason

#### Scenario: The reason survives the audit wipe
- **WHEN** an account is deleted with a reason
- **THEN** the reason is readable on the surviving `user_deleted` audit row, even though the account's other audit entries were deleted by the cascade

#### Scenario: Too many
- **WHEN** a request carries 51 account ids
- **THEN** the response is HTTP 400 and no account is deleted

#### Scenario: Changing the page clears the selection
- **WHEN** an admin selects rows and then changes the page or a filter
- **THEN** nothing remains selected and the bulk action disappears

### Requirement: Lock and delete from the user page
The user detail header SHALL offer:
- **"Khóa tài khoản"**, or **"Mở khóa"** when the account is suspended. It SHALL perform the audited status change to `suspended` or `active`, with a required reason.
- **"Xóa tài khoản"**. It SHALL perform the cascade delete. The confirm button SHALL be enabled only once the account's email is typed back, and the dialog SHALL list what is removed and what is kept. After deletion the admin SHALL return to the users list.

#### Scenario: Lock from the header
- **WHEN** the admin clicks "Khóa tài khoản" and confirms with a reason
- **THEN** the account becomes `suspended`, its sessions are revoked, its API keys are refused, and the header offers "Mở khóa"

#### Scenario: Delete needs the email
- **WHEN** the admin opens "Xóa tài khoản" and types a different email
- **THEN** the delete button stays disabled
