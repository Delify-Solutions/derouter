## Purpose

The admin UI for managing providers, combos, keys, groups, and pricing, delivered as server-rendered HTML fragments over HTMX with Alpine.js for small client state — no client-side framework, no client-side JSON API.

## ADDED Requirements

### Requirement: Server-rendered admin pages

The system SHALL serve admin pages (providers, combos, keys, groups, pricing, endpoint) as full HTML documents rendered on the server, with navigation and a shared layout. The admin area MUST be access-controlled (see `admin-auth`): requests without a valid admin session redirect to the login page.

#### Scenario: Visit dashboard without session

- **WHEN** an unauthenticated browser visits `/dashboard`
- **THEN** the server redirects to `/login`

#### Scenario: Visit dashboard with session

- **WHEN** an authenticated admin visits `/dashboard`
- **THEN** the server renders the dashboard overview page in the shared layout

### Requirement: HTMX fragment interactions

Interactions that change part of a page (filtering a table, opening a modal, adding/editing/deleting a row, switching a tab, paginating) SHALL be performed by HTMX requests that return an HTML fragment swapped into the page, NOT by fetching JSON and rendering on the client.

#### Scenario: Filter a table

- **WHEN** an admin changes a filter dropdown on the keys page
- **THEN** the browser issues an `hx-get` returning a `<tbody>` fragment swapped into the table, without reloading the page

#### Scenario: Add a row via modal

- **WHEN** an admin fills and submits the "Add combo" modal
- **THEN** the `hx-post` returns the new row's `<tr>` fragment, swapped (`beforeend`) into the table, and the modal closes

#### Scenario: Delete a row

- **WHEN** an admin clicks delete on a row and confirms
- **THEN** the `hx-delete` returns an empty response and `hx-swap="outerHTML"` removes the row from the DOM

#### Scenario: Edit a row

- **WHEN** an admin edits a provider and submits
- **THEN** the `hx-put` returns the updated `<tr>` fragment swapped (`outerHTML`) in place of the existing row

### Requirement: Provider management

The system SHALL let an admin add Anthropic-compatible and OpenAI-compatible provider connections, set per-connection auth (OAuth token or API key), activate/deactivate, set priority, and delete. Each connection has a `provider`, `authType`, `name`, `email`, `priority`, `isActive`, and a `data` JSON holding credentials.

#### Scenario: Add an OpenAI-compatible connection

- **WHEN** an admin adds a connection with provider `openai-compatible`, a base URL, and an API key
- **THEN** the connection is stored and becomes a fallback candidate for combos referencing `openai-compatible`

#### Scenario: Reorder by priority

- **WHEN** two connections exist for the same provider with priorities 1 and 2
- **THEN** fallback ordering tries priority 1 before priority 2

### Requirement: Combo management

The system SHALL let an admin create combos (a `name` mapped to an ordered `models` array of `providerName/modelId` strings), edit, delete, and test a combo. "Testing a combo" means issuing a real proxied completion `{model: <combo.name>, messages:[{role:user, content:"hi"}]}` using an internal unrestricted key, then reporting status, latency, and the assistant's reply text.

#### Scenario: Create a combo

- **WHEN** an admin creates combo `mygpt` with `models = ["openai/gpt-4o","openai-compatible/glm-5.3:pre"]`
- **THEN** subsequent client requests to `/v1/chat/completions` with `model = "mygpt"` resolve to that fallback chain

#### Scenario: Test a combo succeeds

- **WHEN** an admin clicks "Test" on a combo whose first candidate is reachable
- **THEN** the test modal shows a success indicator, the latency in ms, and the assistant's reply text

#### Scenario: Test a combo fails

- **WHEN** an admin clicks "Test" on a combo whose candidates all error
- **THEN** the test modal shows a failure indicator and the error string, with no reply text

### Requirement: Group and pricing management

The system SHALL let an admin manage key groups (with default limits + `priceOverrides`) and per-model / per-combo pricing. Per-combo pricing overrides per-pool pricing for requests that name that combo.

#### Scenario: Set a group's default limits

- **WHEN** an admin edits group "free" and sets RPM 10, TPM 200, budget $1
- **THEN** keys in "free" with null per-key limits inherit those defaults

#### Scenario: Per-combo price overrides per-pool

- **WHEN** combo `mygpt` has a combo-level price of $0.001/1k output and the underlying provider's pool price is $0.002/1k output
- **THEN** usage for `mygpt` requests is costed at $0.001/1k output
