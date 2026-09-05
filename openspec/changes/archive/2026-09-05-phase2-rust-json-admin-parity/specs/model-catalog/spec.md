## Purpose

Serves the admin model catalog — the full pool of models available for combos and admin use — with aliases, availability, custom models, disabled-model toggling, catalog sync, and a model connectivity test. Excludes key/group allow-lists (those are combo names). Includes only a minimal capabilities map for Phase 2; the full provider-registry capabilities are Phase 3.

## ADDED Requirements

### Requirement: Admin model catalog over JSON

`GET /api/models` MUST return the AI_MODELS catalog as JSON: each entry with `fullModel` (`provider/model`), `routedModel` (`providerAlias/model`), `alias` (the stored alias or the bare model name), and `caps` (`{vision, search, reasoning, contextWindow, maxOutput}`). It MUST filter out models disabled for their provider and MUST return empty/default caps for models with no capabilities entry (minimal map; full registry is Phase 3). The route MUST require auth (401 JSON without cookie).

#### Scenario: catalog with caps and alias
- **WHEN** `GET /api/models` is called authenticated
- **THEN** each model entry includes `fullModel`, `routedModel`, `alias`, and `caps` with boolean vision/search/reasoning and numeric contextWindow/maxOutput (or defaults when no cap entry)

#### Scenario: disabled model filtered
- **WHEN** a model is in the disabled list for its provider and `GET /api/models` is called
- **THEN** that model is absent from the response

### Requirement: Model alias management

`GET /api/models/alias` MUST return the full model→alias mapping as JSON. `POST /api/models/alias` with `{"model":"<fullModel>","alias":"<name>"}` MUST set the alias (overwriting any existing) and return the updated mapping entry. Both require auth.

#### Scenario: set alias
- **WHEN** `POST /api/models/alias` with `{"model":"openai/gpt-4","alias":"gpt4"}` authenticated
- **THEN** the response is 200 with the stored alias and a subsequent `GET /api/models/alias` reflects it

### Requirement: Model availability and catalog sync

`GET /api/models/availability` MUST report, per provider, which catalog models are currently reachable (proxied test) as JSON. `POST /api/models/catalog-sync` MUST re-sync the local catalog against the upstream provider model lists and return a summary `{added, removed, unchanged}`. Both require auth.

#### Scenario: availability report
- **WHEN** `GET /api/models/availability` is called authenticated
- **THEN** the response lists each model with a boolean `available` flag

### Requirement: Custom models CRUD

`GET /api/models/custom` MUST list custom (user-defined) models. `POST /api/models/custom` with a model definition `{provider, model, baseUrl?, ...}` MUST create a custom model and return the created entry; duplicate `{provider, model}` MUST return 400. Both require auth.

#### Scenario: create custom model
- **WHEN** `POST /api/models/custom` with `{"provider":"openai-compat","model":"my-model"}` authenticated
- **THEN** the response is 201 with the created entry

#### Scenario: duplicate custom model
- **WHEN** `POST /api/models/custom` with an existing `{provider, model}` pair
- **THEN** the response is 400 `{"error":"Custom model already exists"}`

### Requirement: Disabled model toggling

`GET /api/models/disabled` MUST return the disabled models keyed by provider alias/provider id. `POST /api/models/disabled` with `{"provider":"<alias>","model":"<model>","disabled":true|false}` MUST toggle the disabled state and return the updated status. Requires auth.

#### Scenario: disable a model
- **WHEN** `POST /api/models/disabled` with `{"provider":"anthropic","model":"claude-2","disabled":true}` authenticated
- **THEN** `claude-2` is disabled for `anthropic` and `GET /api/models` no longer lists it

### Requirement: Model connectivity test

`POST /api/models/test` with a `{provider, model, connectionId?}` body MUST attempt a minimal request to the provider for that model and return `{ok, latencyMs, status, error?}`. Requires auth.

#### Scenario: test reachable model
- **WHEN** `POST /api/models/test` for a live model on a valid provider
- **THEN** the response is 200 `{ok:true, latencyMs:<n>, status:200}`
