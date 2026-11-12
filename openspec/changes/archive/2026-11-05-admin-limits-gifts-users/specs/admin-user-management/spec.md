## MODIFIED Requirements

### Requirement: Audited admin actions
Each action below SHALL require a reason of 3–500 characters after trimming, except where marked, and SHALL write one audit entry (actor = the signed-in admin identity, action, reason, before/after details). Actions that move money SHALL also write their ledger rows in the same transaction. Invalid input SHALL be rejected with HTTP 400 and leave everything unchanged.

| Action | Input | Allowed when | Effect | Ledger |
|---|---|---|---|---|
| Grant plan | plan id | any plan, including inactive ones | new purchase with source `admin`, limits snapshotted | `grant` |
| Grant credit | $0.01–$10,000, 1–3650 days | always | new purchase without limits | `grant` |
| Extend | +1–3650 days, or a new expiry later than now and than the start | purchase `active` or `exhausted` | expiry changed | — |
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

## ADDED Requirements

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
