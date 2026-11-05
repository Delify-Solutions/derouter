## 1. Debt write-off

- [x] 1.1 `writeOffDebtSync` in ledger.js
- [x] 1.2 Unlimited grant and unlimited-paid charge write debt off ← (verify: finite grants unchanged; pinned keys still create debt)
- [x] 1.3 `clearDebtSync` + `DELETE /api/users/[id]/debt`; "Xóa nợ" on the overview; audit label
- [x] 1.4 Ledger labels for debt rows (customer and admin)
- [x] 1.5 Tests: `test/debt-clear.test.js`, unlimited-plan case 8
