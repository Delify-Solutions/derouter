## ADDED Requirements

### Requirement: A client disconnect stops the request
When the client of a chat request (including `/v1/responses/compact` and the Gemini-format `/v1beta` chat route) disconnects, the router SHALL cancel the upstream call in progress, including one still waiting for its response headers, a non-streamed body, or a resend delay, and SHALL NOT resend it or try another account or combo member. The attempt SHALL be recorded once with status 499, SHALL NOT be billed beyond what was already delivered, and SHALL NOT mark the account unavailable.

#### Scenario: SDK timeout before the answer
- **WHEN** a client sends a non-streamed request and gives up after 1 second while the upstream takes 3 seconds
- **THEN** the upstream call is cancelled at about 1 second, the usage row has status 499 and no tokens, and the account stays available

#### Scenario: Normal requests are unaffected
- **WHEN** a client waits for a streamed or non-streamed answer to finish
- **THEN** the answer is delivered and billed from the upstream's usage as before
