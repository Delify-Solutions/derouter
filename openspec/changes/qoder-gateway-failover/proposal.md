## Why

A Qoder request failed with `UND_ERR_CONNECT_TIMEOUT` to the gateway (`47.236.110.152:443`, `47.236.162.133:443`). At the same time other models on the same account worked. The router sends every intl request to one gateway (`api3.qoder.sh`, or `api2` for job tokens), so when that gateway cannot be reached the request fails and the account is cooled down.

The Qoder app 0.5.14 knows `api1` (us), `api2` (sg, its default) and `api3` (jp) as "gateway" endpoints. At runtime it fails over among the inference gateways it is given and remembers the failed origin (`failedOrigins`). It does not fail over when a route goes through a proxy.

## What Changes

- **`qoderInferenceBases(credentials, region)`** (`open-sse/shared/qoder/constants.js`) gives the gateways in order, healthiest first.
  - **Device tokens (browser sign-in):** `api3`, then `api2`. `api1` is left out because nothing shows it accepts device tokens, and a 401 there would read as a broken account.
  - **Job tokens:** `api2` only.
  - **CN:** its single gateway.
- **Failed gateways are demoted.** A gateway that could not be reached moves to the end for 5 minutes (`markQoderGatewayFailed`). Every gateway that failed this way is marked, including the last one.
- **`withQoderGateway`** runs one request on those gateways. It moves to the next gateway, with a fresh COSY signature for that URL, only when all of these hold:
  - The connection is direct. With a Vercel relay, a connection proxy or a proxy environment variable, a connect error is about the relay or proxy. In that case nothing fails over and no gateway is marked.
  - The error carries a connect-phase code: `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EAI_FAIL`, `EHOSTUNREACH` or `ENETUNREACH`. The request never reached Qoder, so it cannot run twice. Message text is never matched.
  - The caller did not abort.
- **It is used by:**
  - **chat** (`QoderExecutor`). The gateway that took the first send is pinned for that request: queue replays and queue-status polls stay on it.
  - **the model list**.
  - **image uploads**, which also now use the connection's region.
- **`QoderExecutor.fetchImpl`** is a test seam. It is null in production.

## Capabilities
### Modified Capabilities
- `provider-qoder` (introduced by the unarchived change `qoder-assistant-scene`)

## Impact
- No schema change.
- Files: `open-sse/shared/qoder/constants.js`, `open-sse/executors/qoder.js`, `open-sse/services/qoderModels.js`, `open-sse/shared/qoder/attachments.js`, `test/qoder-gateway-failover.test.js`.
