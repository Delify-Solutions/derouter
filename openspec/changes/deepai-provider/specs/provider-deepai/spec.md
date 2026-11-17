## ADDED Requirements

### Requirement: DeepAI sign-in yields one connection per account
The system SHALL let an admin add DeepAI Code accounts through a browser sign-in whose one-time callback code is exchanged for an `api_key`, stored as the connection's access token with no refresh token or expiry. Signing in again with the same username SHALL update that connection instead of adding a duplicate.

#### Scenario: Pasted callback URL
- **WHEN** the admin pastes the `127.0.0.1:<port>/auth-callback?code=...` URL
- **THEN** the code is exchanged and a connection labelled with the account's username exists

#### Scenario: Expired or reused code
- **WHEN** DeepAI refuses the code (HTTP 400/401)
- **THEN** the admin sees a fixed "expired or already used" message and no connection is created

### Requirement: DeepAI requests carry deployment-level identity only
The system SHALL send DeepAI requests with the account's `api-key`, the lane version, one machine digest shared by every account of the deployment, and a beacon limited to version and uptime. It SHALL NOT derive a machine digest, focus or activity signal per account.

#### Scenario: Two accounts
- **WHEN** two DeepAI connections issue requests
- **THEN** both send the same machine digest header and neither beacon contains focus or activity fields

### Requirement: Check-in never blocks a request
The system SHALL renew a DeepAI account's check-in nonce when absent or past half its lifetime, with concurrent requests sharing one renewal. A failed or refused check-in SHALL NOT throw: the chat request proceeds and DeepAI's own error reaches the caller.

#### Scenario: Refused check-in
- **WHEN** the check-in endpoint answers an error
- **THEN** no nonce is stored and the chat request is still sent
