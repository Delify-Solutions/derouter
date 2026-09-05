## MODIFIED Requirements

### Requirement: Admin model catalog over JSON

`GET /api/models` MUST return the model catalog as JSON: each entry with `fullModel` (`provider/model`), `routedModel` (`providerAlias/model`), `alias` (the stored alias or the bare model name), and `caps` (`{vision, search, reasoning, contextWindow, maxOutput}`) sourced from the full registry capabilities (the 123-entry `get_capabilities_for_model`), superseding the Phase 2 minimal capabilities map. It MUST filter out models disabled for their provider. Models with a registry cap entry MUST return real caps; models absent from the registry MUST return default caps (`vision:false, search:false, reasoning:false, contextWindow:0, maxOutput:0`). The route MUST require auth (401 JSON without cookie).

#### Scenario: catalog with caps and alias
- **WHEN** `GET /api/models` is called authenticated
- **THEN** each model entry includes `fullModel`, `routedModel`, `alias`, and `caps` with the registry-provided vision/search/reasoning/contextWindow/maxOutput (or defaults when the model lacks a registry cap entry)

#### Scenario: disabled model filtered
- **WHEN** a model is in the disabled list for its provider and `GET /api/models` is called
- **THEN** that model is absent from the response

### Requirement: Model availability and catalog sync

`GET /api/models/availability` MUST report, per provider, which catalog models are currently reachable by probing the real executors (not the Phase 2 stub that marked all available). `POST /api/models/catalog-sync` MUST re-sync the local catalog against the registry and return a summary `{added, removed, unchanged}`. Both require auth.

#### Scenario: availability report

- **WHEN** `GET /api/models/availability` is called authenticated
- **THEN** the response lists each model with a boolean `available` flag derived from a real probe via the provider's executor (not the Phase 2 stub that marked all available)
