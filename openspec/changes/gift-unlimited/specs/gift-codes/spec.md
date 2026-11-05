## ADDED Requirements

### Requirement: Unlimited codes
The admin MAY mark a gift code as having no total number of uses. Such a code SHALL never become exhausted; its per-account limit, validity window, active flag and new-user or channel-join rules SHALL still apply. Turning the mark off SHALL require a total of at least the uses already made. Admin screens SHALL show the total as `∞`.

#### Scenario: Many accounts redeem
- **WHEN** more accounts redeem an unlimited code than its stored total
- **THEN** every redemption within the per-account limit succeeds

#### Scenario: Back to a cap
- **WHEN** the admin turns the mark off with a total below the uses made
- **THEN** the change is refused
