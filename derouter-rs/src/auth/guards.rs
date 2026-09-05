//! JWT token management + RequireAdmin guard — Phase 2.
//! Port of src/lib/auth/dashboardSession.js.
//! JWT secret from JWT_SECRET env or generated file in DATA_DIR/jwt-secret.
//! Cookie name: auth_token. Token expiry: 24h.
//! Password from settings.password (bcrypt or argon2) or INITIAL_PASSWORD env (default "123456").

use std::path::PathBuf;
use std::os::unix::fs::OpenOptionsExt;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{Redirect, Response, IntoResponse};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// JWT claims — matches Node's { authenticated: true }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminClaims {
    pub authenticated: bool,
    pub exp: usize,
}

/// Cookie name for the admin session (matches Node)
pub const ADMIN_COOKIE_NAME: &str = "auth_token";

/// Load JWT secret from env or generate/persist in DATA_DIR
fn get_jwt_secret() -> Vec<u8> {
    // Try env first
    if let Ok(secret) = std::env::var("JWT_SECRET") {
        return secret.into_bytes();
    }

    // Try file in DATA_DIR
    let data_dir = std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir().unwrap_or_default().join(".derouter")
        });
    let secret_file = data_dir.join("jwt-secret");

    // Try reading existing
 if let Ok(secret) = std::fs::read_to_string(&secret_file) {
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            return trimmed.as_bytes().to_vec();
        }
    }

    // Generate new secret
    let _ = std::fs::create_dir_all(&data_dir);
    let secret = uuid::Uuid::new_v4().simple().to_string()
        + &uuid::Uuid::new_v4().simple().to_string();
    // Write the secret file with mode 0600 (owner read/write only) to prevent
    // other users from reading the JWT secret and forging tokens.
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&secret_file)
    {
        use std::io::Write;
        let _ = file.write_all(secret.as_bytes());
    }
    secret.into_bytes()
}

/// Issue a JWT token (24h expiry, matching Node)
pub fn issue_token() -> anyhow::Result<String> {
    let exp = (chrono::Utc::now().timestamp() + 86400) as usize; // 24h
    let claims = AdminClaims {
        authenticated: true,
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(&get_jwt_secret()),
    )?;
    Ok(token)
}

/// Verify a JWT token
pub fn verify_token(token: &str) -> Option<AdminClaims> {
    let mut validation = Validation::default();
    validation.leeway = 60;
    decode::<AdminClaims>(token, &DecodingKey::from_secret(&get_jwt_secret()), &validation)
        .ok()
        .map(|data| data.claims)
}

/// Extract the admin token from cookie header
pub fn extract_token(parts: &Parts) -> Option<String> {
    let headers = &parts.headers;
    if let Some(cookie_header) = headers.get(axum::http::header::COOKIE) {
        if let Ok(cookie_str) = cookie_header.to_str() {
            for cookie in cookie_str.split(';') {
                let cookie = cookie.trim();
                if let Some(value) = cookie.strip_prefix(&format!("{}=", ADMIN_COOKIE_NAME)) {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Verify the dashboard password against settings or INITIAL_PASSWORD env
pub fn verify_dashboard_password(password: &str, stored_hash: Option<&str>) -> bool {
    if password.is_empty() {
        return false;
    }

    // If we have a stored hash, verify against it
    if let Some(hash) = stored_hash {
        if !hash.is_empty() {
            // bcrypt hash ($2a$, $2b$, $2y$) — Node stores passwords as bcrypt
            if hash.starts_with("$2") {
                return bcrypt::verify(password, hash).unwrap_or(false);
            }
            // argon2 hash — Rust's own format
            if hash.starts_with("$argon2") {
                return crate::auth::password::verify_password(password, hash);
            }
            // Unknown hash format — fall through to INITIAL_PASSWORD check
        }
    }

    // Fall back to INITIAL_PASSWORD env (default "123456", matching Node DEFAULT_PASSWORD)
    let initial = std::env::var("INITIAL_PASSWORD").unwrap_or_else(|_| "123456".to_string());
    password == initial
}

/// RequireAdmin — FromRequestParts extractor that checks admin session.
/// For HTML/HTMX: redirects to /login.
/// For API/JSON: returns 401.
pub struct RequireAdmin;

impl<S: Send + Sync> FromRequestParts<S> for RequireAdmin {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let token = extract_token(parts);
        match token {
            Some(t) => {
                if let Some(claims) = verify_token(&t) {
                    if claims.authenticated {
                        return Ok(RequireAdmin);
                    }
                }
                Err(redirect_to_login(parts))
            }
            None => Err(redirect_to_login(parts)),
        }
    }
}

fn redirect_to_login(parts: &Parts) -> Response {
    let path = parts.uri.path();

    // All /api/* routes return 401 JSON (no redirect, no HTML)
    if path.starts_with("/api/") {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response();
    }

    let is_htmx = parts
        .headers
        .get("hx-request")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let accept_html = parts
        .headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false);

    if is_htmx || accept_html {
        // Add HX-Redirect header for HTMX requests
        let mut response = Redirect::to("/login").into_response();
        if is_htmx {
            response.headers_mut().insert("HX-Redirect", "/login".parse().unwrap());
        }
        response
    } else {
        (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "Unauthorized"})),
        )
            .into_response()
    }
}

/// Helper for admin API routes: check auth from Cookie header.
/// Returns Ok(()) if authenticated, Err(401 JSON response) otherwise.
pub fn require_auth(headers: &axum::http::HeaderMap) -> Result<(), Response> {
    if let Some(cookie_header) = headers.get(axum::http::header::COOKIE) {
        if let Ok(cookie_str) = cookie_header.to_str() {
            for cookie in cookie_str.split(';') {
                let cookie = cookie.trim();
                if let Some(value) = cookie.strip_prefix(&format!("{}=", ADMIN_COOKIE_NAME)) {
                    if let Some(claims) = verify_token(value) {
                        if claims.authenticated {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    Err((
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({"error": "Unauthorized"})),
    )
        .into_response())
}
