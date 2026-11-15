## MODIFIED Requirements

### Requirement: Audited admin actions
Each action below SHALL require a reason of 3–500 characters after trimming, except where marked, and SHALL write one audit entry (actor = the signed-in admin identity, action, reason, before/after details). Actions that move money SHALL also write their ledger rows in the same transaction. Invalid input SHALL be rejected with HTTP 400 and leave everything unchanged.

| Action | Input | Allowed when | Effect | Ledger |
|---|---|---|---|---|
| Grant plan | plan id | any plan, including inactive ones | new purchase with source `admin`, limits snapshotted | `grant` |
| Grant credit | $0.01–$10,000, 1–3650 days | always | new purchase without limits | `grant` |
| Set expiry | an exact `expiresAt`, or signed `days` (non-zero, absolute value 1–3650) | purchase `active` or `exhausted`; the resulting expiry later than now and later than the purchase's `startsAt` | `expiresAt` replaced, earlier or later; balance, windows and status unchanged | — |
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

## ADDED Requirements

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
