//! Auth module — argon2 password verification, JWT cookies, RequireAdmin guard.
//! Phase 1: adds login_limiter, tunnel/local detection, OIDC/SAML detection.

pub mod password;
pub mod guards;
pub mod login_limiter;

pub use guards::{RequireAdmin, AdminClaims, issue_token, verify_token, verify_dashboard_password, extract_token, ADMIN_COOKIE_NAME, require_auth};
pub use password::{hash_password, verify_password};
pub use login_limiter::{check_lock, record_fail, record_success, get_client_ip};

/// Extract hostname from a URL string (simple parser — handles http://host[:port]/path).
fn extract_hostname(url: &str) -> String {
    let s = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);

    // Take everything before the first /
    let authority = s.split('/').next().unwrap_or(s);

    // Strip port (but handle IPv6 brackets)
    let host = if authority.starts_with('[') {
        let end = authority.find(']').unwrap_or(authority.len());
        &authority[1..end]
    } else {
        authority.split(':').next().unwrap_or(authority)
    };

    host.to_lowercase()
}

/// Check if the request is a tunnel request (via tunnel/tailscale URL).
/// Ported from src/app/api/auth/login/route.js isTunnelRequest.
pub fn is_tunnel_request(headers: &axum::http::HeaderMap, settings: &serde_json::Value) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();

    if host.is_empty() {
        return false;
    }

    // Check tunnelUrl
    if let Some(tunnel_url) = settings.get("tunnelUrl").and_then(|v| v.as_str()) {
        let tunnel_host = extract_hostname(tunnel_url);
        if !tunnel_host.is_empty() && host == tunnel_host {
            return true;
        }
    }

    // Check tailscaleUrl
    if let Some(tailscale_url) = settings.get("tailscaleUrl").and_then(|v| v.as_str()) {
        let tailscale_host = extract_hostname(tailscale_url);
        if !tailscale_host.is_empty() && host == tailscale_host {
            return true;
        }
    }

    false
}

/// Check if the request is from a local (loopback) client.
/// Ported from src/dashboardGuard.js isLocalRequest.
pub fn is_local_request(headers: &axum::http::HeaderMap) -> bool {
    // Stamped by custom-server.js when forwarding headers exist
    if headers.get("x-dr-via-proxy").is_some() {
        return false;
    }

    if !is_loopback_peer(headers) {
        return false;
    }

    // Check origin
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        let origin_host = extract_hostname(origin);
        if !origin_host.is_empty() && !is_loopback_hostname(&origin_host) {
            return false;
        } else if origin_host.is_empty() {
            return false;
        }
    }

    true
}

/// Check if the peer is loopback (via trusted headers or host header).
fn is_loopback_peer(headers: &axum::http::HeaderMap) -> bool {
    // Trusted peer headers
    if let Ok(token) = std::env::var("DEROUTER_PEER_TOKEN") {
        if !token.is_empty() {
            if let Some(peer_token) = headers.get("x-dr-peer-token") {
                if peer_token.to_str().map(|s| s == token).unwrap_or(false) {
                    if let Some(real_ip) = headers.get("x-dr-real-ip").and_then(|v| v.to_str().ok()) {
                        return is_loopback_hostname(real_ip);
                    }
                }
            }
        }
    }

    // In development, check host header
    if std::env::var("NODE_ENV").map(|v| v == "development").unwrap_or(false) {
        if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
            return is_loopback_hostname(host);
        }
    }

    false
}

/// Check if a hostname is a loopback address.
fn is_loopback_hostname(h: &str) -> bool {
    let name = h.trim().to_lowercase();
    if name.is_empty() {
        return false;
    }

    // Handle IPv6 brackets
    let name = if name.starts_with('[') {
        let end = name.find(']').unwrap_or(name.len());
        &name[1..end]
    } else if let Some(colon) = name.find(':') {
        // Only split on first colon for IPv4
        if name.rfind(':') == Some(colon) {
            &name[..colon]
        } else {
            // IPv6 without brackets — check the whole thing
            &name
        }
    } else {
        &name
    };

    // Strip IPv4-mapped IPv6 prefix
    let name = name.strip_prefix("::ffff:").unwrap_or(name);

    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

/// Check if OIDC is configured (detection only — no flow).
pub fn is_oidc_configured(settings: &serde_json::Value) -> bool {
    settings.get("oidcIssuerUrl")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        && settings.get("oidcClientId")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
        && settings.get("oidcClientSecret")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
}

/// Check if SAML is configured (detection only — no flow).
pub fn is_saml_configured(settings: &serde_json::Value) -> bool {
    // SAML requires entryPoint and cert
    settings.get("samlEntryPoint")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        && settings.get("samlCert")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
}

/// Determine if the cookie should be Secure.
/// Ported from dashboardSession.js shouldUseSecureCookie.
pub fn should_use_secure_cookie(headers: &axum::http::HeaderMap) -> bool {
    if std::env::var("AUTH_COOKIE_SECURE").map(|v| v == "true").unwrap_or(false) {
        return true;
    }

    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "https")
        .unwrap_or(false)
}

/// Build the Set-Cookie value for auth_token.
pub fn build_cookie_value(token: &str, max_age_secs: i64, secure: bool) -> String {
    let mut cookie = format!(
        "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        ADMIN_COOKIE_NAME, token, max_age_secs
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Build the Set-Cookie value for clearing auth_token.
pub fn build_clear_cookie_value(secure: bool) -> String {
    let mut cookie = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        ADMIN_COOKIE_NAME
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}
