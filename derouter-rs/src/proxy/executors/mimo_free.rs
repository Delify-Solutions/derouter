//! MiMo Free executor.
//! Port of open-sse/executors/mimo-free.js.
//!
//! Talks to https://api.xiaomimimo.com/api/free-ai/openai/chat — Xiaomi's free MiMo channel.
//! No user auth: the executor bootstraps a short-lived JWT from
//! https://api.xiaomimimo.com/api/free-ai/bootstrap (POST {client: <fingerprint>})
//! and uses it as a Bearer token. On 401/403 the JWT cache is reset and the
//! request retried once with a fresh token.
//!
//! Anti-abuse gates:
//! - Requires a Chrome-like User-Agent (upstream returns 403 "Illegal access" otherwise)
//! - A system message must contain the MiMoCode marker substring
//! - x-session-affinity header carries a stable per-process session id

use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use futures::StreamExt;
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct MimoFreeExecutor;

const BOOTSTRAP_URL: &str = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const CHAT_URL: &str = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
const SESSION_AFFINITY_PREFIX: &str = "ses_";
const SESSION_ID_LENGTH: usize = 24;
const JWT_FALLBACK_TTL_SEC: u64 = 3000;
const JWT_EXPIRY_BUFFER_MS: u64 = 300_000;
const SESSION_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// Anti-abuse gate: upstream rejects requests without a Chrome-like User-Agent.
const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

/// Anti-abuse gate marker: free chat endpoint 403s unless a system message
/// contains this exact MiMoCode signature substring.
pub const MIMO_SYSTEM_MARKER: &str =
    "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

/// In-memory JWT cache (per-process).
struct JwtCache {
    jwt: Option<String>,
    expires_at_ms: u64,
}

static JWT_CACHE: Lazy<Mutex<JwtCache>> = Lazy::new(|| {
    Mutex::new(JwtCache {
        jwt: None,
        expires_at_ms: 0,
    })
});

/// Stable-per-process session id (generated once per executor process lifetime).
static SESSION_ID: Lazy<String> = Lazy::new(|| {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut id = String::from(SESSION_AFFINITY_PREFIX);
    for _ in 0..SESSION_ID_LENGTH {
        let idx = rng.gen_range(0..SESSION_CHARS.len());
        id.push(SESSION_CHARS[idx] as char);
    }
    id
});

/// Pick a random user agent (mirrors the Node random pick).
fn pick_user_agent() -> &'static str {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let idx = rng.gen_range(0..USER_AGENTS.len());
    USER_AGENTS[idx]
}

/// Device fingerprint reused as the bootstrap "client" — stable per machine.
fn generate_fingerprint() -> String {
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| hostname_from_command())
        .unwrap_or_else(|_| "unknown-host".to_string());
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown-user".to_string());
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let seed = format!("{}|{}|{}|{}|{}", hostname, platform, arch, "unknown-cpu", username);
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hostname_from_command() -> Result<String, std::env::VarError> {
    // Fallback: derive a stable host token from the current dir (no external crates needed).
    Ok(std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string()))
}

/// Derive expiry from the JWT exp claim; fall back to a fixed TTL when unparseable.
fn parse_jwt_exp_ms(jwt: &str) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() >= 2 {
        if let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]) {
            let decoded: Vec<u8> = decoded;
            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&decoded) {
                if let Some(exp) = payload.get("exp").and_then(|v| v.as_u64()) {
                    return exp * 1000;
                }
            }
        }
    }
    now + JWT_FALLBACK_TTL_SEC * 1000
}

/// Ensure the body carries the anti-abuse marker in a system message (idempotent).
fn inject_system_marker(body: &mut serde_json::Value) {
    if let Some(obj) = body.as_object_mut() {
        let messages_is_array = obj.get("messages").map(|v| v.is_array()).unwrap_or(false);
        if !messages_is_array {
            return;
        }
        let has_marker = obj
            .get("messages")
            .and_then(|v| v.as_array())
            .map(|msgs| {
                msgs.iter().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("system")
                        && m.get("content")
                            .and_then(|v| v.as_str())
                            .map(|c| c.contains(MIMO_SYSTEM_MARKER))
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        if !has_marker {
            let marker_msg = serde_json::json!({"role": "system", "content": MIMO_SYSTEM_MARKER});
            if let Some(msgs) = obj.get_mut("messages").and_then(|v| v.as_array_mut()) {
                msgs.insert(0, marker_msg);
            }
        }
    }
}

async fn reset_jwt_cache() {
    let mut cache = JWT_CACHE.lock().await;
    cache.jwt = None;
    cache.expires_at_ms = 0;
}

async fn bootstrap_jwt() -> anyhow::Result<String> {
    {
        let cache = JWT_CACHE.lock().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if let Some(ref jwt) = cache.jwt {
            if now < cache.expires_at_ms.saturating_sub(JWT_EXPIRY_BUFFER_MS) {
                return Ok(jwt.clone());
            }
        }
    }

    let client = build_client();
    let resp = client
        .post(BOOTSTRAP_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", pick_user_agent())
        .json(&serde_json::json!({"client": generate_fingerprint()}))
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("MiMo bootstrap failed: {}", status.as_u16());
    }

    let data: serde_json::Value = resp.json().await?;
    let jwt = data
        .get("jwt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("MiMo bootstrap returned no JWT"))?
        .to_string();

    let expires_at = parse_jwt_exp_ms(&jwt);
    {
        let mut cache = JWT_CACHE.lock().await;
        cache.jwt = Some(jwt.clone());
        cache.expires_at_ms = expires_at;
    }
    Ok(jwt)
}

#[async_trait::async_trait]
impl ProviderExecutor for MimoFreeExecutor {
    async fn stream(
        &self,
        _conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        inject_system_marker(&mut body);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let jwt = bootstrap_jwt().await?;

        let client = build_client();
        let mut resp = client
            .post(CHAT_URL)
            .header("Content-Type", "application/json")
            .header("X-Mimo-Source", "mimocode-cli-free")
            .header("User-Agent", pick_user_agent())
            .header("x-session-affinity", SESSION_ID.as_str())
            .header("Accept", "text/event-stream")
            .header("Authorization", format!("Bearer {}", jwt))
            .json(&body)
            .send()
            .await?;

        // On auth failure, invalidate cache and retry once with a fresh JWT
        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            reset_jwt_cache().await;
            let jwt = bootstrap_jwt().await?;
            resp = client
                .post(CHAT_URL)
                .header("Content-Type", "application/json")
                .header("X-Mimo-Source", "mimocode-cli-free")
                .header("User-Agent", pick_user_agent())
                .header("x-session-affinity", SESSION_ID.as_str())
                .header("Accept", "text/event-stream")
                .header("Authorization", format!("Bearer {}", jwt))
                .json(&body)
                .send()
                .await?;
        }

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let stream = resp
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: Box::new(stream),
        })
    }

    async fn complete(
        &self,
        _conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        inject_system_marker(&mut body);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let jwt = bootstrap_jwt().await?;

        let client = build_client();
        let mut resp = client
            .post(CHAT_URL)
            .header("Content-Type", "application/json")
            .header("X-Mimo-Source", "mimocode-cli-free")
            .header("User-Agent", pick_user_agent())
            .header("x-session-affinity", SESSION_ID.as_str())
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {}", jwt))
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            reset_jwt_cache().await;
            let jwt = bootstrap_jwt().await?;
            resp = client
                .post(CHAT_URL)
                .header("Content-Type", "application/json")
                .header("X-Mimo-Source", "mimocode-cli-free")
                .header("User-Agent", pick_user_agent())
                .header("x-session-affinity", SESSION_ID.as_str())
                .header("Accept", "application/json")
                .header("Authorization", format!("Bearer {}", jwt))
                .json(&body)
                .send()
                .await?;
        }

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let bytes = resp.bytes().await?;
        Ok(UpstreamResponse::Json {
            status: StatusCode::OK,
            headers: HeaderMap::new(),
            body: bytes,
        })
    }
}
