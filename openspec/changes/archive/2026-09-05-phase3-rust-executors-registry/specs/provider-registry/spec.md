## Purpose

The static registry of 123 provider entries (id, priority, alias, display metadata, category, transport config, models, serviceKinds, capabilities) used by the proxy for model resolution, provider validation, executor selection, and by the admin UI for providers/models catalogs. Replaces the Phase 2 minimal capabilities map with the full Node `open-sse/providers/registry/*` data.

## ADDED Requirements

### Requirement: Full provider registry in Rust

The Rust backend MUST contain a registry of all 123 provider entries ported from `open-sse/providers/registry/*.js`, each with: `id`, `priority`, `alias` (and `uiAlias` where present), `display` (name, icon/textIcon, color, website, notice, deprecation), `category` (apikey/oauth/web-cookie/free-tier/compatible/embedding), `transport` (baseUrl, format, urlSuffix?, headers, auth scheme per authType, quirks?), `models` (id + name), and `serviceKinds`. The registry MUST be queryable by id, by alias, and MUST enumerate all entries.

#### Scenario: lookup by alias
- **WHEN** a model `cc/claude-...` is resolved
- **THEN** the registry returns the `claude` entry (alias `cc`)

#### Scenario: enumerate all providers
- **WHEN** the providers/models admin endpoint lists available providers
- **THEN** all 123 registry entries are available with their display + transport metadata

### Requirement: Capabilities from the registry

`get_capabilities_for_model(provider, model)` MUST return the capabilities (vision, search, reasoning, contextWindow, maxOutput) sourced from the registry/capabilities data, superseding the Phase 2 minimal map. Models with a registry entry MUST return real caps; models absent from the registry MUST return the default caps (vision:false, search:false, reasoning:false, contextWindow:0, maxOutput:0).

#### Scenario: registry entry capabilities
- **WHEN** capabilities are requested for a model present in the 123-entry registry
- **THEN** the returned caps match the Node `open-sse/providers/capabilities.js` value for that model

### Requirement: Transport config drives executor routing

The registry's `transport.baseUrl`, `transport.format`, and `transport.headers`/`auth` MUST be available to executors and the admin routes. The `format` (e.g. `claude`, `openai`, `gemini`) MUST select the response/request translator used by the executor for shape translation. The proxy `/v1/*` model resolution MUST use the registry to find the transport for a resolved provider, and `select_executor` MUST pick the specialized executor when one exists for the provider's id/alias, else the format's default executor.

#### Scenario: claude-format transport
- **WHEN** a provider's registry entry has `transport.format = "claude"`
- **THEN** the executor uses the Claude/Anthropic request+response shape translator and the anthropic-version headers from the entry

### Requirement: Provider validation from the registry

Provider validation (APIKEY_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider, supportsApiKeyMode) MUST be derived from the registry's `category` and `category`+`serviceKinds` fields instead of the Phase 1 hand-maintained lists, so adding a provider to the registry automatically classifies it.

#### Scenario: new provider classified by category
- **WHEN** a registry entry has `category: "web-cookie"`
- **THEN** the provider is treated as a web-cookie provider (cookie auth required, not API key)
