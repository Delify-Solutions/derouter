## Why

The owner wants to find and ban abusers: several accounts run by one person, a key shared across many machines, someone farming welcome gifts. Today only login sessions keep an IP. API requests and account actions keep none. In production the IP that is kept is probably the Docker gateway rather than the customer: the app runs in Docker behind nginx on the host, `custom-server.js` trusts forwarding headers only from a loopback peer, and nginx reaches the container from the bridge gateway.

## What Changes

- **Real client IP behind a local proxy.**
  - `custom-server.js` trusts `X-Real-IP`/`X-Forwarded-For` from a loopback peer as before, and — **opt-in with `TRUST_PRIVATE_PROXY=true`** — from a private-address peer (10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10). That covers nginx on the Docker host. The opt-in exists because it is only safe when that nginx overwrites the headers and the published port is not reachable around it.
  - It reads `X-Real-IP` first. Failing that it takes the **last** `X-Forwarded-For` hop, the one written by the nearest proxy: the first hop is whatever the client sent.
  - This also fixes the login and signup rate limits, which key on the same IP.
- **IP on every API request.** `usageHistory.clientIp` is written for chat, embeddings, images, the Gemini-style route and platform denials.
- **Activity log for account actions.** A new table `activityLog` records `(userId, action, ip, userAgent, details, createdAt)` for:
  - register, login (and failed login on a known email), logout;
  - password change and reset, email verified;
  - API key created / changed / deleted / revealed;
  - order created, gift code redeemed (and refused);
  - plan queue reordered;
  - Telegram linked / unlinked.

  Writing it never fails the action.
- **Admin lookup.**
  - A new "IP" tab on the user page lists every IP the account used, from web actions and API requests, with counts, first and last seen, and how many **other** accounts used the same IP. It also shows the recent activity.
  - Clicking an IP lists every account seen on it, with status and a link, so the admin can suspend them with the existing action.
  - The users list search also matches an IP.
- Banning stays the existing account suspension (owner's choice). There is no IP block list.

## Capabilities

### New Capabilities
- `activity-ip-log`: client IP resolution, IP on API usage, the account activity log and the admin IP lookup.

## Impact

- **Database** (`SCHEMA_VERSION` 24 → 25, additive): `usageHistory.clientIp` + index, new table `activityLog` with indexes on `(userId, createdAt)` and `(ip, createdAt)`.
- **Code**:
  - `custom-server.js`; `src/lib/auth/clientIp.js` (new);
  - `src/lib/db/repos/activityRepo.js` (new) and `usageRepo.js`;
  - chat/embeddings/image handlers and `open-sse/handlers/chatCore*` (pass `clientIp`);
  - the customer and public routes listed above;
  - the admin user page, plus `src/app/api/users/[id]/ips`, `src/app/api/ip-lookup` (`?ip=`), the users search and the customer playground (forwards the IP stamp).
- **Deployment**: set `TRUST_PRIVATE_PROXY=true` only after checking that nginx sends `proxy_set_header X-Real-IP $remote_addr;` (or `X-Forwarded-For $proxy_add_x_forwarded_for`), and preferably bind the published port to `127.0.0.1`.
- **Privacy**: IPs are personal data. They are visible to admins only and never returned to customers.
- **Depends on** the `new-user-gift-telegram` branch (Telegram link actions are logged).
