## Decisions

### D1. One write-off helper
`writeOffDebtSync(db, userId, { userPlanId, meta, createdAt })` sets the debt to 0
and writes one `adjust` ledger row of +debt with `meta.reason`. The unlimited grant,
the charge path and the admin action all use it.

### D2. Unlimited takes over debt at grant and at charge
At grant: the first period of an unlimited grant writes the debt off on its own
purchase; it is reported as `appliedToOverdraftNanoUsd`. At charge: when any part
of a request was paid by an unlimited purchase, older debt is written off in the
same transaction, but only when no overdraft charge was recorded since that
purchase started: debt from before it is "old" and taken over; a shortfall since
(a key pinned to a finite plan never reaches the unlimited purchase) is new debt
and stays for a credit grant or the admin. That clears accounts that held an
unlimited plan before this rule, without a migration.

### D3. Admin write-off carries the amount seen
`clearDebtSync` requires `expectNanoUsd` (400 when missing) and refuses when the current debt differs from `expectNanoUsd`, so a
click never clears more than what was on screen.
