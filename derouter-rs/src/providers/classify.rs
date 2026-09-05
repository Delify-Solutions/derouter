//! Provider classification — combines lists + config functions.
//! Ported from src/shared/constants/providers.js validation logic.

use super::lists;
use super::config;

/// Check if a provider ID is valid for API-key/cookie/free-tier/compatible creation.
/// Mirrors Node's `isValidProvider` check in POST /api/providers.
pub fn is_valid_provider(provider: &str) -> bool {
    if provider.is_empty() {
        return false;
    }

    // Check static lists
    if lists::is_apikey_provider(provider)
        || lists::is_free_tier_provider(provider)
        || lists::is_web_cookie_provider(provider)
    {
        return true;
    }

    // Dual-auth providers (oauth category with authModes including "apikey")
    if lists::has_apikey_auth_mode(provider) {
        return true;
    }

    // Compatible/embedding providers (dynamic prefixes)
    if config::is_openai_compatible_provider(provider)
        || config::is_anthropic_compatible_provider(provider)
        || config::is_custom_embedding_provider(provider)
    {
        return true;
    }

    false
}

/// Check if a provider supports API-key mode (for auth type determination).
pub fn supports_apikey_mode(provider: &str) -> bool {
    lists::is_apikey_provider(provider) || lists::has_apikey_auth_mode(provider)
}

/// Check if a provider is a web-cookie provider.
pub fn is_web_cookie_provider(provider: &str) -> bool {
    lists::is_web_cookie_provider(provider)
}

/// Re-export normalize_provider_id from config.
pub fn normalize_provider_id(provider: &str) -> String {
    config::normalize_provider_id(provider)
}
