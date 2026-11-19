## 1. Implementation
- [x] 1.1 `qoderInferenceBases` (device tokens: api3, api2), `markQoderGatewayFailed` (5 min), `isQoderConnectError` (error codes only), `qoderGatewayFailoverAllowed` (direct connections only), `withQoderGateway`
- [x] 1.2 Chat: failover on the first send; the gateway is pinned for queue replays and status polls
- [x] 1.3 Model list and image upload: same failover; upload uses the connection's region

## 2. Tests
- [x] 2.1 `test/qoder-gateway-failover.test.js`: order per token kind and region, failed-gateway window, connect codes vs text, `withQoderGateway` (marks every failed gateway; none through a relay or proxy, for job tokens, other errors or an abort), chat api3→api2 end to end and sticky, no resend after a post-connect timeout
- [x] 2.2 `npm test`, `npm run lint`
