//! Vertex AI executor.
//! Port of open-sse/executors/vertex.js. Serves both "vertex" (Gemini models via
//! regional/global Vertex endpoint) and "vertex-partner" (partner models — Llama,
//! Mistral, GLM, DeepSeek, Qwen — via the global OpenAI-compatible endpoint).
//!
//! Auth modes (resolved from connection.data.apiKey):
//! - Service Account JSON (type=service_account) → RS256 JWT assertion → Bearer token
//! - ADC JSON (type=authorized_user) → refresh_token grant → Bearer token
//! - Raw API key → `?key=` URL param
//!
//! The request body is forwarded unchanged (translation openai→gemini happens in the
//! translator layer, mirroring the Node pipeline where transformRequest is a no-op here).
//!
//! The provider id comes from conn.provider: "vertex" or "vertex-partner".

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct VertexExecutor;

const VERTEX_BASE: &str = "https://aiplatform.googleapis.com";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_TTL_BUFFER_MS: u64 = 5 * 60 * 1000;

/// Cached Vertex Bearer token keyed by service account email.
struct CachedToken {
    token: String,
    expires_at_ms: u64,
}

static VERTEX_TOKEN_CACHE: Lazy<Mutex<HashMap<String, CachedToken>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache of project ids resolved from raw API keys { apiKey → projectId }.
static PROJECT_ID_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse Google Service Account JSON from the apiKey string.
fn parse_vertex_sa_json(api_key: &str) -> Option<serde_json::Value> {
    let parsed: serde_json::Value = serde_json::from_str(api_key).ok()?;
    if parsed.get("type").and_then(|v| v.as_str()) == Some("service_account")
        && parsed.get("client_email").and_then(|v| v.as_str()).is_some()
        && parsed.get("private_key").and_then(|v| v.as_str()).is_some()
        && parsed.get("project_id").and_then(|v| v.as_str()).is_some()
    {
        Some(parsed)
    } else {
        None
    }
}

/// Parse Google ADC user credential JSON (from `gcloud auth application-default login`).
fn parse_vertex_adc_json(api_key: &str) -> Option<serde_json::Value> {
    let parsed: serde_json::Value = serde_json::from_str(api_key).ok()?;
    if parsed.get("type").and_then(|v| v.as_str()) == Some("authorized_user")
        && parsed.get("client_id").and_then(|v| v.as_str()).is_some()
        && parsed.get("client_secret").and_then(|v| v.as_str()).is_some()
        && parsed.get("refresh_token").and_then(|v| v.as_str()).is_some()
    {
        Some(parsed)
    } else {
        None
    }
}

/// Mint a Bearer token from Service Account JSON via RS256 JWT assertion (cached).
async fn refresh_vertex_token(sa_json: &serde_json::Value) -> anyhow::Result<Option<(String, u64)>> {
    let client_email = sa_json
        .get("client_email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("SA JSON missing client_email"))?
        .to_string();
    let private_key_raw = sa_json
        .get("private_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("SA JSON missing private_key"))?
        .to_string();
    // Handle double-escaped newlines (mirrors the Node replace(/\\n/g, "\n"))
    let private_key = private_key_raw.replace("\\n", "\n");

    // Check cache
    {
        let cache = VERTEX_TOKEN_CACHE.lock().await;
        if let Some(cached) = cache.get(&client_email) {
            if cached.expires_at_ms.saturating_sub(now_ms()) > TOKEN_TTL_BUFFER_MS {
                return Ok(Some((cached.token.clone(), cached.expires_at_ms)));
            }
        }
    }

    let now_secs = (now_ms() / 1000) as i64;
    let claims = serde_json::json!({
        "iss": client_email,
        "scope": CLOUD_PLATFORM_SCOPE,
        "aud": GOOGLE_TOKEN_URL,
        "iat": now_secs,
        "exp": now_secs + 3600,
    });

    let encoding_key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key.as_bytes())
        .map_err(|e| anyhow::anyhow!("Vertex: invalid SA private key: {}", e))?;
    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &encoding_key,
    )?;

    let client = build_client();
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={}",
            jwt
        ))
        .send()
        .await?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        anyhow::bail!("Vertex token mint failed: {}", err);
    }

    let tokens: serde_json::Value = resp.json().await?;
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Vertex token response missing access_token"))?
        .to_string();
    let expires_in = tokens.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    let expires_at = now_ms() + expires_in * 1000;

    VERTEX_TOKEN_CACHE.lock().await.insert(
        client_email,
        CachedToken {
            token: access_token.clone(),
            expires_at_ms: expires_at,
        },
    );

    Ok(Some((access_token, expires_at)))
}

/// Refresh a Bearer token via the Google OAuth2 refresh_token grant (ADC flow).
async fn refresh_google_token(
    refresh_token: &str,
    client_id: &str,
    client_secret: &str,
) -> anyhow::Result<Option<(String, u64)>> {
    let client = build_client();
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(format!(
            "grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
            urlencoding_form(refresh_token),
            urlencoding_form(client_id),
            urlencoding_form(client_secret),
        ))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Ok(None);
    }

    let tokens: serde_json::Value = resp.json().await?;
    let access_token = match tokens.get("access_token").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return Ok(None),
    };
    let expires_in = tokens.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    Ok(Some((access_token, now_ms() + expires_in * 1000)))
}

/// Minimal form-urlencode for the characters we handle (tokens/secrets are
/// typically URL-safe; escape the reserved set to be safe).
fn urlencoding_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Resolve GCP project ID from a raw Vertex API key by sending a dummy probe
/// request and parsing "projects/{id}" from the error message (cached).
async fn resolve_project_id(api_key: &str) -> Option<String> {
    {
        let cache = PROJECT_ID_CACHE.lock().await;
        if let Some(pid) = cache.get(api_key) {
            return Some(pid.clone());
        }
    }

    let client = build_client();
    let url = format!(
        "{}/v1/publishers/google/models/__probe__:generateContent?key={}",
        VERTEX_BASE, api_key
    );
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;

    let msg = json
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let project_id = extract_project_from_message(msg)?;

    PROJECT_ID_CACHE
        .lock()
        .await
        .insert(api_key.to_string(), project_id.clone());
    Some(project_id)
}

fn extract_project_from_message(msg: &str) -> Option<String> {
    // Match "projects/{id}/"
    let idx = msg.find("projects/")?;
    let rest = &msg[idx + "projects/".len()..];
    let end = rest.find('/')?;
    let id = &rest[..end];
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Get providerSpecificData (or provider_specific_data) from connection data.
fn get_provider_specific_data(data: &serde_json::Value) -> Option<&serde_json::Value> {
    data.get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"))
}

#[async_trait::async_trait]
impl ProviderExecutor for VertexExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, true).await
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, false).await
    }
}

impl VertexExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let provider = conn.provider.to_lowercase();
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Vertex connection missing API key"))?;

        let psd = get_provider_specific_data(&conn.data);
        let explicit_project = psd
            .and_then(|p| p.get("projectId").or_else(|| p.get("project_id")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let location = psd
            .and_then(|p| p.get("location"))
            .and_then(|v| v.as_str())
            .unwrap_or("us-central1")
            .to_string();

        let sa_json = parse_vertex_sa_json(&api_key);
        let adc_json = parse_vertex_adc_json(&api_key);

        // --- Mint / refresh Bearer token ---
        let mut access_token: Option<String> = conn
            .data
            .get("accessToken")
            .or_else(|| conn.data.get("access_token"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if let Some(ref sa) = sa_json {
            let result = refresh_vertex_token(sa).await?;
            let (token, _) = result
                .ok_or_else(|| anyhow::anyhow!("Vertex: failed to mint access token from Service Account JSON"))?;
            access_token = Some(token);
        } else if let Some(ref adc) = adc_json {
            let refresh_token = adc.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");
            let client_id = adc.get("client_id").and_then(|v| v.as_str()).unwrap_or("");
            let client_secret = adc.get("client_secret").and_then(|v| v.as_str()).unwrap_or("");
            let result = refresh_google_token(refresh_token, client_id, client_secret).await?;
            let (token, _) = result.ok_or_else(|| {
                anyhow::anyhow!("Vertex: failed to refresh access token from ADC JSON (authorized_user)")
            })?;
            access_token = Some(token);
        }

        // --- Resolve project id ---
        let mut project_id = sa_json
            .as_ref()
            .and_then(|sa| sa.get("project_id").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .or_else(|| {
                adc_json
                    .as_ref()
                    .and_then(|adc| adc.get("quota_project_id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
            })
            .or_else(|| explicit_project.clone());

        // vertex-partner with raw key: auto-resolve project_id if not provided
        if provider == "vertex-partner" && sa_json.is_none() && adc_json.is_none() && explicit_project.is_none()
        {
            let resolved = resolve_project_id(&api_key).await;
            match resolved {
                Some(pid) => project_id = Some(pid),
                None => {
                    return Ok(UpstreamResponse::Error {
                        status: StatusCode::BAD_REQUEST,
                        message: "Vertex: could not resolve project_id from API key. Please add it manually in provider settings.".to_string(),
                    });
                }
            }
        }

        // --- Build URL ---
        let uses_oauth = sa_json.is_some() || adc_json.is_some() || access_token.is_some();
        let url = if provider == "vertex-partner" {
            // Partner models: global OpenAI-compatible endpoint; project id required.
            let pid = project_id.ok_or_else(|| {
                anyhow::anyhow!(
                    "Vertex partner models require a project_id. Add it in providerSpecificData or use Service Account JSON."
                )
            })?;
            let base = format!(
                "{}/v1/projects/{}/locations/global/endpoints/openapi/chat/completions",
                VERTEX_BASE, pid
            );
            if uses_oauth {
                base
            } else {
                format!("{}?key={}", base, api_key)
            }
        } else {
            // Gemini on Vertex
            let action = if stream { "streamGenerateContent" } else { "generateContent" };
            let model_id = body
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or(model_default(&body))
                .to_string();

            if uses_oauth {
                let pid = project_id.ok_or_else(|| {
                    anyhow::anyhow!(
                        "Vertex OAuth/ADC requires a project_id. Add quota_project_id to your ADC JSON or set providerSpecificData.projectId."
                    )
                })?;
                let mut url = format!(
                    "{}/v1/projects/{}/locations/{}/publishers/google/models/{}:{}",
                    VERTEX_BASE, pid, location, model_id, action
                );
                if stream {
                    url += "?alt=sse";
                }
                url
            } else {
                // Raw API key: global publishers endpoint with ?key= param
                let mut url = format!(
                    "{}/v1/publishers/google/models/{}:{}",
                    VERTEX_BASE, model_id, action
                );
                if stream {
                    url += "?alt=sse";
                    url += &format!("&key={}", api_key);
                } else {
                    url += &format!("?key={}", api_key);
                }
                url
            }
        };

        // Body must not carry the model field for the Gemini-on-Vertex endpoint
        // (model lives in the URL path). Keep it for the partner OpenAI endpoint.
        let mut send_body = body.clone();
        if provider != "vertex-partner" {
            if let Some(obj) = send_body.as_object_mut() {
                obj.remove("model");
            }
        }

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json");

        if let Some(ref token) = access_token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        if stream {
            req = req.header("Accept", "text/event-stream");
        }

        let resp = req.json(&send_body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        if stream {
            let stream = resp
                .bytes_stream()
                .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: Box::new(stream),
            })
        } else {
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: bytes,
            })
        }
    }
}

fn model_default(_body: &serde_json::Value) -> &str {
    "gemini-2.0-flash"
}
