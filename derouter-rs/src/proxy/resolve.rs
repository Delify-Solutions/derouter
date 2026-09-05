//! Proxy resolve — combo resolution.
//! Port of combo.js getComboModelsFromData + getComboModels.
//!
//! getComboModels(model_str): if the string has no `/` and matches a combo name,
//! return that combo's models list; else treat as a single direct `[model_str]` candidate.
//! isModelAllowed(key, model_str) checks against allowedModels.
//!
//! Phase 3: provider resolution uses the registry (registry::by_id_or_alias) as the
//! source of truth. Combo member model strings are validated against registry entries.
//! AI_MODELS remains as a supplemental catalog for passthrough/compatible providers.

use rusqlite::Connection;

use super::super::db::repos::combos;
use crate::providers::registry;
use crate::providers::capabilities::AI_MODELS;

/// Resolve a model string into a list of model candidates.
/// If `model_str` has no `/` and matches a combo name, return the combo's models.
/// Otherwise, treat it as a single direct model: `[model_str]`.
pub fn get_combo_models(conn: &Connection, model_str: &str) -> Vec<String> {
    // If the model string contains "/", it's a direct provider/model reference — not a combo
    if model_str.contains('/') {
        return vec![model_str.to_string()];
    }

    // Try to find a combo with this name
    if let Ok(Some(combo)) = combos::get_combo_by_name(conn, model_str) {
        if !combo.models.is_empty() {
            return combo.models;
        }
    }

    // Not a combo or empty combo — treat as a single direct model
    vec![model_str.to_string()]
}

/// Check if a model string is allowed for a key.
/// `allowed_models` is the key's (or group's) allowed model list.
/// If `allowed_models` is None or empty, all models are allowed.
/// A model matches if:
///   - It exactly matches an entry in allowed_models
///   - It matches a combo name in allowed_models (the combo itself is the allowed entry)
///   - It's a direct `provider/model` and the bare model part matches
pub fn is_model_allowed(allowed_models: &Option<Vec<String>>, model_str: &str) -> bool {
    match allowed_models {
        None => true, // No restriction
        Some(models) if models.is_empty() => true, // Empty list = no restriction
        Some(models) => {
            // Exact match
            if models.iter().any(|m| m == model_str) {
                return true;
            }
            // If model_str contains "/", check the model part (after the slash)
            if let Some(model_part) = model_str.split('/').next_back() {
                if models.iter().any(|m| m == model_part) {
                    return true;
                }
            }
            // Check if model_str is a combo name and any of the combo's model entries
            // match the allowed list — but we can't do that here without DB access.
            // The combo's individual models are checked when each is tried.
            // For the initial gate, the combo name itself must be in the allowed list,
            // OR any of the combo's models must match.
            // The Node code checks: allowedModels.includes(requestedModel) for combos.
            // We already checked exact match above, so if we get here, it's not allowed.
            false
        }
    }
}

/// Check if a model string is allowed, considering combo resolution.
/// If the model is a combo name, the combo name itself must be in allowed_models,
/// OR any of the combo's resolved models must match.
pub fn is_model_allowed_with_combos(
    conn: &Connection,
    allowed_models: &Option<Vec<String>>,
    model_str: &str,
) -> bool {
    match allowed_models {
        None => true,
        Some(models) if models.is_empty() => true,
        Some(models) => {
            // Exact match on the requested model string
            if models.iter().any(|m| m == model_str) {
                return true;
            }
            // If it's a combo name, check if any of the combo's models are allowed
            if !model_str.contains('/') {
                if let Ok(Some(combo)) = combos::get_combo_by_name(conn, model_str) {
                    for cm in &combo.models {
                        // Check each combo model against allowed list
                        let model_part = cm.split('/').next_back().unwrap_or(cm);
                        if models.iter().any(|m| m == cm || m == model_part) {
                            return true;
                        }
                    }
                }
            }
            // Direct model: check model part (after /)
            if let Some(model_part) = model_str.split('/').next_back() {
                if models.iter().any(|m| m == model_part) {
                    return true;
                }
            }
            false
        }
    }
}

/// Validate that a (provider, model) pair exists in the registry or AI_MODELS catalog.
/// Uses registry::by_id_or_alias for provider lookup.
/// Returns true if the provider is known and the model is in its transport.models list,
/// or if the pair appears in AI_MODELS (for passthrough/compatible providers).
pub fn is_valid_provider_model(provider: &str, model: &str) -> bool {
    // Check registry first
    if let Some(entry) = registry::by_id_or_alias(provider) {
        for pm in entry.models {
            if pm.id == model {
                return true;
            }
        }
    }

    // Fall back to AI_MODELS catalog
    for (p, m, _) in AI_MODELS.iter() {
        if (*p == provider || *p == registry::id_to_alias(provider).unwrap_or(provider))
            && *m == model
        {
            return true;
        }
    }

    // Passthrough/compatible providers accept any model
    if registry::is_openai_compatible_provider(provider)
        || registry::is_anthropic_compatible_provider(provider)
    {
        return true;
    }

    false
}
