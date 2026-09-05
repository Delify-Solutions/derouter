//! Devin CLI settings — install detection only (no config to write).

use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

/// Mirror the executor's resolveDevinBin discovery paths.
fn candidate_devin_paths() -> Vec<std::path::PathBuf> {
    let home = common::home_dir();
    let is_win = std::env::consts::OS == "windows";

    if is_win {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        vec![
            local_app_data.join("devin").join("cli").join("bin").join("devin.exe"),
            home.join(".local").join("bin").join("devin.exe"),
            home.join("scoop").join("shims").join("devin.exe"),
            local_app_data.join("Programs").join("devin").join("devin.exe"),
        ]
    } else {
        vec![
            home.join(".local").join("share").join("devin").join("bin").join("devin"),
            home.join(".devin").join("bin").join("devin"),
            home.join(".local").join("bin").join("devin"),
            std::path::PathBuf::from("/opt/homebrew/bin/devin"),
            std::path::PathBuf::from("/usr/local/bin/devin"),
            std::path::PathBuf::from("/usr/bin/devin"),
        ]
    }
}

/// Check if devin is installed and report the source.
async fn check_devin_installed() -> (bool, Option<String>) {
    // 1. PATH lookup
    let cmd = if std::env::consts::OS == "windows" { "where" } else { "which" };
    if tokio::process::Command::new(cmd)
        .arg("devin")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return (true, Some("path".to_string()));
    }

    // 2. Known installer paths
    for candidate in candidate_devin_paths() {
        if tokio::fs::metadata(&candidate).await.is_ok() {
            return (true, Some(candidate.to_string_lossy().to_string()));
        }
    }

    (false, None)
}

/// Read devin version via `devin --version`.
async fn read_devin_version() -> Option<String> {
    let output = tokio::process::Command::new("devin")
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    stdout.lines().next().map(|s| s.to_string())
}

/// GET — install detection only. No config to write.
pub async fn get() -> Response {
    let (installed, source) = check_devin_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "message": "Devin CLI is not installed. Install it from https://cli.devin.ai and run `devin auth login`.",
            "installUrl": "https://cli.devin.ai",
        }))
        .into_response();
    }

    let version = read_devin_version().await;

    Json(serde_json::json!({
        "installed": true,
        "source": source,
        "version": version,
        "message": "Devin CLI detected. Make sure `devin auth login` has been run.",
    }))
    .into_response()
}
