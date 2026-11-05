## Why

The owner wants gift codes with no total number of uses (an open promo code).

## What Changes

- New flag `giftCodes.unlimitedRedemptions`: the code never runs out; the
  per-account limit, window, active flag and new-user / channel-join rules still
  apply. An explicit flag, not a NULL max, so no existing row changes meaning.
- Admin form: "Không giới hạn tổng lượt" toggle; lists show `12 / ∞`.
- Schema v35.

## Capabilities

### Modified Capabilities
- `gift-codes`: unlimited codes.

## Impact

- `src/lib/db/schema.js`, `src/lib/gift/window.js` (`giftExhausted`), `src/lib/db/repos/giftRepo.js`,
  `src/lib/affiliate/gift.js`, `src/app/api/gift-codes/**`, `src/app/api/affiliates/gift-codes`,
  admin gift-code pages, `PopupCard.js`; `test/gift-unlimited.test.js`
