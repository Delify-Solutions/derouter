## MODIFIED Requirements

### Requirement: Plan rates
A plan SHALL carry an optional `rpm` (requests per minute) and `tpm` (tokens per minute). Each is either empty/0 (stored NULL, unlimited) or a positive integer. A negative or fractional value SHALL be rejected with a Vietnamese message naming RPM or TPM.

They SHALL NOT be snapshotted into orders or purchases. They are read from the plan on every request, so a changed value applies at once to every holder whose purchase has no override of its own (see "Per-purchase rate override").

The admin plan form SHALL offer both fields, and the plan card SHALL show them. The customer catalogue SHALL list them as "N request mỗi phút" / "N token mỗi phút" when set.

#### Scenario: Setting rates
- **WHEN** an admin saves a plan with RPM 60 and TPM 200000
- **THEN** the plan stores both, and the landing and purchase cards list "60 request mỗi phút" and "200.000 token mỗi phút"

#### Scenario: Clearing rates
- **WHEN** an admin saves a plan with RPM and TPM left empty or 0
- **THEN** both are stored as unlimited and no rate line is shown

## ADDED Requirements

### Requirement: Per-purchase rate override
A purchase (`userPlans`) SHALL carry its own optional `rpm` and `tpm`, each meaning:
- NULL = follow the plan's live value;
- 0 = no limit;
- a positive integer = that rate.

The rate applied while the purchase pays SHALL be its override when set, else its plan's. The same value SHALL be used everywhere:
- request enforcement and the concurrency cap;
- the account page;
- `/usage`;
- the admin queue.

The allowance SHALL be counted per (user, plan) for a purchase with a plan, override or not. A purchase without a plan that has an override SHALL have its own allowance. A purchase without a plan and without an override SHALL have no rate limit. Usage SHALL be recorded under the same allowance it is checked against.

#### Scenario: Higher rate for one customer
- **WHEN** a plan has RPM 60 and an admin sets RPM 600 on one customer's purchase of it
- **THEN** that customer may make 600 requests a minute while the purchase pays, and every other holder of the plan stays at 60

#### Scenario: Back to the plan
- **WHEN** the admin clears the override (empty field)
- **THEN** the purchase follows the plan's RPM again, including later changes to the plan

#### Scenario: Rate on a credit gift
- **WHEN** a purchase granted by a credit gift has an RPM override of 20
- **THEN** its requests are limited to 20 a minute, counted on that purchase alone
