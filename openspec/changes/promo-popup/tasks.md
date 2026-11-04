## 1. Settings

- [x] 1.1 Landing-copy keys for the popup, boolean keys set in `mergeLandingCopy`, PATCH validation
- [x] 1.2 `src/shared/utils/promoPopup.js`: parsing, state, version, target links, dismissal and pending-code storage

## 2. Visitor

- [x] 2.1 `PromoPopup` on the landing page: delay, dismissal, copy, accessible dialog
- [x] 2.2 Register and login forms go to the gift page when a code is pending and no `next` is given
- [x] 2.3 Gift form prefills `?code=` / pending code; clears both after redeeming

## 3. Admin

- [x] 3.1 `PopupCard` in Admin → Nội dung: fields, status, unknown-code warning, preview

## 4. Everywhere, minutes (follow-up)

- [x] 4.1 Repeat window in minutes (`popupRepeatMinutes`, default 5, 0 = every page load); admin field updated
- [x] 4.2 `PromoPopupSlot` on landing, `/register`, `/docs`, docs pages, account layout (new accounts only, not on `/account/gift`); only popup keys sent to the browser
- [x] 4.3 Re-arm on route change; re-check new-account status with `GET /api/account/promo-popup` before opening; release scroll lock on hidden paths
- [x] 4.4 Tests: minutes window, new-account audience (purchase, redemption, dashed codes)

## 5. Check

- [x] 5.1 Tests: settings parsing and bounds, admin-save validation, version, target links and `safeNext`, dismissal window, pending code storage, boolean merge
- [x] 5.2 `npm run lint`, `npm test`, `npm run build`; Playwright run of popup → copy → register → prefilled gift page → redeem, mobile, admin card
- [ ] 5.3 Merge deltas into `openspec/specs/` and archive
