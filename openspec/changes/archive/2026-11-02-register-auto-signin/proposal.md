## Why

When the admin turns email verification off, a new account is created `active`, yet `/register` still shows "Check your inbox" with a note about a single-use link. Customers wait for a mail that never comes and think signup failed.

## What Changes

- When signup creates an `active` account (email verification off), `POST /api/public/register` signs the visitor in right away, the same way `POST /api/public/login` does: `user_token` cookie, persisted session row, `lastLoginAt`. The response carries `signedIn: true`.
- `/register` then sends the browser to the valid `next`, otherwise `/account`, instead of showing the inbox screen.
- With verification on, nothing changes: the account stays `unverified`, the mail is sent and the inbox screen is shown.
- Login and signup share one helper, `startUserSession`, so both write the session the same way.

## Capabilities

### Modified Capabilities
- `account-registration`: signup without email verification signs the visitor in; the post-authentication redirect rule covers that case.

## Impact

- **Code**: `src/lib/auth/userSession.js` (new `startUserSession`), `src/app/api/public/login/route.js`, `src/app/api/public/register/route.js`, `src/app/register/components/RegisterForm.js`.
- **API**: the register response adds `signedIn` and `verificationSent` (booleans). If auto sign-in fails on an active account, the form sends the visitor to `/login` instead of the inbox screen. It never includes the user id or status.
- **Database**: none.
