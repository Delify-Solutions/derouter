## Decisions

### D1. Which peers may assert the client IP
`custom-server.js` stamps `x-dr-real-ip` plus a per-process token. Route code trusts the header only when that token matches (existing `hasTrustedPeerHeaders`).
- **Today:** forwarding headers are honoured only from a loopback peer.
- **Production:** with nginx on the host and the app in a published Docker port, the peer is the bridge gateway (e.g. `172.17.0.1`). So every customer is keyed on that one address, for rate limits and for sessions alike.
- **Change:** with `TRUST_PRIVATE_PROXY=true`, also trust forwarding headers from private/link-local peers. It is opt-in because the stored IP then comes from whatever that proxy forwards:
  - nginx passes client headers through unless it sets them, so without `proxy_set_header X-Real-IP $remote_addr` a client could choose its own IP and its own rate-limit bucket;
  - IPv4 traffic from the internet that Docker forwards with iptables DNAT keeps its public source address, but IPv6 or userland `docker-proxy` relaying can arrive from the gateway, so the published port should be bound to `127.0.0.1` (nginx still reaches it, from a private peer).

  Without the flag, behaviour is unchanged (loopback only). Another container on the same Docker network could pose as a proxy, which is acceptable for this deployment.
- **Header order:**
  1. `X-Real-IP`, which nginx sets to `$remote_addr`;
  2. otherwise the last `X-Forwarded-For` entry, since `$proxy_add_x_forwarded_for` appends the real peer after anything the client sent;
  3. otherwise the socket address.

### D2. Stored IP is the trusted one or nothing
`getRequestIp(request)` returns the stamped `x-dr-real-ip` when trusted, the first `X-Forwarded-For` hop when `TRUST_PROXY=true` (the existing escape hatch for setups without custom-server), and otherwise `null`. It never falls back to `Host` the way the rate-limit bucket key does: a stored IP must mean an IP.

### D3. Carrying the IP to usage rows
The usage writers deep in the engine don't see the request. The entry points compute the IP once:
- `handleChat` puts it on `clientRawRequest.clientIp`, which already travels to every chat usage call;
- embeddings, images and the v1beta route pass it straight to `saveRequestUsage`;
- `platformError` gets it from its caller.

`saveRequestUsage` writes `clientIp`. AsyncLocalStorage was rejected: streaming usage is saved from stream callbacks that Next drives outside the handler's async context.

### D4. Activity log
- **Table:** `activityLog(id INTEGER PK, userId, action, ip, userAgent, details JSON, createdAt)`.
- **Writer:** `recordActivity(request, { userId, action, details })`. It is awaited but swallows every error and logs only `error.message`. It is called after the action's outcome is known. Refusals that matter for abuse are logged too, as separate action names: `login_failed`, `gift_refused`.
- **Details:** short, non-secret facts only (key name and id, order id and plan, gift code, refusal reason). Never passwords, tokens or key secrets.
- **User agent:** capped at 300 characters.

### D5. Admin queries
- **IPs of an account:** the union of `activityLog.ip` for the user and `usageHistory.clientIp` for the user's keys (`apiKeys.userId`), grouped by IP. Each row has `webCount`, `apiCount`, `firstSeen`, `lastSeen` and `otherAccounts`, the count of distinct other users seen on that IP by either source.
- **Accounts on an IP:** the same union, grouped by user, with email, status, counts and last seen.

Both use the new IP indexes. API counts are limited to the last 90 days, to keep the usage scan bounded.

## Risks

- With `TRUST_PRIVATE_PROXY=true` and an nginx that does not overwrite `X-Real-IP`, the stored IP and the rate-limit key become client-chosen. The flag must only be set after checking the nginx config.
- If the production nginx sends neither `X-Real-IP` nor `X-Forwarded-For`, the stored IP stays the gateway. The admin tab will show one IP shared by everyone, which is easy to spot. The fix is one nginx line.
- Trusting private peers would be wrong if the container port were reachable through some other private hop that forwards client-chosen headers. That is not the case in the documented deployment.
