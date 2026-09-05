//! Shared helpers for CLI tools routes — file I/O, binary detection, key masking.

use std::path::PathBuf;

/// Return the user's home directory via `dirs::home_dir()`, falling back to "."
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Check if a CLI binary is installed by running `which <name>` (Unix) or `where <name>` (Windows).
/// Falls back to checking if any of `fallback_paths` exist on disk.
pub async fn check_installed(name: &str, fallback_paths: &[PathBuf]) -> bool {
    let cmd = if std::env::consts::OS == "windows" { "where" } else { "which" };

    if tokio::process::Command::new(cmd)
        .arg(name)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }

    for p in fallback_paths {
        if tokio::fs::metadata(p).await.is_ok() {
            return true;
        }
    }

    false
}

/// Recursively mask sensitive fields (apiKey, api_key, authToken, auth_token, token, Authorization)
/// in a JSON value, replacing their values with `"****"`.
pub fn mask_api_keys(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(mut map) => {
            for (k, v) in map.iter_mut() {
                let k_lower = k.to_lowercase();
                if k_lower.contains("apikey")
                    || k_lower == "api_key"
                    || k_lower == "authtoken"
                    || k_lower == "auth_token"
                    || k_lower == "token"
                    || k_lower == "authorization"
                    || k_lower == "openaiapikey"
                    || k_lower == "apikey"
                {
                    if !is_object_or_array(v) {
                        *v = serde_json::json!("****");
                    } else {
                        *v = mask_api_keys(v.clone());
                    }
                } else {
                    *v = mask_api_keys(v.clone());
                }
            }
            serde_json::Value::Object(map)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(mask_api_keys).collect())
        }
        other => other,
    }
}

fn is_object_or_array(v: &serde_json::Value) -> bool {
    matches!(v, serde_json::Value::Object(_) | serde_json::Value::Array(_))
}

/// Read a JSON file, tolerating trailing commas (JSONC). Returns `None` if the file
/// doesn't exist or can't be parsed.
pub async fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            let stripped = strip_trailing_commas(&content);
            serde_json::from_str(&stripped).ok()
        }
        Err(_) => None,
    }
}

/// Write a JSON value to a file with pretty formatting.
pub async fn write_json_file(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("Failed to create directory: {}", e));
            }
        }
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| format!("Failed to serialize: {}", e))?;
    tokio::fs::write(path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Read a text file, returning an empty string if it doesn't exist.
pub async fn read_text_file(path: &std::path::Path) -> String {
    tokio::fs::read_to_string(path)
        .await
        .unwrap_or_default()
}

/// Read a text file, returning `None` if it doesn't exist (distinguishes ENOENT from empty).
pub async fn read_text_file_opt(path: &std::path::Path) -> Option<String> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => None,
    }
}

/// Write text to a file, creating parent directories as needed.
pub async fn write_text_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("Failed to create directory: {}", e));
            }
        }
    }
    tokio::fs::write(path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Strip trailing commas before `}` or `]` to tolerate JSONC.
fn strip_trailing_commas(content: &str) -> String {
    // Simple approach: remove comma followed by optional whitespace and then } or ]
    let mut result = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b',' {
            // Look ahead for optional whitespace then } or ]
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t' || bytes[j] == b'\n' || bytes[j] == b'\r') {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                // Skip the comma
                i += 1;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

/// Normalize a base URL to ensure it ends with `/v1` (append only once).
pub fn normalize_v1(base_url: &str) -> String {
    if base_url.ends_with("/v1") {
        base_url.to_string()
    } else {
        format!("{}/v1", base_url)
    }
}

/// Normalize a base URL by stripping a trailing `/v1` (for tools that don't want it).
pub fn strip_v1(base_url: &str) -> String {
    if base_url.ends_with("/v1") {
        base_url[..base_url.len() - 3].to_string()
    } else {
        base_url.to_string()
    }
}

/// Check if a URL points to localhost / 127.0.0.1 / 0.0.0.0
pub fn is_localhost_url(url: &str) -> bool {
    url.contains("localhost") || url.contains("127.0.0.1") || url.contains("0.0.0.0")
}
