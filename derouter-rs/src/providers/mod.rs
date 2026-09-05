//! Provider validation data and classification — ported from
//! src/shared/constants/providers.js and src/shared/constants/config.js.
//! Phase 3: the full provider registry (registry module) supersedes the
//! Phase 1 static lists/classify/capabilities. The Phase 1 modules remain
//! until all callers are migrated (then removed in a later cleanup task).

pub mod registry;
pub mod lists;
pub mod config;
pub mod classify;
pub mod capabilities;
pub mod ollama_models;

pub use classify::{is_valid_provider, supports_apikey_mode, normalize_provider_id, is_web_cookie_provider};
pub use config::{is_openai_compatible_provider, is_anthropic_compatible_provider, is_custom_embedding_provider};

// Re-export the registry's lookup/classification helpers (Phase 3 source of truth).
pub use registry::{
    by_id, by_alias, by_id_or_alias, by_category, all_entries, count,
    is_apikey_provider, is_oauth_provider, is_web_cookie_provider as is_registry_web_cookie_provider,
    is_free_tier_provider, is_free_provider, get_provider_name, alias_to_id, id_to_alias,
    ProviderRegistryEntry, ProviderCategory,
};
