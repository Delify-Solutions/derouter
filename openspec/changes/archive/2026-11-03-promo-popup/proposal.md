## Why

The owner wants to advertise promotions (typically a gift code) to visitors of the landing page, and make claiming them frictionless: copy the code with one click, sign up, and land on the gift page with the code already filled in.

## What Changes

- A promotional popup, edited in Admin → Nội dung next to the announcement banner: on/off, title, body, gift code, button text, delay before showing, and minutes before showing again after a visitor closes it (default 5; 0 = every page load).
- Shown on the landing page, `/register`, `/docs` and every `/account` page (except the gift page) of a new account. A new account (owner decision, change telegram-admin) never received any plan or credit of any source and never redeemed a gift code; signed-in customers on the public pages follow the same rule.
- Clicking the code copies it. The button sends a visitor to `/register?next=/account/gift?code=…` (a signed-in customer straight to the gift page); a "Đăng nhập để nhập mã" link covers existing accounts.
- The code is also remembered in the browser for 7 days, so a visitor who signs up another way still lands on the gift page with it prefilled.
- `/account/gift` prefills `?code=` or the remembered code; a successful redemption clears both.
- The admin card shows live/hidden status, warns when the code is not an active gift code, and previews the dialog.

## Capabilities

### New Capabilities
- `promo-popup`: the promotional popup and the code hand-off to the gift page.

### Modified Capabilities
- None.

## Impact

- `src/shared/utils/promoPopup.js` (new), `src/app/landing/components/PromoPopup.js` (new), `src/app/(dashboard)/dashboard/content/PopupCard.js` (new).
- `contentRepo.js` (new copy keys, boolean keys set), `/api/landing-copy` (validation), `LandingPage.js`, `ContentPageClient.js`, `RegisterForm.js`, `GiftRedeemForm.js`.
- `PromoPopupSlot.js` (server slot used by the landing page, `/register`, `/docs`, the account layout), `src/lib/promo/newAccount.js`, `GET /api/account/promo-popup`.
- No schema change: the settings live in the `landingCopy` settings blob.
