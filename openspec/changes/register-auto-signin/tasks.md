## 1. Session helper

- [x] 1.1 Add `startUserSession(cookieStore, request, user, { ip })` to `src/lib/auth/userSession.js` (cookie, session row, `lastLoginAt`)
- [x] 1.2 Use it in `POST /api/public/login`

## 2. Signup

- [x] 2.1 `POST /api/public/register` signs an `active` new account in and returns `signedIn: true`; an `unverified` account keeps the verification mail and `signedIn: false`
- [x] 2.2 `/register` redirects to the valid `next` or `/account` when `signedIn` is true

## 3. Check

- [x] 3.1 `npm run lint`, `npm test`, `npm run build`
- [ ] 3.2 Merge the delta into `openspec/specs/account-registration/spec.md` and archive the change
