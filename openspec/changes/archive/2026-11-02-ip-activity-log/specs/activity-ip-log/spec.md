## ADDED Requirements

### Requirement: Client IP behind a local reverse proxy
The custom server SHALL derive the client IP from forwarding headers only when the TCP peer is a loopback address, or — when `TRUST_PRIVATE_PROXY=true` — a private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7) or link-local address. It SHALL use `X-Real-IP` when present, otherwise the last entry of `X-Forwarded-For`, otherwise the socket address. A peer with a public address SHALL always be keyed on its socket address. Stored IPs SHALL come from `getRequestIp`, which returns the trusted address or null and never a host name.

#### Scenario: nginx on the Docker host
- **WHEN** `TRUST_PRIVATE_PROXY=true` and a request arrives from peer `172.17.0.1` with `X-Real-IP: 203.0.113.9`
- **THEN** the request's client IP is `203.0.113.9`

#### Scenario: Private peer without the opt-in
- **WHEN** `TRUST_PRIVATE_PROXY` is unset and a request arrives from peer `172.17.0.1` with `X-Real-IP: 203.0.113.9`
- **THEN** the request's client IP is `172.17.0.1`

#### Scenario: Spoofed header from the internet
- **WHEN** a request arrives from public peer `198.51.100.7` with `X-Forwarded-For: 1.2.3.4`
- **THEN** the request's client IP is `198.51.100.7`

#### Scenario: Client-supplied hop in front of nginx
- **WHEN** nginx at `127.0.0.1` forwards `X-Forwarded-For: 1.2.3.4, 203.0.113.9` without `X-Real-IP`
- **THEN** the request's client IP is `203.0.113.9`

### Requirement: IP on API usage
Every usage row written for an API request (chat, embeddings, image generation, the v1beta route, the customer playground, and platform denials) SHALL store the request's client IP in `usageHistory.clientIp`, or null when none is trusted.

#### Scenario: Chat request
- **WHEN** a customer key sends a chat completion from `203.0.113.9`
- **THEN** its usage row has `clientIp = '203.0.113.9'`

### Requirement: Account activity log
The system SHALL append one `activityLog` row with user, action, client IP, user agent (at most 300 characters), short details and time for each of these actions:
- `register`, `login`, `login_failed` (correct email, wrong password), `login_blocked` (suspended account), `logout`;
- `password_change`, `password_reset`, `email_verified`;
- `key_create`, `key_update`, `key_delete`, `key_reveal`;
- `order_create`, `gift_redeem`, `gift_refused`, `plan_reorder`;
- `telegram_link`, `telegram_unlink`.

Writing the row SHALL never fail or delay the action's response beyond the write itself. Details SHALL NOT contain passwords, tokens or key secrets. The log SHALL be readable by admins only.

#### Scenario: Wrong password
- **WHEN** someone enters a wrong password for an existing account
- **THEN** a `login_failed` row with that account and the request's IP is stored and the response is unchanged

#### Scenario: Log write fails
- **WHEN** the activity insert throws
- **THEN** the action still succeeds and the error message is logged without request data

### Requirement: Admin IP lookup
- The admin user page SHALL have an "IP" tab listing every IP the account used, from activity and from its keys' usage in the last 90 days. Each row shows web count, API count, first seen, last seen and the number of other accounts seen on that IP; the tab also shows the latest 100 activity rows.
- Selecting an IP SHALL list every account seen on it (email, status, web and API counts, last seen) with a link to each account.
- The users list search SHALL also match an IP and return the accounts seen on it.
- Suspension uses the existing account status action.

#### Scenario: Two accounts, one IP
- **WHEN** accounts A and B both logged in from `203.0.113.9`
- **THEN** A's IP tab shows `203.0.113.9` with 1 other account, and the IP lookup lists A and B
