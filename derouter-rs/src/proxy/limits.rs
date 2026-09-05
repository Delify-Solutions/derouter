//! Proxy limits — enforceKeyAccess + enforceKeyLimits. Phase 1.
//! Port of chat.js enforceKeyAccess (line 86) — runs BEFORE any upstream call.
//!
//! Checks:
//!   1. Key exists & active (401 for missing, 403 for inactive)
//!   2. allowedModels (403 if model not in list)
//!   3. expiresAt (403 if expired)
//!   4. RPM (429 if exceeded in current window)
//!   5. TPM (429 if exceeded in current window)
//!   6. budget (429 if windowCostUsd >= budgetUsd)
//! Window reset: if now - windowStartedAt > resetWindow, reset counters first.

use rusqlite::Connection;

use super::super::db::repos::api_keys::{self, ApiKeyForAuth};
use super::super::db::repos::usage;
use super::resolve;

/// Result of an access check — either OK or a specific HTTP error
#[derive(Debug)]
pub enum AccessError {
    /// 401 — key not found
    KeyNotFound,
    /// 403 — key inactive
    KeyInactive,
    /// 403 — model not in allowedModels
    ModelNotAllowed(String),
    /// 403 — key expired
    KeyExpired,
    /// 429 — RPM exceeded
    RateLimitExceeded { limit: i64, current: i64, kind: RateLimitKind },
    /// 429 — budget exceeded
    BudgetExceeded { limit: f64, spent: f64 },
}

#[derive(Debug, Clone, Copy)]
pub enum RateLimitKind {
    Rpm,
    Tpm,
}

impl AccessError {
    /// Convert to (status_code, JSON error body)
    pub fn to_error_response(&self) -> (axum::http::StatusCode, serde_json::Value) {
        let (status, message, error_type) = match self {
            AccessError::KeyNotFound => (
                axum::http::StatusCode::UNAUTHORIZED,
                "Invalid API key".to_string(),
                "authentication_error",
            ),
            AccessError::KeyInactive => (
                axum::http::StatusCode::FORBIDDEN,
                "API key is inactive".to_string(),
                "permission_error",
            ),
            AccessError::ModelNotAllowed(m) => (
                axum::http::StatusCode::FORBIDDEN,
                format!("Model '{}' is not allowed for this key", m),
                "permission_error",
            ),
            AccessError::KeyExpired => (
                axum::http::StatusCode::FORBIDDEN,
                "API key has expired".to_string(),
                "permission_error",
            ),
            AccessError::RateLimitExceeded { kind, limit, current } => {
                let kind_str = match kind {
                    RateLimitKind::Rpm => "requests per minute",
                    RateLimitKind::Tpm => "tokens per minute",
                };
                (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    format!("{} limit exceeded ({}/{})", kind_str, current, limit),
                    "rate_limit_error",
                )
            }
            AccessError::BudgetExceeded { limit, spent } => (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                format!("Budget exceeded (${:.4}/${:.2})", spent, limit),
                "budget_exceeded",
            ),
        };
        (
            status,
            serde_json::json!({
                "error": {
                    "message": message,
                    "type": error_type,
                }
            }),
        )
    }
}

/// Enforce key access — runs BEFORE any upstream call (D8 invariant).
/// Checks key validity, allowed models, expiry, RPM, TPM, and budget.
/// `model_str` is the raw model from the client request (may be a combo name).
pub fn enforce_key_access(
    conn: &Connection,
    api_key: &str,
    model_str: &str,
) -> Result<ApiKeyForAuth, AccessError> {
    // 1. Get key from DB — must exist and be active
    let key_auth = match api_keys::get_api_key_for_auth(conn, api_key)
        .map_err(|_| AccessError::KeyNotFound)?
    {
        Some(k) => k,
        None => return Err(AccessError::KeyNotFound),
    };

    if !key_auth.is_active {
        return Err(AccessError::KeyInactive);
    }

    // 2. Check allowed models (with combo resolution)
    if !resolve::is_model_allowed_with_combos(conn, &key_auth.allowed_models, model_str) {
        return Err(AccessError::ModelNotAllowed(model_str.to_string()));
    }

    // 3. Check expiry
    if let Some(ref expires_at) = key_auth.expires_at {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(expires_at) {
            if chrono::Utc::now() > expiry.with_timezone(&chrono::Utc) {
                return Err(AccessError::KeyExpired);
            }
        }
    }

    // 4. Check rate limits — reset window if needed first
    let window_started_at = check_and_reset_window(conn, &key_auth);

    // RPM check
    if let Some(rpm) = key_auth.rpm {
        if rpm > 0 {
            let rate = usage::get_key_rate_usage(conn, api_key, 60_000)
                .map_err(|_| AccessError::RateLimitExceeded {
                    limit: rpm,
                    current: 0,
                    kind: RateLimitKind::Rpm,
                })?;
            if rate.requests >= rpm {
                return Err(AccessError::RateLimitExceeded {
                    limit: rpm,
                    current: rate.requests,
                    kind: RateLimitKind::Rpm,
                });
            }
        }
    }

    // TPM check
    if let Some(tpm) = key_auth.tpm {
        if tpm > 0 {
            let rate = usage::get_key_rate_usage(conn, api_key, 60_000)
                .map_err(|_| AccessError::RateLimitExceeded {
                    limit: tpm,
                    current: 0,
                    kind: RateLimitKind::Tpm,
                })?;
            if rate.tokens >= tpm {
                return Err(AccessError::RateLimitExceeded {
                    limit: tpm,
                    current: rate.tokens,
                    kind: RateLimitKind::Tpm,
                });
            }
        }
    }

    // 5. Budget check
    if let Some(budget) = key_auth.budget_usd {
        if budget > 0.0 {
            let spent = window_cost_usd(&key_auth, &window_started_at, conn, api_key);
            if spent >= budget {
                return Err(AccessError::BudgetExceeded {
                    limit: budget,
                    spent,
                });
            }
        }
    }

    Ok(key_auth)
}

/// Check if the window needs to be reset, and if so, reset it.
/// Returns the effective windowStartedAt.
fn check_and_reset_window(conn: &Connection, key_auth: &ApiKeyForAuth) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let window_started = key_auth.window_started_at.clone().unwrap_or_else(|| now.clone());

    // Parse the window start time
    let window_start = chrono::DateTime::parse_from_rfc3339(&window_started)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    // Parse the reset window duration
    // Named windows must match Node's WINDOW_MS exactly:
    //   "5h" → 5*60*60*1000, "day" → 24*60*60*1000, "week" → 7*24*60*60*1000
    let reset_window_ms = key_auth
        .reset_window
        .as_deref()
        .and_then(|s| {
            let s = s.trim();

            // Named windows (match Node keyEnforcement.js WINDOW_MS)
            match s {
                "5h" => return Some(5 * 3600 * 1000),
                "day" => return Some(24 * 3600 * 1000),
                "week" => return Some(7 * 24 * 3600 * 1000),
                _ => {}
            }

            // Numeric milliseconds
            if let Ok(ms) = s.parse::<i64>() {
                return Some(ms);
            }
            // Parse duration strings: "60s", "1h", "24h", "7d"
            if s.ends_with('s') {
                s[..s.len() - 1].parse::<i64>().ok().map(|v| v * 1000)
            } else if s.ends_with('m') {
                s[..s.len() - 1].parse::<i64>().ok().map(|v| v * 60 * 1000)
            } else if s.ends_with('h') {
                s[..s.len() - 1].parse::<i64>().ok().map(|v| v * 3600 * 1000)
            } else if s.ends_with('d') {
                s[..s.len() - 1].parse::<i64>().ok().map(|v| v * 86400 * 1000)
            } else {
                None
            }
        })
        .unwrap_or(3600 * 1000); // Default: 1 hour

    let elapsed = (chrono::Utc::now() - window_start).num_milliseconds();
    if elapsed > reset_window_ms {
        // Reset window
        let _ = api_keys::reset_key_window(conn, &key_auth.id, &now);
        return now;
    }

    window_started
}

/// Calculate the effective window cost — either the stored windowCostUsd
/// or sum of costs since windowStartedAt.
fn window_cost_usd(
    key_auth: &ApiKeyForAuth,
    window_started: &str,
    conn: &Connection,
    api_key: &str,
) -> f64 {
    // Use the stored window cost, but also add any costs since the window started
    let stored_cost = key_auth.window_cost_usd;
    let since_cost = usage::get_key_cost_since(conn, api_key, window_started)
        .unwrap_or(0.0);
    stored_cost.max(since_cost)
}
