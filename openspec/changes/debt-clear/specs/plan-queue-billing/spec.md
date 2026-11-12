## MODIFIED Requirements

### Requirement: Unlimited-credit plans
A plan MAY be flagged `unlimitedCredit`. Such a plan SHALL store credit 0, SHALL be snapshotted as a flag into its orders and purchases, and its purchases SHALL be eligible while unexpired and not blocked by a window, regardless of credit. Charging one SHALL NOT change its credit or status (it never becomes `exhausted`) but SHALL still write a `charge` ledger row (tagged `unlimited`) and advance its windows; a request admitted through one SHALL always be paid in full by it, so no debt arises while one is queued. When every unlimited purchase is window-blocked, admission SHALL answer 429 `plan_limit` with the earliest reopen time, like any plan. A grant of an unlimited plan (order, admin grant, plan gift) SHALL take over the account's whole existing debt: the debt becomes zero and one `adjust` ledger row of +debt (reason `overdraft_absorbed`, on that purchase) records it. When an unlimited purchase pays for a request while debt from before that purchase started remains, that debt SHALL be taken over the same way; debt recorded after it started (a key pinned to another plan) SHALL stay. An unlimited plan SHALL carry at least one bound: a window limit, an RPM or a TPM, and a plan without any SHALL be rejected with a Vietnamese message. Adjusting credit on an unlimited purchase SHALL be refused with HTTP 409, and its window limits SHALL NOT be cleared while the plan has no RPM or TPM. Screens SHALL show "Không giới hạn" in place of its credit figure.

#### Scenario: Charging an unlimited plan
- **WHEN** a customer whose only plan is unlimited with `{5h, $20}` makes a $3 request
- **THEN** a `charge` row of -$3 tagged `unlimited` is written, the plan's credit stays 0 and its status stays `active`, the 5-hour window shows $3 spent and no debt is created

#### Scenario: Window full
- **WHEN** that customer has spent $20 inside the 5-hour window
- **THEN** the next request is refused with 429 `plan_limit` and the window's reset time, not 402

#### Scenario: No bound on the plan
- **WHEN** an admin saves an unlimited plan with no limits and no RPM/TPM
- **THEN** the response is HTTP 400 and nothing is saved

#### Scenario: Unlimited plan takes over old debt
- **WHEN** a customer with $0.04 debt is granted an unlimited plan
- **THEN** the debt becomes zero and the ledger shows +$0.04 marked as paid by the unlimited plan

#### Scenario: Pinned-key debt is not taken over
- **WHEN** a key pinned to a finite plan overruns it while the account also holds a running unlimited plan, and a later request is paid by the unlimited plan
- **THEN** the debt from the pinned key stays

#### Scenario: Existing unlimited plan with debt
- **WHEN** a customer who already holds an unlimited plan and has older debt makes a request paid by that plan
- **THEN** the debt becomes zero in the same transaction as the charge

### Requirement: Debt
Debt SHALL be repaid first by any later grant; an unlimited grant takes it over whole (see Unlimited-credit plans). An admin MAY write the whole debt off with a reason (see admin-user-management). While debt exists, available credit SHALL be reported as the sum of the queue's remaining credit minus the debt, floored at zero.

#### Scenario: Grant repays debt
- **WHEN** a user with $0.70 debt is granted a $250 plan
- **THEN** the debt becomes zero and the new plan has $249.30 credit
