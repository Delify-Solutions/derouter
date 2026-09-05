//! Auth route handlers — JSON API.
//! Ported from src/app/api/auth/{login,status,logout}/route.js.
//! POST /api/auth/login — JSON login with loginLimiter + mustChangePassword.
//! GET /api/auth/status — session state + configured auth modes.
//! POST /api/auth/logout — clear cookie.

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use crate::db::DbPool;
use crate::auth;
use crate::auth::login_limiter;

const RESET_HINT: &str = "Forgot password? Reset to default via derouter CLI → Settings → Reset Password to Default.";

/// POST /api/auth/login — JSON login.
pub async fn login(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: axum::Json<serde_json::Value>,
) -> Response {
    let ip = login_limiter::get_client_ip(&headers);

    // Check lock
    if let Some(retry_after) = login_limiter::check_lock(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [
                (header::RETRY_AFTER, HeaderValue::from_str(&retry_after.to_string()).unwrap()),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
            axum::Json(serde_json::json!({
                "error": format!("Too many failed attempts. Try again in {}s. {}", retry_after, RESET_HINT),
                "retryAfter": retry_after,
                "resetHint": RESET_HINT
            })),
        )
            .into_response();
    }

    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("");

    // Get settings + stored password hash
    let pool_clone = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_clone.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        crate::db::repos::settings::get_settings(&conn)
    })
    .await;

    let settings = match settings_result {
        Ok(Ok(s)) => s,
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "Failed to load settings"})),
            )
                .into_response();
        }
    };

    // Block login via tunnel/tailscale if dashboard access is disabled
    if auth::is_tunnel_request(&headers, &settings) {
        let tunnel_access = settings.get("tunnelDashboardAccess")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !tunnel_access {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"error": "Dashboard access via tunnel is disabled"})),
            )
                .into_response();
        }
    }

    let stored_hash = settings.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Check SSO mode
    let auth_mode = settings.get("authMode").and_then(|v| v.as_str()).unwrap_or("password");
    if auth_mode == "sso" || auth_mode == "saml" || auth_mode == "oidc" {
        let sso_type = settings.get("ssoType").and_then(|v| v.as_str())
            .unwrap_or(if auth_mode == "saml" { "saml" } else { "oidc" });
        if sso_type == "saml" && auth::is_saml_configured(&settings) {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"error": "Password login is disabled. Use SAML SSO sign in."})),
            )
                .into_response();
        }
        if sso_type == "oidc" && auth::is_oidc_configured(&settings) {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"error": "Password login is disabled. Use OIDC sign in."})),
            )
                .into_response();
        }
    }

    // Verify password
    let is_valid = auth::verify_dashboard_password(password, stored_hash.as_deref());

    if is_valid {
        login_limiter::record_success(&ip);

        // mustChangePassword: default password on a remote client
        let has_initial_password = std::env::var("INITIAL_PASSWORD").is_ok();
        let must_change = stored_hash.is_none()
            && !has_initial_password
            && !auth::is_local_request(&headers);

        if must_change {
            return (
                StatusCode::FORBIDDEN,
                [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
                axum::Json(serde_json::json!({
                    "success": false,
                    "error": "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).",
                    "mustChangePassword": true
                })),
            )
                .into_response();
        }

        // Issue JWT token
        match auth::issue_token() {
            Ok(token) => {
                let secure = auth::should_use_secure_cookie(&headers);
                let cookie_value = auth::build_cookie_value(&token, 86400, secure);
                return (
                    StatusCode::OK,
                    [
                        (header::SET_COOKIE, HeaderValue::from_str(&cookie_value).unwrap()),
                        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                    ],
                    axum::Json(serde_json::json!({
                        "success": true,
                        "mustChangePassword": false
                    })),
                )
                    .into_response();
            }
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({"error": "Failed to create session"})),
                )
                    .into_response();
            }
        }
    }

    // Invalid password
    let remaining = login_limiter::record_fail(&ip);
    if let Some(retry_after) = login_limiter::check_lock(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [
                (header::RETRY_AFTER, HeaderValue::from_str(&retry_after.to_string()).unwrap()),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
            axum::Json(serde_json::json!({
                "error": format!("Too many failed attempts. Try again in {}s. {}", retry_after, RESET_HINT),
                "retryAfter": retry_after,
                "resetHint": RESET_HINT
            })),
        )
            .into_response();
    }

    (
        StatusCode::UNAUTHORIZED,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(serde_json::json!({
            "error": format!("Invalid password. {} attempt(s) left before lockout.", remaining),
            "remainingBeforeLock": remaining
        })),
    )
        .into_response()
}

/// GET /api/auth/status — session state + configured auth modes.
pub async fn status(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    let pool_clone = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_clone.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        crate::db::repos::settings::get_settings(&conn)
    })
    .await;

    let settings = match settings_result {
        Ok(Ok(s)) => s,
        _ => {
            // Fallback on error (mirrors Node catch block)
            return axum::Json(serde_json::json!({
                "requireLogin": true,
                "authMode": "password",
                "ssoType": "oidc",
                "oidcConfigured": false,
                "oidcLoginLabel": "Sign in with OIDC",
                "samlConfigured": false,
                "samlLoginLabel": "Sign in with SAML SSO",
                "hasPassword": false,
                "displayName": "Password user",
                "loginMethod": "Password",
                "authenticated": false,
                "oidcName": null,
                "oidcEmail": null,
                "oidcLogin": false,
                "samlName": null,
                "samlEmail": null,
                "samlLogin": false,
            }))
                .into_response();
        }
    };

    // Extract token from cookie
    let token = extract_auth_token(&headers);
    let authenticated = token
        .as_deref()
        .and_then(auth::verify_token)
        .map(|c| c.authenticated)
        .unwrap_or(false);

    let require_login = settings.get("requireLogin").and_then(|v| v.as_bool()).unwrap_or(true);
    let auth_mode = settings.get("authMode").and_then(|v| v.as_str()).unwrap_or("password");
    let sso_type = settings.get("ssoType").and_then(|v| v.as_str()).unwrap_or("oidc");
    let has_password = settings.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);

    let oidc_login_label = settings.get("oidcLoginLabel").and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Sign in with OIDC");
    let saml_login_label = settings.get("samlLoginLabel").and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Sign in with SAML SSO");

    axum::Json(serde_json::json!({
        "requireLogin": require_login,
        "authMode": auth_mode,
        "ssoType": sso_type,
        "oidcConfigured": auth::is_oidc_configured(&settings),
        "oidcLoginLabel": oidc_login_label,
        "samlConfigured": auth::is_saml_configured(&settings),
        "samlLoginLabel": saml_login_label,
        "hasPassword": has_password,
        "displayName": "Password user",
        "loginMethod": "Password",
        "authenticated": authenticated,
        "oidcName": null,
        "oidcEmail": null,
        "oidcLogin": false,
        "samlName": null,
        "samlEmail": null,
        "samlLogin": false,
    }))
        .into_response()
}

/// POST /api/auth/logout — clear cookie.
pub async fn logout(headers: axum::http::HeaderMap) -> Response {
    let secure = auth::should_use_secure_cookie(&headers);
    let cookie_value = auth::build_clear_cookie_value(secure);
    (
        StatusCode::OK,
        [
            (header::SET_COOKIE, HeaderValue::from_str(&cookie_value).unwrap()),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        axum::Json(serde_json::json!({"success": true})),
    )
        .into_response()
}

/// Extract auth_token from Cookie header.
fn extract_auth_token(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(cookie_header) = headers.get(axum::http::header::COOKIE) {
        if let Ok(cookie_str) = cookie_header.to_str() {
            for cookie in cookie_str.split(';') {
                let cookie = cookie.trim();
                if let Some(value) = cookie.strip_prefix("auth_token=") {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

// ===== Auth routes (JSON API) =====

/// POST /api/auth/reset-password — reset dashboard password.
/// First-run: accepts newPassword only (no currentPassword needed).
/// Existing: requires currentPassword verification.
/// On success: issues a fresh auth_token cookie.
pub async fn reset_password(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: axum::Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = crate::auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let new_password = body.get("newPassword").and_then(|v| v.as_str()).unwrap_or("");
    let current_password = body.get("currentPassword").and_then(|v| v.as_str()).unwrap_or("");

    if new_password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "New password is required"})),
        ).into_response();
    }

    // Get current settings
    let pool_clone = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_clone.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        crate::db::repos::settings::get_settings(&conn)
    })
    .await;

    let settings = match settings_result {
        Ok(Ok(s)) => s,
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({"error": "Failed to load settings"}))).into_response(),
    };

    let stored_hash = settings.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());

    // If hash exists, verify current password
    if let Some(ref hash) = stored_hash {
        if !hash.is_empty() {
            if current_password.is_empty() {
                return (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({"error": "Current password required"}))).into_response();
            }
            let is_valid = crate::auth::verify_password(current_password, hash)
                || bcrypt::verify(current_password, hash).unwrap_or(false);
            if !is_valid {
                return (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({"error": "Invalid current password"}))).into_response();
            }
        }
    }

    // Hash new password
    let new_hash = match crate::auth::hash_password(new_password) {
        Ok(h) => h,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({"error": "Failed to hash password"}))).into_response(),
    };

    // Save to settings
    let pool_clone = pool.clone();
    let save_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_clone.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let mut update = serde_json::Map::new();
        update.insert("password".to_string(), serde_json::json!(new_hash));
        crate::db::repos::settings::update_settings(&conn, &serde_json::Value::Object(update))
    })
    .await;

    match save_result {
        Ok(Ok(_)) => {
            // Issue fresh cookie
            match crate::auth::issue_token() {
                Ok(token) => {
                    let secure = crate::auth::should_use_secure_cookie(&headers);
                    let cookie_value = crate::auth::build_cookie_value(&token, 86400, secure);
                    (
                        StatusCode::OK,
                        [(header::SET_COOKIE, HeaderValue::from_str(&cookie_value).unwrap())],
                        axum::Json(serde_json::json!({"success": true})),
                    ).into_response()
                }
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({"error": "Failed to create session"}))).into_response(),
            }
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({"error": "Failed to update password"}))).into_response(),
    }
}
