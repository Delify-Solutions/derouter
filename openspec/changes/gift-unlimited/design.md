## Decisions

### D1. Explicit flag
`maxRedemptions` keeps meaning "total" and is ignored while
`unlimitedRedemptions = 1` (a stored 1 on create). Readers used `?? 1` for NULL
in several places; a NULL-means-unlimited rule would have changed them silently.

### D2. One exhaustion rule
`giftExhausted(row)` in `src/lib/gift/window.js` is used by redemption, the admin
status, the referral-gift eligibility and the customer list; the claim's
conditional `UPDATE` also lets an unlimited code through.

### D3. Back to capped
Turning the flag off requires a total of at least the uses already made.
