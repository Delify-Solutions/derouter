## MODIFIED Requirements

### Requirement: public key-holder usage as JSON

The public key-holder usage view MUST be available as a JSON endpoint (in addition to the existing behavior of returning 404 for unknown/inactive keys with no existence leak), so a key holder can fetch their own usage with their API key.

#### Scenario: valid key returns usage
- **WHEN** `GET /api/usage/key?key=<active-key>&period=7d` is called
- **THEN** it returns `{key (masked), name, groupName, isActive, budgetUnlimited, budgetSpent, budgetLimit, budgetPct, resetWindow, rpmLimit, rpmLive, tpmLimit, tpmLive, peakTpm, totalRequests, totalCost, totalTokens, period, models:[{model,requests,input,output,cacheRead,cost}], rows:[...]}` as JSON
- **AND** the key is returned masked as `sk-…****` + last 4 chars (>=10 chars) or `****` (<10 chars); the full key is never in the response

#### Scenario: unknown or inactive key
- **WHEN** `GET /api/usage/key?key=<bogus>` or `?key=<inactive-key>` is called
- **THEN** the response is 404 with a JSON body (no distinction between "not found" and "inactive" — existence must not leak)

#### Scenario: missing key
- **WHEN** `GET /api/usage/key` is called with no `key` param
- **THEN** the response is 400 `{"error":"key is required"}`

#### Scenario: clear history
- **WHEN** `DELETE /api/usage/key/history?key=<active-key>` is called
- **THEN** the usage history rows for that key are cleared and an empty success response returned
