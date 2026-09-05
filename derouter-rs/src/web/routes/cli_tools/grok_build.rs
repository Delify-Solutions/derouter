//! Grok Build settings — reads/writes `~/.grok/config.toml` using a regex-based section editor
//! that preserves all unrelated TOML (ported from src/lib/grokBuildConfig.js).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

const GROK_MAIN_MODEL_SLOT: &str = "derouter";
const GROK_BUILTIN_DEFAULT: &str = "grok-build";
const GROK_SUBAGENT_TYPES: &[&str] = &["general-purpose", "explore", "plan"];

fn grok_dir() -> std::path::PathBuf {
    common::home_dir().join(".grok")
}

fn config_path() -> std::path::PathBuf {
    grok_dir().join("config.toml")
}

fn grok_bin_path() -> std::path::PathBuf {
    grok_dir().join("bin").join("grok")
}

async fn check_installed() -> bool {
    common::check_installed("grok", &[grok_bin_path(), config_path()]).await
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn model_slot(type_name: &str) -> String {
    format!("{}-{}", GROK_MAIN_MODEL_SLOT, type_name)
}

/// Find a TOML section `[section]` and return its body text (lines between this header
/// and the next header).
fn find_section_body(toml: &str, section: &str) -> Option<(usize, usize, String)> {
    let header = format!("[{}]", section);
    let lines: Vec<&str> = toml.lines().collect();
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == header {
            start = Some(i);
            break;
        }
    }
    let start = start?;

    // Find end (next non-indented line that looks like a header or top-level key)
    let mut end = lines.len();
    for (j, line) in lines[start + 1..].iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            end = start + 1 + j;
            break;
        }
        // A top-level key= at column 0 that's not indented (section body is indented)
        if !line.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.starts_with('#') {
            end = start + 1 + j;
            break;
        }
    }

    let body = lines[start + 1..end].join("\n");
    let body_with_newline = if body.is_empty() { String::new() } else { format!("{}\n", body) };
    Some((start, end, body_with_newline))
}

fn get_section_field(toml: &str, section: &str, key: &str) -> Option<String> {
    let (_, _, body) = find_section_body(toml, section)?;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&format!("{} =", key)) {
            let val = rest.trim();
            // Strip quotes
            if val.starts_with('"') && val.ends_with('"') {
                return Some(val[1..val.len() - 1].to_string());
            }
            return Some(val.to_string());
        }
        // Also handle key= without spaces
        if let Some(rest) = trimmed.strip_prefix(&format!("{}=", key)) {
            let val = rest.trim();
            if val.starts_with('"') && val.ends_with('"') {
                return Some(val[1..val.len() - 1].to_string());
            }
            return Some(val.to_string());
        }
    }
    None
}

fn get_section_number(toml: &str, section: &str, key: &str) -> Option<f64> {
    let (_, _, body) = find_section_body(toml, section)?;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&format!("{} =", key)) {
            let val = rest.trim();
            return val.parse::<f64>().ok();
        }
        if let Some(rest) = trimmed.strip_prefix(&format!("{}=", key)) {
            let val = rest.trim();
            return val.parse::<f64>().ok();
        }
    }
    None
}

fn set_section_field(toml: &str, section: &str, key: &str, value: &str) -> String {
    let line = format!("{} = {}", key, toml_string(value));

    if let Some((start, end, body)) = find_section_body(toml, section) {
        let lines: Vec<&str> = toml.lines().collect();
        // Check if the key already exists in the body
        let key_pattern_eq = format!("{} =", key);
        let key_pattern_nospace = format!("{}=", key);

        let mut found = false;
        let mut new_body_lines: Vec<String> = Vec::new();
        for bline in body.lines() {
            let trimmed = bline.trim();
            if !found && (trimmed.starts_with(&key_pattern_eq) || trimmed.starts_with(&key_pattern_nospace)) {
                new_body_lines.push(line.clone());
                found = true;
            } else {
                new_body_lines.push(bline.to_string());
            }
        }
        if !found {
            new_body_lines.insert(0, line.clone());
        }

        let new_body = new_body_lines.join("\n");
        let new_section = format!("[{}]\n{}\n", section, new_body);

        let mut result = lines[..start].join("\n");
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(&new_section);
        if end < lines.len() {
            result.push_str(&lines[end..].join("\n"));
        }
        result
    } else {
        // Section doesn't exist, create it
        if toml.is_empty() {
            format!("\n[{}]\n{}\n", section, line)
        } else if toml.ends_with('\n') {
            format!("{}\n[{}]\n{}\n", toml, section, line)
        } else {
            format!("{}\n\n[{}]\n{}\n", toml, section, line)
        }
    }
}

fn delete_section_field(toml: &str, section: &str, key: &str) -> String {
    if let Some((start, end, body)) = find_section_body(toml, section) {
        let lines: Vec<&str> = toml.lines().collect();
        let key_pattern_eq = format!("{} =", key);
        let key_pattern_nospace = format!("{}=", key);

        let new_body_lines: Vec<String> = body
            .lines()
            .filter(|bline| {
                let trimmed = bline.trim();
                !trimmed.starts_with(&key_pattern_eq) && !trimmed.starts_with(&key_pattern_nospace)
            })
            .map(|s| s.to_string())
            .collect();

        let new_body = new_body_lines.join("\n");
        let trimmed_body = new_body.trim();

        if trimmed_body.is_empty() {
            // Remove the entire section
            let mut result = lines[..start].join("\n");
            if end < lines.len() {
                if !result.is_empty() && !result.ends_with('\n') {
                    result.push('\n');
                }
                result.push_str(&lines[end..].join("\n"));
            }
            // Collapse multiple blank lines
            collapse_blank_lines(&result)
        } else {
            let new_section = format!("[{}]\n{}\n", section, new_body);
            let mut result = lines[..start].join("\n");
            if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&new_section);
            if end < lines.len() {
                result.push_str(&lines[end..].join("\n"));
            }
            result
        }
    } else {
        toml.to_string()
    }
}

fn collapse_blank_lines(s: &str) -> String {
    let mut result = String::new();
    let mut blank_count = 0;
    for line in s.lines() {
        if line.is_empty() {
            blank_count += 1;
            if blank_count <= 2 {
                result.push('\n');
            }
        } else {
            blank_count = 0;
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}

fn build_model_section(slot: &str, model: &str, base_url: &str, api_key: &str, context_window: Option<i64>, name: &str) -> String {
    let mut lines = vec![
        format!("[model.{}]", slot),
        format!("model = {}", toml_string(model)),
        format!("base_url = {}", toml_string(base_url)),
        format!("name = {}", toml_string(name)),
        format!("description = {}", toml_string("Routed via derouter gateway")),
        format!("api_backend = \"chat_completions\""),
    ];
    if !api_key.is_empty() {
        lines.push(format!("api_key = {}", toml_string(api_key)));
    }
    if let Some(cw) = context_window {
        if cw > 0 {
            lines.push(format!("context_window = {}", cw));
        }
    }
    format!("{}\n", lines.join("\n"))
}

fn upsert_model_section(toml: &str, slot: &str, model: &str, base_url: &str, api_key: &str, context_window: Option<i64>, name: &str) -> String {
    let section = build_model_section(slot, model, base_url, api_key, context_window, name);
    if find_section_body(toml, &format!("model.{}", slot)).is_some() {
        // Replace existing
        let lines: Vec<&str> = toml.lines().collect();
        if let Some((start, end, _)) = find_section_body(toml, &format!("model.{}", slot)) {
            let mut result = lines[..start].join("\n");
            if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&section);
            if end < lines.len() {
                result.push_str(&lines[end..].join("\n"));
            }
            result
        } else {
            toml.to_string()
        }
    } else {
        // Insert
        if toml.is_empty() {
            section
        } else if toml.ends_with('\n') {
            format!("{}{}", toml, section)
        } else {
            format!("{}\n{}", toml, section)
        }
    }
}

fn remove_model_section(toml: &str, slot: &str) -> String {
    let section_name = format!("model.{}", slot);
    if let Some((start, end, _)) = find_section_body(toml, &section_name) {
        let lines: Vec<&str> = toml.lines().collect();
        let mut result = lines[..start].join("\n");
        if end < lines.len() {
            if !result.is_empty() && !result.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&lines[end..].join("\n"));
        }
        collapse_blank_lines(&result)
    } else {
        toml.to_string()
    }
}

/// Insert a marker comment before the main model section.
fn insert_marker(toml: &str, marker: &str) -> String {
    let section_name = format!("model.{}", GROK_MAIN_MODEL_SLOT);
    if let Some((start, _, _)) = find_section_body(toml, &section_name) {
        let lines: Vec<&str> = toml.lines().collect();
        let mut result = lines[..start].join("\n");
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(marker);
        result.push_str(&lines[start..].join("\n"));
        result
    } else {
        if toml.is_empty() {
            marker.to_string()
        } else if toml.ends_with('\n') {
            format!("{}{}", toml, marker)
        } else {
            format!("{}\n{}", toml, marker)
        }
    }
}

fn remember_previous_default(toml: &str) -> String {
    let marker_pattern = "# derouter-prev-default =";
    if toml.contains(marker_pattern) {
        return toml.to_string();
    }
    let current = get_section_field(toml, "models", "default");
    if current.is_none() || current.as_deref() == Some(GROK_MAIN_MODEL_SLOT) {
        return toml.to_string();
    }
    let marker = format!("# derouter-prev-default = {}\n", toml_string(&current.unwrap()));
    insert_marker(toml, &marker)
}

fn restore_previous_default(toml: &str) -> String {
    let marker_pattern = "# derouter-prev-default = ";
    // Find the marker
    let lines: Vec<&str> = toml.lines().collect();
    let mut prev_value = GROK_BUILTIN_DEFAULT.to_string();
    let mut marker_line = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with(marker_pattern) {
            let val = &line[marker_pattern.len()..];
            let val = val.trim();
            if val.starts_with('"') && val.ends_with('"') {
                prev_value = val[1..val.len() - 1].to_string();
            }
            marker_line = Some(i);
            break;
        }
    }

    let mut next = toml.to_string();
    if let Some(i) = marker_line {
        // Remove the marker line
        let mut result_lines: Vec<&str> = lines[..i].iter().copied().collect();
        result_lines.extend(lines[i + 1..].iter().copied());
        next = result_lines.join("\n");
    }

    if get_section_field(&next, "models", "default").as_deref() == Some(GROK_MAIN_MODEL_SLOT) {
        next = set_section_field(&next, "models", "default", &prev_value);
    }
    next
}

fn remember_previous_subagent(toml: &str, type_name: &str) -> String {
    let marker_pattern = format!("# derouter-prev-subagent-{} = ", type_name);
    if toml.contains(&marker_pattern) {
        return toml.to_string();
    }
    let current = get_section_field(toml, "subagents.models", type_name);
    let previous = current.unwrap_or_else(|| "__derouter_unset__".to_string());
    let marker = format!(
        "# derouter-prev-subagent-{} = {}\n",
        type_name,
        toml_string(&previous)
    );
    insert_marker(toml, &marker)
}

fn restore_previous_subagent(toml: &str, type_name: &str) -> String {
    let marker_pattern = format!("# derouter-prev-subagent-{} = ", type_name);
    let lines: Vec<&str> = toml.lines().collect();
    let mut prev_value = "__derouter_unset__".to_string();
    let mut marker_line = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with(&marker_pattern) {
            let val = &line[marker_pattern.len()..];
            let val = val.trim();
            if val.starts_with('"') && val.ends_with('"') {
                prev_value = val[1..val.len() - 1].to_string();
            }
            marker_line = Some(i);
            break;
        }
    }

    let mut next = toml.to_string();
    if let Some(i) = marker_line {
        let mut result_lines: Vec<&str> = lines[..i].iter().copied().collect();
        result_lines.extend(lines[i + 1..].iter().copied());
        next = result_lines.join("\n");
    }

    let slot = model_slot(type_name);
    if get_section_field(&next, "subagents.models", type_name).as_deref() != Some(&slot) {
        return next;
    }

    if prev_value == "__derouter_unset__" {
        delete_section_field(&next, "subagents.models", type_name)
    } else {
        set_section_field(&next, "subagents.models", type_name, &prev_value)
    }
}

/// Parse the grok build config into a structured response.
fn parse_grok_build_config(toml: &str) -> serde_json::Value {
    let mut subagent_models = serde_json::Map::new();
    let mut subagent_mappings = serde_json::Map::new();

    for type_name in GROK_SUBAGENT_TYPES {
        let mapping = get_section_field(toml, "subagents.models", type_name);
        subagent_mappings.insert(type_name.to_string(), serde_json::json!(mapping));

        let slot = model_slot(type_name);
        if mapping.as_deref() == Some(&slot) {
            let context_window = get_section_number(toml, &format!("model.{}", slot), "context_window");
            subagent_models.insert(
                type_name.to_string(),
                serde_json::json!({
                    "model": get_section_field(toml, &format!("model.{}", slot), "model"),
                    "base_url": get_section_field(toml, &format!("model.{}", slot), "base_url"),
                    "name": get_section_field(toml, &format!("model.{}", slot), "name"),
                    "api_key": get_section_field(toml, &format!("model.{}", slot), "api_key"),
                    "api_backend": get_section_field(toml, &format!("model.{}", slot), "api_backend"),
                    "context_window": context_window.filter(|c| *c > 0.0),
                }),
            );
        } else {
            subagent_models.insert(type_name.to_string(), serde_json::json!(null));
        }
    }

    let main_slot = GROK_MAIN_MODEL_SLOT;
    let main_cw = get_section_number(toml, &format!("model.{}", main_slot), "context_window");

    serde_json::json!({
        "model": {
            "model": get_section_field(toml, &format!("model.{}", main_slot), "model"),
            "base_url": get_section_field(toml, &format!("model.{}", main_slot), "base_url"),
            "name": get_section_field(toml, &format!("model.{}", main_slot), "name"),
            "api_key": get_section_field(toml, &format!("model.{}", main_slot), "api_key"),
            "api_backend": get_section_field(toml, &format!("model.{}", main_slot), "api_backend"),
            "context_window": main_cw.filter(|c| *c > 0.0),
        },
        "default": get_section_field(toml, "models", "default"),
        "subagentModels": serde_json::Value::Object(subagent_models),
        "subagentMappings": serde_json::Value::Object(subagent_mappings),
    })
}

/// Apply grok build config changes.
fn apply_grok_build_config(
    toml: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    context_window: Option<i64>,
    subagent_models: Option<&serde_json::Value>,
) -> String {
    let mut next = remember_previous_default(toml);
    next = upsert_model_section(&next, GROK_MAIN_MODEL_SLOT, model, base_url, api_key, context_window, "derouter");
    next = set_section_field(&next, "models", "default", GROK_MAIN_MODEL_SLOT);

    if let Some(subagents) = subagent_models {
        if let Some(obj) = subagents.as_object() {
            for type_name in GROK_SUBAGENT_TYPES {
                let slot = model_slot(type_name);
                if let Some(selected) = obj.get(*type_name) {
                    if let Some(sel_model) = selected.get("model").and_then(|m| m.as_str()) {
                        if !sel_model.is_empty() {
                            let sel_cw = selected.get("contextWindow").and_then(|c| c.as_i64());
                            next = remember_previous_subagent(&next, type_name);
                            next = upsert_model_section(
                                &next,
                                &slot,
                                sel_model,
                                base_url,
                                api_key,
                                sel_cw,
                                &format!("derouter {}", type_name),
                            );
                            next = set_section_field(&next, "subagents.models", type_name, &slot);
                            continue;
                        }
                    }
                }
                // No model for this type — restore previous and remove section
                next = restore_previous_subagent(&next, type_name);
                next = remove_model_section(&next, &slot);
            }
        }
    }

    next
}

fn reset_grok_build_config(toml: &str) -> String {
    let mut next = toml.to_string();
    for type_name in GROK_SUBAGENT_TYPES {
        next = restore_previous_subagent(&next, type_name);
        next = remove_model_section(&next, &model_slot(type_name));
    }
    next = remove_model_section(&next, GROK_MAIN_MODEL_SLOT);
    next = restore_previous_default(&next);
    collapse_blank_lines(&next)
}

/// GET — read config.toml, return parsed settings.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Grok Build is not installed",
        }))
        .into_response();
    }

    let toml_text = common::read_text_file(&config_path()).await;
    let settings = parse_grok_build_config(&toml_text);
    let has = settings
        .get("model")
        .and_then(|m| m.get("base_url"))
        .and_then(|b| b.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    Json(serde_json::json!({
        "installed": true,
        "settings": settings,
        "hasderouter": has,
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — apply derouter model + optional subagent overrides.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let context_window = body.get("contextWindow").and_then(|v| v.as_i64());
    let subagent_models = body.get("subagentModels");

    if base_url.is_empty() || model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and model are required"})),
        )
            .into_response();
    }

    let _ = tokio::fs::create_dir_all(grok_dir()).await;
    let normalized_base_url = common::normalize_v1(base_url);
    let key_to_use = if api_key.is_empty() { "sk_derouter" } else { api_key };

    let existing = common::read_text_file(&config_path()).await;
    let new_toml = apply_grok_build_config(
        &existing,
        &normalized_base_url,
        &key_to_use,
        &model,
        context_window,
        subagent_models,
    );

    if let Err(e) = tokio::fs::write(config_path(), new_toml.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update grok-build settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Grok Build settings applied successfully!",
        "configPath": config_path().to_string_lossy(),
        "modelSlot": "derouter",
    }))
    .into_response()
}

/// DELETE — remove all derouter model sections and restore previous defaults.
pub async fn delete() -> Response {
    let existing = match common::read_text_file_opt(&config_path()).await {
        Some(t) => t,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    let reset = reset_grok_build_config(&existing);
    if let Err(e) = tokio::fs::write(config_path(), reset.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset grok-build settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter model slots removed from Grok Build",
    }))
    .into_response()
}
