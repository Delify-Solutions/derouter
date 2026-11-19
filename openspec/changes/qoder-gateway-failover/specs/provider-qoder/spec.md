## ADDED Requirements

### Requirement: Qoder requests fail over between gateways when one cannot be reached
For an intl Qoder account signed in through the browser, the router SHALL send chat, model-list and image-upload requests to the gateways `api3` and `api2` in order of health. When a gateway cannot be connected to on a direct connection, the router SHALL send the request to the next gateway with a fresh signature. A queued chat request SHALL keep the gateway that took its first send for its replays and status polls. It SHALL also try that gateway last for the next 5 minutes. Only a connect-phase failure SHALL trigger this, because only then has the request certainly not reached Qoder. A failure after the connection was made SHALL NOT be resent to another gateway. Through a relay or a proxy there SHALL be no failover and no gateway SHALL be marked. Job-token connections SHALL use `api2` only, and CN connections SHALL use their single gateway.

#### Scenario: api3 is unreachable
- **WHEN** connecting to `api3.qoder.sh` times out for a chat request
- **THEN** the same request is signed for and sent to `api2.qoder.sh`, and the next request starts at `api2`

#### Scenario: Timeout after connecting
- **WHEN** a gateway accepted the connection but sent no response headers in time
- **THEN** the request is not resent to another gateway

#### Scenario: Through a proxy
- **WHEN** the connection uses a proxy and the connect attempt fails
- **THEN** the request fails as before and no gateway is marked unreachable
