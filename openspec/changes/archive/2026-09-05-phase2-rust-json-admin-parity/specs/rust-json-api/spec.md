## MODIFIED Requirements

### Requirement: JSON admin API responses

Admin and auth routes MUST return JSON bodies (`Content-Type: application/json`), not HTML fragments. Error responses MUST be JSON `{"error":"..."}` with appropriate HTTP status codes. Successful reads MUST return the resource shape the frontend expects. Every `/api/*` route added in Phase 2 — proxy-pools, provider-nodes, models, version, shutdown, locale, init, health (health excepted from auth), tags, oauth/gitlab, auth/reset-password, the usage/provider/settings sub-routes — MUST follow this same JSON + 401-on-missing-auth contract.

#### Scenario: protected admin route without auth cookie
- **WHEN** a request to any Phase 2 `/api/*` admin route arrives without a valid `auth_token` cookie
- **THEN** the response is HTTP 401 with a JSON body `{"error":"Unauthorized"}` (not an HTML redirect); `/api/health` is the sole exception (public, no auth)

#### Scenario: JSON error on bad input
- **WHEN** a POST/PUT to a Phase 2 admin route has an invalid body (missing required fields, bad enum, unknown id)
- **THEN** the response is 400 (or 404 for unknown id, as Node does per-route) with JSON `{"error":"<reason>"}`
