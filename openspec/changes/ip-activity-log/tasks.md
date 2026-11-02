## 1. Client IP

- [x] 1.1 `custom-server.js`: trust forwarding headers from loopback, and private peers with `TRUST_PRIVATE_PROXY=true`; X-Real-IP, else last XFF hop
- [x] 1.2 `src/lib/auth/clientIp.js` `getRequestIp` (trusted or null)

## 2. Data

- [x] 2.1 Schema 25: `usageHistory.clientIp` + index, `activityLog` + indexes
- [x] 2.2 `activityRepo`: `recordActivity`, `listUserActivity`, `listUserIpsSync`, `listAccountsByIpSync`

## 3. Recording

- [x] 3.1 Usage: chat (`clientRawRequest.clientIp` through chatCore), embeddings, images, v1beta, playground, platform denials
- [x] 3.2 Activity: public register/login/logout/reset/verify, account password/keys/orders/redeem/plans/telegram, public telegram link

## 4. Admin

- [x] 4.1 `GET /api/users/[id]/ips`, `GET /api/ip-lookup?ip=`, users search by IP
- [x] 4.2 "IP" tab on the user page with the IP drill-down

## 5. Check

- [x] 5.1 Tests: IP resolution, activity repo queries, usage clientIp
- [x] 5.2 lint, test, build; live check
- [ ] 5.3 Merge deltas and archive
