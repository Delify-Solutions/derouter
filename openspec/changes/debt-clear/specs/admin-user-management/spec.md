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
| Revoke | — | purchase `active` or `exhausted` | status `revoked`, remaining credit set to 0 | `revoke` (negative remaining) |
| Reorder queue | full ordered id list (reason not required) | as in `plan-queue-billing` | priorities 1..n | — |
| Disable / enable / delete key | key id; delete needs confirmation | key belongs to the user | effective on the next request | — |
| Copy key (reason not required) | key id | key belongs to the user (otherwise HTTP 404); at most 30 per minute per admin identity (then HTTP 429) | the full key is returned to the admin; the audit entry `key_revealed` names the key, never its value | — |
| Revoke one / all sessions | session id or all | session belongs to the user | session(s) can no longer authenticate | — |
| Change group | active group id | always | effective on the next request | — |
| Change status | `active`, `suspended`, `unverified` | always | `suspended`/`unverified` also revokes all sessions and blocks the API | — |
| Edit note (reason not required) | text ≤ 2000 characters | always | `adminNote` saved | — |
| Reset password | password per `account-registration` | always | all sessions revoked; the password is never logged | — |
| Clear debt | the debt amount shown (required) | debt > 0 and equal to the amount shown (otherwise HTTP 409) | debt set to 0 | `adjust` (+debt, reason `debt_cleared`) |

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

### Requirement: Clear a customer's debt
On the user's overview, an admin SHALL be able to write the account's whole debt off with a reason of 3–500 characters. The debt SHALL become zero, one `adjust` ledger row of +debt (reason `debt_cleared`) and one `debt_cleared` audit entry SHALL be written in one transaction. The request SHALL carry the debt the admin saw (missing → HTTP 400), and a debt that changed since SHALL be refused (HTTP 409) without clearing anything. An account with no debt SHALL be refused (HTTP 409).

#### Scenario: Clear a small debt
- **WHEN** an admin clears a $0.0383 debt with reason "nợ lẻ khi hết gói"
- **THEN** the debt shows $0, the ledger has +$0.0383 marked "admin xóa nợ" and the audit log shows "Xóa nợ"

#### Scenario: Debt grew meanwhile
- **WHEN** the debt changed between opening the dialog and confirming
- **THEN** the response is HTTP 409 and the debt is unchanged
