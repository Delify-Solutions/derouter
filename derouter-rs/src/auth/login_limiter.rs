//! Login limiter — in-memory progressive lockout.
//! Ported from src/lib/auth/loginLimiter.js.
//! DashMap-based, resets on process restart (parity with Node).

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use once_cell::sync::Lazy;

/// 5 failed attempts before lockout kicks in.
pub const MAX_FAILS_BEFORE_LOCK: u32 = 5;

/// Lock durations escalate: 30s, 2m, 10m, 30m.
pub const LOCK_STEPS_MS: &[u64] = &[30_000, 120_000, 600_000, 1_800_000];

/// 1 hour since last fail → auto reset.
pub const FAIL_WINDOW_MS: u64 = 3_600_000;

/// Entry stored per-IP.
#[derive(Debug, Clone)]
struct Entry {
    fails: u32,
    lock_until: Option<SystemTime>,
    lock_level: u32,
    last_fail_at: Option<SystemTime>,
}

impl Default for Entry {
    fn default() -> Self {
        Self {
            fails: 0,
            lock_until: None,
            lock_level: 0,
            last_fail_at: None,
        }
    }
}

static ATTEMPTS: Lazy<DashMap<String, Entry>> = Lazy::new(DashMap::new);

/// Get current time as SystemTime.
fn now() -> SystemTime {
    SystemTime::now()
}

/// Duration since a SystemTime, in millis.
fn elapsed_since(t: SystemTime) -> u64 {
    now().duration_since(t)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}

/// SystemTime to Unix millis.
fn to_millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Check if an IP is currently locked.
/// Returns `Some(retry_after_seconds)` if locked.
pub fn check_lock(ip: &str) -> Option<u64> {
    // Try to get entry, auto-reset if window expired
    let entry = match ATTEMPTS.get(ip) {
        Some(e) => e,
        None => return None,
    };

    // Auto reset if window expired and not currently locked
    if let Some(last_fail) = entry.last_fail_at {
        if elapsed_since(last_fail) > FAIL_WINDOW_MS {
            // Window expired — check if lock has also expired
            let still_locked = entry.lock_until
                .map(|lu| now() < lu)
                .unwrap_or(false);
            if !still_locked {
                drop(entry);
                ATTEMPTS.remove(ip);
                return None;
            }
        }
    }

    let lock_until = match entry.lock_until {
        Some(lu) => lu,
        None => return None,
    };

    let remaining = lock_until
        .duration_since(now())
        .ok()
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if remaining == 0 {
        // Lock expired
        return None;
    }

    Some(remaining)
}

/// Record a failed login attempt. Returns (remainingBeforeLock,)
/// If the IP was just locked, returns (0,) and the caller should check lock.
pub fn record_fail(ip: &str) -> u32 {
    let mut entry = ATTEMPTS.entry(ip.to_string()).or_default();
    entry.fails += 1;
    entry.last_fail_at = Some(now());

    if entry.fails >= MAX_FAILS_BEFORE_LOCK {
        let step_idx = entry.lock_level.min(LOCK_STEPS_MS.len() as u32 - 1) as usize;
        let step_ms = LOCK_STEPS_MS[step_idx];
        entry.lock_until = Some(now() + Duration::from_millis(step_ms));
        entry.lock_level += 1;
        entry.fails = 0;
    }

    let remaining = MAX_FAILS_BEFORE_LOCK.saturating_sub(entry.fails);
    remaining
}

/// Record a successful login — clears all attempts for this IP.
pub fn record_success(ip: &str) {
    ATTEMPTS.remove(ip);
}

/// Extract client IP from request headers.
/// Ported from loginLimiter.js getClientIp + trustedPeer.js.
pub fn get_client_ip(headers: &axum::http::HeaderMap) -> String {
    // Trusted only when DEROUTER_PEER_TOKEN matches
    if let Ok(token) = std::env::var("DEROUTER_PEER_TOKEN") {
        if !token.is_empty() {
            if let Some(peer_token) = headers.get("x-dr-peer-token") {
                if peer_token.to_str().map(|s| s == token).unwrap_or(false) {
                    if let Some(real_ip) = headers.get("x-dr-real-ip") {
                        if let Ok(ip) = real_ip.to_str() {
                            return ip.to_string();
                        }
                    }
                }
            }
        }
    }

    // Behind a trusted reverse proxy
    if std::env::var("TRUST_PROXY").map(|v| v == "true").unwrap_or(false) {
        if let Some(xff) = headers.get("x-forwarded-for") {
            if let Ok(xff_str) = xff.to_str() {
                if let Some(first) = xff_str.split(',').next() {
                    let ip = first.trim();
                    if !ip.is_empty() {
                        return ip.to_string();
                    }
                }
            }
        }
    }

    // Direct exposure: single bucket so spoofed XFF rotation cannot escape the limiter
    "unknown".to_string()
}
