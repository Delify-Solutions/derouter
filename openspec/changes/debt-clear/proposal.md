## Why

A customer holding an unlimited plan still showed a small debt ($0.0383) from a
request that finished before the plan, and nothing ever cleared it: only credit
grants repay debt, and an unlimited plan has no credit. The owner wants an admin
"Xóa nợ" button and unlimited plans to clear old debt.

## What Changes

- An unlimited grant takes over the account's whole debt (ledger `adjust` +debt,
  reason `overdraft_absorbed`); a charge paid by an unlimited purchase does the
  same, so accounts that already hold one are cleared on their next request.
- Admin "Xóa nợ" on the user overview, with a reason and the debt seen
  (`DELETE /api/users/[id]/debt`), ledger row `debt_cleared` and audit entry.
- Ledger rows that moved debt are labelled (trả nợ / gói không giới hạn trả nợ /
  admin xóa nợ) for the customer and the admin.

## Capabilities

### Modified Capabilities
- `plan-queue-billing`: Unlimited-credit plans, Debt.
- `admin-user-management`: clear a customer's debt.

## Impact

- `src/lib/billing/{ledger,grants,planQueue,adminActions}.js`, `src/lib/db/repos/accountPlansRepo.js`
- `src/app/api/users/[id]/debt/route.js`; OverviewTab, AuditTab, LedgerTab, account LedgerTable
- Tests: `test/debt-clear.test.js`, `test/unlimited-plan.test.js` case 8 updated. No schema change.
