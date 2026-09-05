//! Provider registry — 122 static entries ported from open-sse/providers/registry/*.js
//! Phase 3: replaces the Phase 2 minimal capabilities map + Phase 1 static lists.
//!
//! Each entry has: id, priority, alias, ui_alias, display, category, transport, models, service_kinds.
//! Lookup: by_id, by_alias, all, classification helpers.

pub mod apikey;
pub mod oauth;
pub mod web_cookie;
pub mod free_tier;
pub mod compatible;
pub mod embedding;
pub mod media;
pub mod capabilities;

use serde::{Deserialize, Serialize};

/// Display metadata for a provider.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderDisplay {
    pub name: &'static str,
    pub icon: Option<&'static str>,
    pub color: Option<&'static str>,
    pub text_icon: Option<&'static str>,
    pub website: Option<&'static str>,
    pub notice: Option<ProviderNotice>,
}

/// Notice metadata for a provider.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderNotice {
    pub api_key_url: Option<&'static str>,
    pub signup_url: Option<&'static str>,
    pub text: Option<&'static str>,
    pub deprecated: Option<bool>,
    pub deprecation_notice: Option<&'static str>,
}

/// Transport configuration for a provider.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderTransport {
    pub base_url: Option<&'static str>,
    pub format: Option<&'static str>,
    pub url_suffix: Option<&'static str>,
    pub headers: &'static [(&'static str, &'static str)],
    pub auth: Option<ProviderAuth>,
    pub force_stream: Option<bool>,
    pub client_version: Option<&'static str>,
    pub chat_path: Option<&'static str>,
}

/// Auth scheme for a provider's transport.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderAuth {
    pub combined: bool,
    pub header: &'static str,
    pub scheme: &'static str,
}

/// A model entry in the registry.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderModel {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Option<&'static str>,
}

/// A registry entry for a provider.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderRegistryEntry {
    pub id: &'static str,
    pub priority: i32,
    pub alias: &'static str,
    pub ui_alias: Option<&'static str>,
    pub display: ProviderDisplay,
    pub category: ProviderCategory,
    pub transport: ProviderTransport,
    pub models: &'static [ProviderModel],
    pub service_kinds: &'static [&'static str],
    pub hidden: bool,
}

/// const defaults usable in `pub static` initializers (Default::default() is not const).
pub const DEFAULT_TRANSPORT: ProviderTransport = ProviderTransport {
    base_url: None,
    format: None,
    url_suffix: None,
    headers: &[],
    auth: None,
    force_stream: None,
    client_version: None,
    chat_path: None,
};

pub const DEFAULT_DISPLAY: ProviderDisplay = ProviderDisplay {
    name: "",
    icon: None,
    color: None,
    text_icon: None,
    website: None,
    notice: None,
};

pub const DEFAULT_NOTICE: ProviderNotice = ProviderNotice {
    api_key_url: None,
    signup_url: None,
    text: None,
    deprecated: None,
    deprecation_notice: None,
};

/// Provider category (maps to the Node registry category field).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCategory {
    Apikey,
    Oauth,
    WebCookie,
    FreeTier,
    Free,
    Compatible,
    Embedding,
    Media,
}

impl Default for ProviderCategory {
    fn default() -> Self {
        ProviderCategory::Apikey
    }
}

impl ProviderCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderCategory::Apikey => "apikey",
            ProviderCategory::Oauth => "oauth",
            ProviderCategory::WebCookie => "web-cookie",
            ProviderCategory::FreeTier => "freeTier",
            ProviderCategory::Free => "free",
            ProviderCategory::Compatible => "compatible",
            ProviderCategory::Embedding => "embedding",
            ProviderCategory::Media => "media",
        }
    }

    pub fn from_str(s: &str) -> ProviderCategory {
        match s {
            "apikey" => ProviderCategory::Apikey,
            "oauth" => ProviderCategory::Oauth,
            "web-cookie" | "webCookie" => ProviderCategory::WebCookie,
            "freeTier" | "free-tier" => ProviderCategory::FreeTier,
            "free" => ProviderCategory::Free,
            "compatible" => ProviderCategory::Compatible,
            "embedding" => ProviderCategory::Embedding,
            "media" => ProviderCategory::Media,
            _ => ProviderCategory::Apikey,
        }
    }
}

/// Get all registry entries (all 122).
pub fn all_entries() -> &'static [ProviderRegistryEntry] {
    static ALL: once_cell::sync::Lazy<Vec<ProviderRegistryEntry>> = once_cell::sync::Lazy::new(|| {
        let mut all = Vec::new();
        all.extend_from_slice(apikey::ENTRIES);
        all.extend_from_slice(oauth::ENTRIES);
        all.extend_from_slice(web_cookie::ENTRIES);
        all.extend_from_slice(free_tier::ENTRIES);
        all.extend_from_slice(compatible::ENTRIES);
        all.extend_from_slice(embedding::ENTRIES);
        all.extend_from_slice(media::ENTRIES);
        all
    });
    &ALL
}

/// Look up a registry entry by its id (case-insensitive).
pub fn by_id(id: &str) -> Option<&'static ProviderRegistryEntry> {
    all_entries().iter().find(|e| e.id.eq_ignore_ascii_case(id))
}

/// Look up a registry entry by its alias or ui_alias (case-insensitive).
pub fn by_alias(alias: &str) -> Option<&'static ProviderRegistryEntry> {
    all_entries().iter().find(|e| {
        e.alias.eq_ignore_ascii_case(alias) || e.ui_alias.map(|a| a.eq_ignore_ascii_case(alias)).unwrap_or(false)
    })
}

/// Look up a registry entry by id OR alias (tries id first, then alias).
pub fn by_id_or_alias(key: &str) -> Option<&'static ProviderRegistryEntry> {
    by_id(key).or_else(|| by_alias(key))
}

/// Get all providers in a given category.
pub fn by_category(category: ProviderCategory) -> Vec<&'static ProviderRegistryEntry> {
    all_entries().iter().filter(|e| e.category == category).collect()
}

/// Check if a provider id is in the apikey category.
pub fn is_apikey_provider(id: &str) -> bool {
    by_id(id).map(|e| e.category == ProviderCategory::Apikey).unwrap_or(false)
}

/// Check if a provider id is in the oauth category.
pub fn is_oauth_provider(id: &str) -> bool {
    by_id(id).map(|e| e.category == ProviderCategory::Oauth).unwrap_or(false)
}

/// Check if a provider id is in the web-cookie category.
pub fn is_web_cookie_provider(id: &str) -> bool {
    by_id(id).map(|e| e.category == ProviderCategory::WebCookie).unwrap_or(false)
}

/// Check if a provider id is in the free-tier or free category.
pub fn is_free_tier_provider(id: &str) -> bool {
    by_id(id).map(|e| {
        e.category == ProviderCategory::FreeTier || e.category == ProviderCategory::Free
    }).unwrap_or(false)
}

/// Check if a provider id is in the free category (no auth required).
pub fn is_free_provider(id: &str) -> bool {
    by_id(id).map(|e| e.category == ProviderCategory::Free).unwrap_or(false)
}

/// Check if a provider is an OpenAI-compatible provider (by id or prefix).
pub fn is_openai_compatible_provider(id: &str) -> bool {
    if id.starts_with("openai-compatible-") {
        return true;
    }
    // Check if the registry entry's transport format is "openai" or similar
    if let Some(entry) = by_id_or_alias(id) {
        if let Some(fmt) = entry.transport.format {
            return fmt == "openai";
        }
    }
    false
}

/// Check if a provider is an Anthropic-compatible provider (by id or prefix).
pub fn is_anthropic_compatible_provider(id: &str) -> bool {
    if id.starts_with("anthropic-compatible-") {
        return true;
    }
    if let Some(entry) = by_id_or_alias(id) {
        if let Some(fmt) = entry.transport.format {
            return fmt == "claude";
        }
    }
    false
}

/// Check if a provider is a custom embedding provider (by prefix).
pub fn is_custom_embedding_provider(id: &str) -> bool {
    id.starts_with("custom-embedding-")
}

/// Alias → ID mapping (from registry entries).
pub fn alias_to_id(alias: &str) -> Option<&'static str> {
    by_alias(alias).map(|e| e.id)
}

/// ID → alias mapping (from registry entries).
pub fn id_to_alias(id: &str) -> Option<&'static str> {
    by_id(id).and_then(|e| {
        if !e.alias.is_empty() {
            Some(e.alias)
        } else {
            None
        }
    })
}

/// Get the display name for a provider ID.
pub fn get_provider_name(id: &str) -> Option<&'static str> {
    by_id(id).map(|e| e.display.name)
}

/// Normalize a provider ID: try direct match, then slug, then alias lookup.
/// Ported from src/lib/providerNormalization.js normalizeProviderId.
pub fn normalize_provider_id(provider: &str) -> String {
    let trimmed = provider.trim();

    // Direct match by id
    if by_id(trimmed).is_some() {
        return trimmed.to_string();
    }

    // Direct match by alias
    if let Some(entry) = by_alias(trimmed) {
        return entry.id.to_string();
    }

    // Compatible/embedding prefix providers pass through
    if is_openai_compatible_provider(trimmed)
        || is_anthropic_compatible_provider(trimmed)
        || is_custom_embedding_provider(trimmed)
    {
        return trimmed.to_string();
    }

    // Try slug: lowercase, replace non-alphanumeric with dashes, trim leading/trailing dashes
    let slug: String = trimmed
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if by_id(&slug).is_some() {
        return slug;
    }

    if let Some(entry) = by_alias(&slug) {
        return entry.id.to_string();
    }

    // No match — return trimmed original (compatible/embedding nodes are dynamic)
    trimmed.to_string()
}

/// Check if a provider ID is valid (exists in the registry or is a compatible/embedding provider).
pub fn is_valid_provider(provider: &str) -> bool {
    if provider.is_empty() {
        return false;
    }
    if by_id_or_alias(provider).is_some() {
        return true;
    }
    if is_openai_compatible_provider(provider)
        || is_anthropic_compatible_provider(provider)
        || is_custom_embedding_provider(provider)
    {
        return true;
    }
    false
}

/// Check if a provider supports apikey mode.
pub fn supports_apikey_mode(provider: &str) -> bool {
    is_apikey_provider(provider) || is_free_tier_provider(provider)
}

/// Get the total count of registry entries.
pub fn count() -> usize {
    all_entries().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_entries_present() {
        // Node source yields 122 entries with categories: 78 apikey + 19 oauth + 23 free_tier/free + 2 web_cookie.
        assert_eq!(count(), 122, "Registry must have exactly 122 entries (78 apikey + 19 oauth + 23 free + 2 web-cookie)");
    }

    #[test]
    fn test_by_alias_cc() {
        let entry = by_alias("cc").expect("by_alias('cc') must return the claude entry");
        assert_eq!(entry.id, "claude");
    }

    #[test]
    fn test_by_id_claude() {
        let entry = by_id("claude").expect("by_id('claude') must return entry");
        assert_eq!(entry.alias, "cc");
    }

    #[test]
    fn test_by_alias_cu_cursor() {
        let entry = by_alias("cu").expect("by_alias('cu') must return cursor");
        assert_eq!(entry.id, "cursor");
    }

    #[test]
    fn test_normalize() {
        assert_eq!(normalize_provider_id("anthropic"), "anthropic");
        assert_eq!(normalize_provider_id("cc"), "claude");
        assert_eq!(normalize_provider_id("cu"), "cursor");
    }
}
