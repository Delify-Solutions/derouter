//! Kiro token refresh — port of open-sse/services/tokenRefresh/providers.js `refreshKiroToken`.
//!
//! Checks the connection's stored access token expiry; if expired or near-expiry,
//! calls the appropriate refresh endpoint (AWS SSO OIDC, social auth, or external IdP),
//! updates the connection's token in the DB, and caches recent refreshes to
//! avoid stampede. Falls back to 401 (force re-auth) on refresh failure — does NOT loop.

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::StatusCode;
use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::Mutex;

use super::base::build_client;
use crate::db::repos::connections::ProviderConnection;

/// Milliseconds before expiry at which we proactively refresh.
const REFRESH_LEAD_MS: u64 = 5 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Result of a token refresh attempt.
pub struct RefreshedToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_ms: u64,
}

/// In-memory cache of recent refreshes keyed by connection id to avoid stampede.
static REFRESH_CACHE: Lazy<Mutex<HashMap<String, RefreshedToken>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Check if a token needs refresh based on stored expiry.
/// Returns true if the token is missing, expired, or within REFRESH_LEAD_MS of expiry.
pub fn needs_refresh(conn: &ProviderConnection) -> bool {
    let expires_at = conn
        .data
        .get("expiresAt")
        .or_else(|| conn.data.get("expires_at"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if expires_at == 0 {
        return true;
    }

    now_ms().saturating_add(REFRESH_LEAD_MS) >= expires_at
}

/// Get the current access token from connection data, checking both camelCase and snake_case.
pub fn get_access_token(conn: &ProviderConnection) -> Option<String> {
    conn.data
        .get("accessToken")
        .or_else(|| conn.data.get("access_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Get the refresh token from connection data.
pub fn get_refresh_token(conn: &ProviderConnection) -> Option<String> {
    conn.data
        .get("refreshToken")
        .or_else(|| conn.data.get("refresh_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Get provider-specific data from connection data.
pub fn get_provider_specific_data(conn: &ProviderConnection) -> Value {
    conn.data
        .get("providerSpecificData")
        .or_else(|| conn.data.get("provider_specific_data"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Refresh a Kiro access token.
///
/// Supports three auth methods:
/// - `external_idp`: External identity provider (Microsoft Entra) via form-encoded POST
/// - `idc` / AWS SSO OIDC: JSON POST to `https://oidc.{region}.amazonaws.com/token`
/// - Social auth (builder-id, google, github): JSON POST to `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`
///
/// On success, returns `RefreshedToken`. On failure, returns an error message suitable
/// for a 401 response. Does NOT loop — caller should return 401 to force re-auth.
pub async fn refresh_kiro_token(conn: &ProviderConnection) -> Result<RefreshedToken, String> {
    let conn_id = &conn.id;

    // Check in-memory cache first (stampede prevention)
    {
        let cache = REFRESH_CACHE.lock().await;
        if let Some(cached) = cache.get(conn_id) {
            if cached.expires_at_ms.saturating_sub(now_ms()) > REFRESH_LEAD_MS {
                return Ok(RefreshedToken {
                    access_token: cached.access_token.clone(),
                    refresh_token: cached.refresh_token.clone(),
                    expires_at_ms: cached.expires_at_ms,
                });
            }
        }
    }

    let psd = get_provider_specific_data(conn);
    let auth_method = psd.get("authMethod").and_then(|v| v.as_str()).unwrap_or("");
    let refresh_token = get_refresh_token(conn)
        .ok_or_else(|| "No refresh token available for Kiro connection".to_string())?;

    let client = build_client();
    let result: Result<RefreshedToken, String> = if auth_method == "external_idp" {
        refresh_external_idp(&client, &refresh_token, &psd).await
    } else if psd.get("clientId").is_some() && psd.get("clientSecret").is_some() {
        refresh_aws_sso(&client, &refresh_token, &psd, auth_method).await
    } else {
        refresh_social(&client, &refresh_token).await
    };

    match result {
        Ok(token) => {
            // Cache the refreshed token
            REFRESH_CACHE.lock().await.insert(
                conn_id.clone(),
                RefreshedToken {
                    access_token: token.access_token.clone(),
                    refresh_token: token.refresh_token.clone(),
                    expires_at_ms: token.expires_at_ms,
                },
            );
            Ok(token)
        }
        Err(e) => Err(e),
    }
}

/// Refresh token via external identity provider (Microsoft Entra / Azure AD).
async fn refresh_external_idp(
    client: &reqwest::Client,
    refresh_token: &str,
    psd: &Value,
) -> Result<RefreshedToken, String> {
    let token_endpoint = psd
        .get("tokenEndpoint")
        .or_else(|| psd.get("token_endpoint"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro external_idp: missing tokenEndpoint".to_string())?;

    // Build form-encoded body
    let mut form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
    ];

    if let Some(cid) = psd.get("clientId").and_then(|v| v.as_str()) {
        form.push(("client_id".to_string(), cid.to_string()));
    }
    if let Some(cs) = psd.get("clientSecret").and_then(|v| v.as_str()) {
        form.push(("client_secret".to_string(), cs.to_string()));
    }
    if let Some(scope) = psd.get("scope").and_then(|v| v.as_str()) {
        form.push(("scope".to_string(), scope.to_string()));
    }

    let resp = client
        .post(token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Kiro external_idp refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Kiro external_idp refresh failed ({}): {}",
            "upstream_error",
            text
        ));
    }

    let tokens: Value = resp
        .json()
        .await
        .map_err(|e| format!("Kiro external_idp: invalid response JSON: {}", e))?;

    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro external_idp: response missing access_token".to_string())?
        .to_string();
    let new_refresh = tokens
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = tokens.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);

    Ok(RefreshedToken {
        access_token,
        refresh_token: new_refresh,
        expires_at_ms: now_ms() + expires_in * 1000,
    })
}

/// Refresh token via AWS SSO OIDC (builder-id or idc).
async fn refresh_aws_sso(
    client: &reqwest::Client,
    refresh_token: &str,
    psd: &Value,
    auth_method: &str,
) -> Result<RefreshedToken, String> {
    let client_id = psd
        .get("clientId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro AWS SSO: missing clientId".to_string())?
        .to_string();
    let client_secret = psd
        .get("clientSecret")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro AWS SSO: missing clientSecret".to_string())?
        .to_string();
    let region = psd.get("region").and_then(|v| v.as_str()).unwrap_or("");

    let endpoint = if auth_method == "idc" && !region.is_empty() {
        format!("https://oidc.{}.amazonaws.com/token", region)
    } else {
        "https://oidc.us-east-1.amazonaws.com/token".to_string()
    };

    let body = serde_json::json!({
        "clientId": client_id,
        "clientSecret": client_secret,
        "refreshToken": refresh_token,
        "grantType": "refresh_token"
    });

    let resp = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kiro AWS SSO refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Kiro AWS SSO refresh failed: {}", text));
    }

    let tokens: Value = resp
        .json()
        .await
        .map_err(|e| format!("Kiro AWS SSO: invalid response JSON: {}", e))?;

    let access_token = tokens
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro AWS SSO: response missing accessToken".to_string())?
        .to_string();
    let new_refresh = tokens
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = tokens
        .get("expiresIn")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    Ok(RefreshedToken {
        access_token,
        refresh_token: new_refresh,
        expires_at_ms: now_ms() + expires_in * 1000,
    })
}

/// Refresh token via Kiro social auth (builder-id, google, github).
async fn refresh_social(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<RefreshedToken, String> {
    let endpoint = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

    let body = serde_json::json!({
        "refreshToken": refresh_token
    });

    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "kiro-cli/1.0.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kiro social refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Kiro social refresh failed: {}", text));
    }

    let tokens: Value = resp
        .json()
        .await
        .map_err(|e| format!("Kiro social: invalid response JSON: {}", e))?;

    let access_token = tokens
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Kiro social: response missing accessToken".to_string())?
        .to_string();
    let new_refresh = tokens
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = tokens
        .get("expiresIn")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    Ok(RefreshedToken {
        access_token,
        refresh_token: new_refresh,
        expires_at_ms: now_ms() + expires_in * 1000,
    })
}

/// Refresh token for Codex (OpenAI OAuth).
/// Ported from `refreshCodexToken` in providers.js.
pub async fn refresh_codex_token(refresh_token: &str) -> Result<RefreshedToken, String> {
    let client = build_client();
    let endpoint = "https://auth.openai.com/oauth/token";
    let client_id = "app_EMoamEEZ73f0CkXaXp7hrann";

    let body = serde_json::json!({
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    });

    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Codex refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        // Check for permanent failure (invalid_grant, refresh_token_reused, etc.)
        let lower = text.to_lowercase();
        let permanent = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"]
            .iter()
            .any(|m| lower.contains(m));
        if permanent {
            return Err(format!("Codex refresh token is invalid or expired — re-authentication required"));
        }
        return Err(format!("Codex refresh failed: {}", text));
    }

    let tokens: Value = resp
        .json()
        .await
        .map_err(|e| format!("Codex: invalid response JSON: {}", e))?;

    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Codex: response missing access_token".to_string())?
        .to_string();
    let new_refresh = tokens
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = tokens.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);

    Ok(RefreshedToken {
        access_token,
        refresh_token: new_refresh,
        expires_at_ms: now_ms() + expires_in * 1000,
    })
}
