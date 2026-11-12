## MODIFIED Requirements

### Requirement: Unlimited-credit plans
A plan MAY be flagged `unlimitedCredit`. Such a plan SHALL store credit 0 and SHALL be snapshotted as a flag into its orders and purchases.

Admission and charging:
- Its purchases SHALL be eligible while unexpired and not blocked by a window, regardless of credit.
- Charging one SHALL NOT change its credit or status (it never becomes `exhausted`). It SHALL still write a `charge` ledger row (tagged `unlimited`) and advance its windows.
- A request admitted through one SHALL always be paid in full by it, so no debt arises while one is queued.
- When every unlimited purchase is window-blocked, admission SHALL answer 429 `plan_limit` with the earliest reopen time, like any plan.
- A grant of an unlimited plan (order, admin grant, plan gift) SHALL repay no debt.

Bounds:
- An unlimited plan SHALL carry at least one bound: a window limit, an RPM or a TPM. A plan without any SHALL be rejected with a Vietnamese message.
- An unlimited purchase SHALL likewise keep at least one bound. Its window limits SHALL NOT be cleared, and its RPM/TPM override SHALL NOT be set to no limit, while it would be left with no window limit and no effective RPM or TPM (its override, else its plan's).
- A gift code for an unlimited plan without window limits SHALL NOT be saved with RPM/TPM that remove every bound. Redeeming such a code SHALL be refused.

Adjusting credit on an unlimited purchase SHALL be refused with HTTP 409. Screens SHALL show "Không giới hạn" in place of its credit figure.

#### Scenario: Charging an unlimited plan
- **WHEN** a customer whose only plan is unlimited with `{5h, $20}` makes a $3 request
- **THEN** a `charge` row of -$3 tagged `unlimited` is written, the plan's credit stays 0 and its status stays `active`, the 5-hour window shows $3 spent and no debt is created

#### Scenario: Window full
- **WHEN** that customer has spent $20 inside the 5-hour window
- **THEN** the next request is refused with 429 `plan_limit` and the window's reset time, not 402

#### Scenario: No bound on the plan
- **WHEN** an admin saves an unlimited plan with no limits and no RPM/TPM
- **THEN** the response is HTTP 400 and nothing is saved

#### Scenario: No unbounded gift
- **WHEN** an admin saves a gift code for an unlimited plan bounded only by RPM 30, with RPM 0 and TPM 0
- **THEN** the save is refused with a Vietnamese message
