## Purpose

Operational endpoints for the admin: version info, graceful shutdown signal, self-update trigger, supported locales, first-run initialization status, and a health check covering DB connectivity, version, and uptime.

## ADDED Requirements

### Requirement: Version info over JSON

`GET /api/version` MUST return the current build version, commit hash (if available), and build timestamp as JSON. It MUST require auth (401 JSON without cookie).

#### Scenario: version info
- **WHEN** `GET /api/version` is called authenticated
- **THEN** the response is 200 `{"version":"...", "commit":"...", "buildTime":"..."}`

### Requirement: Graceful shutdown

`POST /api/version/shutdown` and `POST /api/shutdown` MUST signal the server to drain and exit gracefully (finish in-flight requests then stop). The response MUST be a 200 JSON ack `{"success":true}` sent before shutdown completes. Requires auth.

#### Scenario: shutdown signal
- **WHEN** `POST /api/shutdown` is called authenticated
- **THEN** the response is 200 `{"success":true}` and the process initiates a graceful drain

### Requirement: Self-update trigger

`POST /api/version/update` MUST check for an available update and, if one exists, trigger the update (download + swap + restart, mirroring Node logic) returning `{ok, updatedTo?, error?}`. If already up to date, it MUST return `{ok:true, updatedTo:null}`. Requires auth.

#### Scenario: update available
- **WHEN** `POST /api/version/update` is called and a newer version exists
- **THEN** the response indicates the update was applied and the target version

#### Scenario: already current
- **WHEN** `POST /api/version/update` is called and the build is current
- **THEN** the response is `{ok:true, updatedTo:null}`

### Requirement: Locale list

`GET /api/locale` MUST return the supported locales and the current/default locale as JSON. Requires auth.

#### Scenario: locale list
- **WHEN** `GET /api/locale` is called authenticated
- **THEN** the response is 200 `{"locales":["en", ...], "current":"en"}`

### Requirement: Initialization status

`GET /api/init` MUST return whether the server is in a first-run/uninitialized state (e.g., no admin password set) as JSON `{"initialized":bool, ...}`, matching the Node first-run detection. Requires auth.

#### Scenario: first run
- **WHEN** `GET /api/init` is called on a fresh install with no password hash stored
- **THEN** the response is 200 `{"initialized":false}`

#### Scenario: initialized
- **WHEN** `GET /api/init` is called after a password has been set
- **THEN** the response is 200 `{"initialized":true}`

### Requirement: Health check

`GET /api/health` MUST return 200 JSON `{ok:true, db:"ok", version:"...", uptimeSeconds:<n>}` when the DB is reachable; it MUST return 503 `{ok:false, db:"error"}` when the DB connection fails. It does NOT require auth (public liveness check).

#### Scenario: healthy
- **WHEN** `GET /api/health` is called and the DB pool can acquire a connection
- **THEN** the response is 200 `{"ok":true, "db":"ok", "version":"...", "uptimeSeconds":<n>}`

#### Scenario: db down
- **WHEN** `GET /api/health` is called and the DB connection fails
- **THEN** the response is 503 `{"ok":false, "db":"error"}`
