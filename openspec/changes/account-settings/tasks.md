## 1. Email change

- [x] 1.1 Schema `emailVerifications.newEmail`, `SCHEMA_VERSION` 32 (the change token rows are written by `emailChange.js`)
- [x] 1.2 `src/lib/users/emailChange.js`: request (password, shape, same, taken, rate limit, mail or 503), confirm (transaction, race, unverified → active), cancel, pending lookup
- [x] 1.3 Mail builders and Telegram messages; activity rows
- [x] 1.4 `GET/POST/DELETE /api/account/email`, `POST /api/public/confirm-email`, page `/confirm-email` ← (verify: the email changes only after the link; a taken address is refused at request and at confirm; a second request invalidates the first link; no relay → 503 and no token left)

## 2. Password change

- [x] 2.1 Vietnamese messages and a wrong-password rate limit on `POST /api/account/password`

## 3. History

- [x] 3.1 `src/lib/account/history.js`: summary and merged timeline (security, orders, plans/gifts, expiries), group filter, offset paging
- [x] 3.2 `GET /api/account/history` ← (verify: only the caller's rows; order across sources is by time; paging returns no duplicates or gaps)

## 4. Pages and navigation

- [x] 4.1 `/account/settings` with tabs "Bảo mật" and "Lịch sử"; nav item "Tài khoản"; avatar links to it
- [x] 4.2 Liquid-glass hamburger menu in `AccountShell` below `lg` ← (verify: keyboard and screen reader operable, closes on Escape/outside/route change, reduced motion and reduced transparency honoured, AA contrast in both themes)

## 5. Checks

- [x] 5.1 `test/account-settings.test.js`
- [x] 5.2 `npm test`, `npm run lint`, `npm run build`, live check of the pages on desktop and phone widths
