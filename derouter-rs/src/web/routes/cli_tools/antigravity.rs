//! Antigravity MITM routes — proxies to the Node MITM manager.
//! Ported from src/app/api/cli-tools/antigravity-mitm/route.js + alias/route.js.
//!
//! NOTE: The Node MITM manager (`@/mitm/manager`) handles cert generation, DNS
//! hijacking, and server lifecycle — all of which require deep OS integration
//! (sudo, /etc/hosts, cert trust). These are NOT portable to Rust in this phase.
//! We proxy the requests to the Node backend (still running during Phase 4)
//! and return the results. The TS components will call Rust routes which
//! transparently forward to Node.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// GET antigravity-mitm — proxy to Node backend.
pub async fn get() -> Response {
    // Proxy to the Node backend which has the MITM manager
    let node_url = node_base_url("/api/cli-tools/antigravity-mitm");

    let client = reqwest::Client::new();
    match client.get(&node_url).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            // Try to parse as JSON
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response from MITM manager"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect to MITM manager: {}", e)})),
        )
            .into_response(),
    }
}

/// POST antigravity-mitm — proxy to Node backend.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let node_url = node_base_url("/api/cli-tools/antigravity-mitm");
    let client = reqwest::Client::new();

    match client.post(&node_url).json(&body.0).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response from MITM manager"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect to MITM manager: {}", e)})),
        )
            .into_response(),
    }
}

/// DELETE antigravity-mitm — proxy to Node backend.
pub async fn delete(body: Option<Json<serde_json::Value>>) -> Response {
    let node_url = node_base_url("/api/cli-tools/antigravity-mitm");
    let client = reqwest::Client::new();

    let req = client.delete(&node_url);
    let req = if let Some(Json(body)) = body {
        req.json(&body)
    } else {
        req.header("Content-Type", "application/json").body("{}")
    };

    match req.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response from MITM manager"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect to MITM manager: {}", e)})),
        )
            .into_response(),
    }
}

/// PATCH antigravity-mitm — toggle DNS for a tool.
pub async fn patch(body: Json<serde_json::Value>) -> Response {
    let node_url = node_base_url("/api/cli-tools/antigravity-mitm");
    let client = reqwest::Client::new();

    match client.patch(&node_url).json(&body.0).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response from MITM manager"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect to MITM manager: {}", e)})),
        )
            .into_response(),
    }
}

/// GET antigravity-mitm/alias — get MITM aliases.
pub async fn get_alias(query: axum::extract::Query<std::collections::HashMap<String, String>>) -> Response {
    let mut node_url = node_base_url("/api/cli-tools/antigravity-mitm/alias");
    if let Some(tool) = query.get("tool") {
        node_url.push_str(&format!("?tool={}", urlencoding::encode(tool)));
    }

    let client = reqwest::Client::new();
    match client.get(&node_url).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect: {}", e)})),
        )
            .into_response(),
    }
}

/// PUT antigravity-mitm/alias — save MITM aliases.
pub async fn put_alias(body: Json<serde_json::Value>) -> Response {
    let node_url = node_base_url("/api/cli-tools/antigravity-mitm/alias");
    let client = reqwest::Client::new();

    match client.put(&node_url).json(&body.0).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = resp.text().await.unwrap_or_default();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                (status, Json(json)).into_response()
            } else {
                (status, Json(serde_json::json!({"error": "Invalid response"}))).into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to connect: {}", e)})),
        )
            .into_response(),
    }
}

fn node_base_url(path: &str) -> String {
    let port = std::env::var("NODE_PORT").unwrap_or_else(|_| "3000".to_string());
    format!("http://localhost:{}{}", port, path)
}

// Simple URL encoding helper
mod urlencoding {
    pub fn encode(s: &str) -> String {
        let mut result = String::new();
        for c in s.chars() {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                result.push(c);
            } else {
                let bytes = c.to_string().into_bytes();
                for b in bytes {
                    result.push_str(&format!("%{:02X}", b));
                }
            }
        }
        result
    }
}
