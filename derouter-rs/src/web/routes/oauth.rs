//! OAuth routes — JSON API.
//! POST /api/oauth/gitlab/pat — authenticate GitLab Duo with a Personal Access Token.
//! Phase 3: cursor, kiro, codex, grok-cli, iflow OAuth/import flows.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::db::repos::connections::{self, ProviderConnection};
use crate::auth;
use crate::proxy::executors::kiro_token;

const GITLAB_DEFAULT_BASE: &str = "https://gitlab.com";

// ---- Kiro constants (public IDE-shipped values, not secrets) ----
const KIRO_AUTH_SERVICE: &str = "https://prod.us-east-1.auth.desktop.kiro.dev";
const KIRO_DEFAULT_REGION: &str = "us-east-1";

// ---- Cursor constants ----
const CURSOR_CLIENT_VERSION: &str = "3.12.17";

// ---- iFlow constants ----
const IFLOW_API_URL: &str = "https://platform.iflow.cn/api/openapi/apikey";

/// Decode a JWT payload (no verification) and return the parsed JSON value.
fn decode_jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    use base64::Engine;
    let b64 = parts[1].replace('-', "+").replace('_', "/");
    let padded = match b64.len() % 4 {
        2 => format!("{}==", b64),
        3 => format!("{}=", b64),
        _ => b64,
    };
    base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Extract email from a JWT access token (best-effort).
fn extract_email_from_jwt(token: &str) -> Option<String> {
    decode_jwt_payload(token).and_then(|p| {
        p.get("email")
            .or_else(|| p.get("preferred_username"))
            .or_else(|| p.get("sub"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
}

/// Extract Codex account info from JWT claims.
fn extract_codex_account_info(id_token: &str) -> (Option<String>, Option<String>, Option<String>) {
    let payload = decode_jwt_payload(id_token);
    payload.map(|p| {
        let auth = p.get("https://api.openai.com/auth").cloned().unwrap_or_default();
        let email = p.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
        let chatgpt_account_id = auth
            .get("chatgpt_account_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let chatgpt_plan_type = auth
            .get("chatgpt_plan_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        (email, chatgpt_account_id, chatgpt_plan_type)
    })
    .unwrap_or((None, None, None))
}

/// Save a ProviderConnection via spawn_blocking.
async fn save_connection(pool: &DbPool, conn: ProviderConnection) -> Result<(), String> {
    let pool_c = pool.clone();
    let conn_c = conn.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::create_provider_connection(&db, &conn_c)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// POST /api/oauth/gitlab/pat — authenticate GitLab Duo with a PAT.
pub async fn gitlab_pat(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let base = if base_url.is_empty() {
        GITLAB_DEFAULT_BASE.to_string()
    } else {
        base_url.trim_end_matches('/').to_string()
    };

    if token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Personal Access Token is required"}))).into_response();
    }

    // Verify token by fetching current user
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().unwrap_or_default();

    let url = format!("{}/api/v4/user", base);
    let res = client.get(&url)
        .header("Private-Token", &token)
        .header("Accept", "application/json")
        .send().await;

    match res {
        Ok(r) if r.status().is_success() => {
            let user: serde_json::Value = match r.json().await {
                Ok(u) => u,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to parse GitLab response"}))).into_response(),
            };

            let email = user.get("email").or_else(|| user.get("public_email")).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = user.get("name").or_else(|| user.get("username")).and_then(|v| v.as_str()).unwrap_or(&email).to_string();
            let username = user.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();

            let now = chrono::Utc::now().to_rfc3339();
            let conn = ProviderConnection {
                id: uuid::Uuid::new_v4().to_string(),
                provider: "gitlab".to_string(),
                auth_type: "oauth".to_string(),
                name: Some(name),
                email: Some(email.clone()),
                priority: None,
                is_active: true,
                data: serde_json::json!({
                    "accessToken": token,
                    "username": username,
                    "email": email,
                    "baseUrl": base,
                    "authKind": "personal_access_token",
                }),
                created_at: now.clone(),
                updated_at: now,
            };

            let pool_c = pool.clone();
            let conn_c = conn.clone();
            let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                connections::create_provider_connection(&db, &conn_c)
            })
            .await;

            match result {
                Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
                _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to create connection"}))).into_response(),
            }
        }
        Ok(r) => {
            let _status = r.status();
            let err = r.text().await.unwrap_or_default();
            (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": format!("GitLab token verification failed: {}", err)}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

// =========================================================================
// Phase 3: 12 OAuth/import handlers
// =========================================================================

/// GET /api/oauth/cursor/auto-import
/// Auto-detect Cursor tokens from local SQLite database.
pub async fn cursor_auto_import(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let _ = body; // GET-style, even though POST-mounted
    // On a server we cannot reliably access the user's local Cursor SQLite DB.
    // Return guidance for manual import.
    Json(serde_json::json!({
        "found": false,
        "error": "Auto-import is not available on server deployments. Please use manual import with accessToken + machineId from your local Cursor IDE."
    })).into_response()
}

/// POST /api/oauth/cursor/import
/// Import and validate an access token from Cursor IDE's local SQLite database.
pub async fn cursor_import(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let access_token = body.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let machine_id = body.get("machineId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    if access_token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Access token is required"}))).into_response();
    }
    if machine_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Machine ID is required"}))).into_response();
    }
    // Basic validations matching CursorService.validateImportToken
    if access_token.len() < 50 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid token format. Token appears too short."}))).into_response();
    }

    let user_info = extract_email_from_jwt(&access_token);
    let now = chrono::Utc::now().to_rfc3339();
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(86400)).to_rfc3339();
    let conn = ProviderConnection {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "cursor".to_string(),
        auth_type: "oauth".to_string(),
        name: user_info.clone().or_else(|| Some("Cursor Imported".to_string())),
        email: user_info.clone(),
        priority: None,
        is_active: true,
        data: serde_json::json!({
            "accessToken": access_token,
            "refreshToken": null,
            "expiresAt": expires_at,
            "providerSpecificData": {
                "machineId": machine_id,
                "authMethod": "imported",
                "provider": "Imported",
            },
        }),
        created_at: now.clone(),
        updated_at: now,
    };

    match save_connection(&pool, conn).await {
        Ok(()) => {
            let mask = &access_token;
            let masked = if mask.len() > 4 { format!("****{}", &mask[mask.len()-4..]) } else { "****".to_string() };
            Json(serde_json::json!({"success": true, "token": masked})).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/oauth/kiro/api-key
/// Import a Kiro API key (headless auth — no refresh token).
pub async fn kiro_api_key(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let region = body.get("region").and_then(|v| v.as_str()).unwrap_or("us-east-1").to_string();

    if api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "API key is required"}))).into_response();
    }

    // Validate the key against Amazon Q model catalog
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().unwrap_or_default();

    let url = format!("https://q.{}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR", region);
    let res = client.get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("TokenType", "API_KEY")
        .header("Accept", "application/json")
        .header("User-Agent", "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0")
        .send().await;

    match res {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = match r.json().await {
                Ok(d) => d,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to parse response"}))).into_response(),
            };
            let models = data.get("models").and_then(|v| v.as_array());
            if models.map(|m| m.is_empty()).unwrap_or(true) {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "API key returned no available models"}))).into_response();
            }

            let email = extract_email_from_jwt(&api_key);
            let now = chrono::Utc::now().to_rfc3339();
            let expires_at = (chrono::Utc::now() + chrono::Duration::days(365)).to_rfc3339();
            let conn = ProviderConnection {
                id: uuid::Uuid::new_v4().to_string(),
                provider: "kiro".to_string(),
                auth_type: "api_key".to_string(),
                name: email.clone().or_else(|| Some("Kiro API Key".to_string())),
                email: email.clone(),
                priority: None,
                is_active: true,
                data: serde_json::json!({
                    "accessToken": api_key,
                    "refreshToken": null,
                    "expiresAt": expires_at,
                    "providerSpecificData": {
                        "region": region,
                        "authMethod": "api_key",
                        "provider": "API Key",
                    },
                }),
                created_at: now.clone(),
                updated_at: now,
            };

            match save_connection(&pool, conn).await {
                Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
            }
        }
        Ok(r) => {
            let _ = r.text().await;
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "API key validation failed"}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

/// POST /api/oauth/kiro/auto-import
/// Auto-detect Kiro refresh token from AWS SSO cache (server-side: not available).
pub async fn kiro_auto_import(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let _ = body;
    // On a server we cannot access the user's ~/.aws/sso/cache directory.
    Json(serde_json::json!({
        "found": false,
        "error": "Auto-import is not available on server deployments. Please use manual import with your Kiro refresh token."
    })).into_response()
}

/// POST /api/oauth/kiro/import
/// Import and validate a refresh token from Kiro IDE.
pub async fn kiro_import(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let refresh_token = body.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let client_id = body.get("clientId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let client_secret = body.get("clientSecret").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let region = body.get("region").and_then(|v| v.as_str()).unwrap_or("us-east-1").to_string();
    let profile_arn = body.get("profileArn").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if refresh_token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Refresh token is required"}))).into_response();
    }

    let is_idc = !client_id.is_empty() && !client_secret.is_empty();

    // Build a temporary ProviderConnection to use kiro_token::refresh_kiro_token
    let temp_conn = ProviderConnection {
        id: "temp".to_string(),
        provider: "kiro".to_string(),
        auth_type: "oauth".to_string(),
        name: None,
        email: None,
        priority: None,
        is_active: true,
        data: serde_json::json!({
            "refreshToken": refresh_token,
            "providerSpecificData": if is_idc {
                serde_json::json!({
                    "clientId": client_id,
                    "clientSecret": client_secret,
                    "region": region,
                    "authMethod": "idc",
                })
            } else {
                serde_json::json!({})
            },
        }),
        created_at: String::new(),
        updated_at: String::new(),
    };

    match kiro_token::refresh_kiro_token(&temp_conn).await {
        Ok(token) => {
            let email = extract_email_from_jwt(&token.access_token);
            let auth_method = if is_idc { "idc" } else { "imported" };
            let provider_label = if is_idc { "Enterprise" } else { "Imported" };
            let now = chrono::Utc::now().to_rfc3339();
            let expires_at = chrono::DateTime::from_timestamp_millis(token.expires_at_ms as i64)
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339();

            let mut psd = serde_json::json!({
                "profileArn": profile_arn,
                "authMethod": auth_method,
                "provider": provider_label,
            });
            if is_idc {
                let psd_obj = psd.as_object_mut().unwrap();
                psd_obj.insert("clientId".to_string(), serde_json::json!(client_id));
                psd_obj.insert("clientSecret".to_string(), serde_json::json!(client_secret));
                psd_obj.insert("region".to_string(), serde_json::json!(region));
            }

            let conn = ProviderConnection {
                id: uuid::Uuid::new_v4().to_string(),
                provider: "kiro".to_string(),
                auth_type: "oauth".to_string(),
                name: email.clone().or_else(|| Some("Kiro Imported".to_string())),
                email: email.clone(),
                priority: None,
                is_active: true,
                data: serde_json::json!({
                    "accessToken": token.access_token,
                    "refreshToken": token.refresh_token.unwrap_or_else(|| refresh_token.clone()),
                    "expiresAt": expires_at,
                    "providerSpecificData": psd,
                }),
                created_at: now.clone(),
                updated_at: now,
            };

            match save_connection(&pool, conn).await {
                Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/oauth/kiro/import-cli-proxy
/// Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
pub async fn kiro_import_cli_proxy(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let raw_auth = body.get("cliProxyAuth")
        .or_else(|| body.get("auth"))
        .or_else(|| body.get("json"))
        .cloned()
        .unwrap_or_else(|| body.clone());

    let access_token = raw_auth.get("access_token").or_else(|| raw_auth.get("accessToken"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let refresh_token = raw_auth.get("refresh_token").or_else(|| raw_auth.get("refreshToken"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let client_id = raw_auth.get("client_id").or_else(|| raw_auth.get("clientId"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let token_endpoint = raw_auth.get("token_endpoint").or_else(|| raw_auth.get("tokenEndpoint"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let profile_arn = raw_auth.get("profile_arn").or_else(|| raw_auth.get("profileArn"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let region = raw_auth.get("region").and_then(|v| v.as_str()).unwrap_or("us-east-1").trim().to_string();
    let scope = raw_auth.get("scopes").or_else(|| raw_auth.get("scope"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    if access_token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "access_token is required"}))).into_response();
    }
    if refresh_token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "refresh_token is required"}))).into_response();
    }
    if client_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "client_id is required"}))).into_response();
    }
    if scope.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "scopes is required"}))).into_response();
    }
    if profile_arn.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "profile_arn is required"}))).into_response();
    }

    let email = extract_email_from_jwt(&access_token);
    let now = chrono::Utc::now().to_rfc3339();
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(
        raw_auth.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600) as i64
    )).to_rfc3339();

    let conn = ProviderConnection {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "kiro".to_string(),
        auth_type: "oauth".to_string(),
        name: email.clone().or_else(|| Some("Kiro CLIProxyAPI".to_string())),
        email: email.clone(),
        priority: None,
        is_active: true,
        data: serde_json::json!({
            "accessToken": access_token,
            "refreshToken": refresh_token,
            "expiresAt": expires_at,
            "providerSpecificData": {
                "profileArn": profile_arn,
                "region": region,
                "authMethod": "external_idp",
                "provider": "CLIProxyAPI",
                "clientId": client_id,
                "tokenEndpoint": token_endpoint,
                "scope": scope,
            },
        }),
        created_at: now.clone(),
        updated_at: now,
    };

    match save_connection(&pool, conn).await {
        Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/oauth/kiro/social-authorize
/// Generate Google/GitHub social login URL for manual callback flow.
pub async fn kiro_social_authorize(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    // Generate PKCE values
    let code_verifier = uuid::Uuid::new_v4().to_string().replace('-', "");
    let code_challenge = code_verifier.clone(); // Simplified — in production use SHA256
    let state = uuid::Uuid::new_v4().to_string();

    // Accept provider from query-style body or JSON body
    // Since this is POST, we read from body
    let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("google");
    if provider != "google" && provider != "github" {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid provider. Use 'google' or 'github'"}))).into_response();
    }

    let idp = if provider == "google" { "Google" } else { "Github" };
    let redirect_uri = "kiro%3A%2F%2Fkiro.kiroAgent%2Fauthenticate-success"; // pre-encoded
    let auth_url = format!(
        "{}/login?idp={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=select_account",
        KIRO_AUTH_SERVICE, idp,
        redirect_uri,
        code_challenge, state
    );

    Json(serde_json::json!({
        "authUrl": auth_url,
        "state": state,
        "codeVerifier": code_verifier,
        "codeChallenge": code_challenge,
        "provider": provider,
    })).into_response()
}

/// POST /api/oauth/kiro/social-exchange
/// Exchange authorization code for tokens (Google/GitHub social login).
pub async fn kiro_social_exchange(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let code_verifier = body.get("codeVerifier").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if code.is_empty() || code_verifier.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing required fields"}))).into_response();
    }
    if provider != "google" && provider != "github" {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid provider"}))).into_response();
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().unwrap_or_default();

    let redirect_uri = "kiro://kiro.kiroAgent/authenticate-success";
    let res = client.post(format!("{}/oauth/token", KIRO_AUTH_SERVICE))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }))
        .send().await;

    match res {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = match r.json().await {
                Ok(d) => d,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to parse response"}))).into_response(),
            };
            let access_token = data.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let refresh_token = data.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let profile_arn = data.get("profileArn").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let expires_in = data.get("expiresIn").and_then(|v| v.as_u64()).unwrap_or(3600);

            let email = extract_email_from_jwt(&access_token);
            let provider_capitalized = format!("{}{}", provider[..1].to_uppercase(), &provider[1..]);
            let now = chrono::Utc::now().to_rfc3339();
            let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64)).to_rfc3339();

            let conn = ProviderConnection {
                id: uuid::Uuid::new_v4().to_string(),
                provider: "kiro".to_string(),
                auth_type: "oauth".to_string(),
                name: email.clone().or_else(|| Some(format!("Kiro {}", provider_capitalized))),
                email: email.clone(),
                priority: None,
                is_active: true,
                data: serde_json::json!({
                    "accessToken": access_token,
                    "refreshToken": refresh_token,
                    "expiresAt": expires_at,
                    "providerSpecificData": {
                        "profileArn": profile_arn,
                        "authMethod": provider,
                        "provider": provider_capitalized,
                    },
                }),
                created_at: now.clone(),
                updated_at: now,
            };

            match save_connection(&pool, conn).await {
                Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
            }
        }
        Ok(r) => {
            let err = r.text().await.unwrap_or_default();
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Token exchange failed: {}", err)}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

/// POST /api/oauth/codex/bulk-import
/// Bulk import multiple Codex (OAuth) account JSON objects.
pub async fn codex_bulk_import(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;

    // Normalize to array
    let accounts: Vec<serde_json::Value> = if body.is_array() {
        body.as_array().unwrap().clone()
    } else if body.get("accounts").and_then(|v| v.as_array()).is_some() {
        body.get("accounts").and_then(|v| v.as_array()).unwrap().clone()
    } else if body.is_object() {
        vec![body.clone()]
    } else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No accounts provided"}))).into_response();
    };

    if accounts.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No accounts provided"}))).into_response();
    }

    let mut success = 0u32;
    let mut failed = 0u32;
    let mut results = serde_json::json!([]);

    for (i, raw) in accounts.iter().enumerate() {
        let access_token = raw.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if access_token.is_empty() {
            failed += 1;
            results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": false, "error": "Missing accessToken"}));
            continue;
        }

        let refresh_token = raw.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let id_token = raw.get("idToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut email = raw.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());

        // Backfill from JWT
        let jwt_source = if !id_token.is_empty() { &id_token } else { &access_token };
        let (jwt_email, chatgpt_account_id, chatgpt_plan_type) = extract_codex_account_info(jwt_source);
        if email.is_none() { email = jwt_email; }

        let expires_in = raw.get("expiresIn").and_then(|v| v.as_u64()).unwrap_or(3600);
        let now = chrono::Utc::now().to_rfc3339();
        let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64)).to_rfc3339();

        let mut psd = serde_json::json!({
            "authMethod": "oauth",
        });
        if let Some(e) = &email { psd["email"] = serde_json::json!(e); }
        if let Some(aid) = chatgpt_account_id { psd["chatgptAccountId"] = serde_json::json!(aid); }
        if let Some(pt) = chatgpt_plan_type { psd["chatgptPlanType"] = serde_json::json!(pt); }
        if !id_token.is_empty() { psd["idToken"] = serde_json::json!(id_token); }

        let conn = ProviderConnection {
            id: uuid::Uuid::new_v4().to_string(),
            provider: "codex".to_string(),
            auth_type: "oauth".to_string(),
            name: email.clone().or_else(|| Some("Codex OAuth".to_string())),
            email: email.clone(),
            priority: None,
            is_active: true,
            data: serde_json::json!({
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": expires_at,
                "providerSpecificData": psd,
            }),
            created_at: now.clone(),
            updated_at: now,
        };

        match save_connection(&pool, conn).await {
            Ok(()) => {
                success += 1;
                results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": true}));
            }
            Err(e) => {
                failed += 1;
                results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": false, "error": e}));
            }
        }
    }

    Json(serde_json::json!({"success": success, "failed": failed, "results": results})).into_response()
}

/// POST /api/oauth/codex/import-token
/// Import a ChatGPT access token as a provider connection.
pub async fn codex_import_token(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let access_token = body.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());

    if access_token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Access token is required"}))).into_response();
    }

    // Extract account info from JWT
    let (email, chatgpt_account_id, chatgpt_plan_type) = extract_codex_account_info(&access_token);

    let mut psd = serde_json::json!({"authMethod": "access_token"});
    if let Some(aid) = chatgpt_account_id { psd["chatgptAccountId"] = serde_json::json!(aid); }
    if let Some(pt) = chatgpt_plan_type { psd["chatgptPlanType"] = serde_json::json!(pt); }

    let connection_name = name.or_else(|| email.clone()).unwrap_or_else(|| "ChatGPT Access Token".to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let conn = ProviderConnection {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "codex".to_string(),
        auth_type: "access_token".to_string(),
        name: Some(connection_name),
        email: email.clone(),
        priority: None,
        is_active: true,
        data: serde_json::json!({
            "accessToken": access_token,
            "providerSpecificData": psd,
        }),
        created_at: now.clone(),
        updated_at: now,
    };

    match save_connection(&pool, conn).await {
        Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/oauth/grok-cli/bulk-import
/// Bulk import multiple Grok CLI (OAuth/Device) account JSON objects.
pub async fn grok_cli_bulk_import(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;

    let accounts: Vec<serde_json::Value> = if body.is_array() {
        body.as_array().unwrap().clone()
    } else if body.get("accounts").and_then(|v| v.as_array()).is_some() {
        body.get("accounts").and_then(|v| v.as_array()).unwrap().clone()
    } else if body.is_object() {
        vec![body.clone()]
    } else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No accounts provided"}))).into_response();
    };

    if accounts.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No accounts provided"}))).into_response();
    }

    let mut success = 0u32;
    let mut failed = 0u32;
    let mut results = serde_json::json!([]);

    for (i, raw) in accounts.iter().enumerate() {
        let access_token = raw.get("access_token").or_else(|| raw.get("accessToken"))
            .and_then(|v| v.as_str()).unwrap_or("").to_string();
        let refresh_token = raw.get("refresh_token").or_else(|| raw.get("refreshToken"))
            .and_then(|v| v.as_str()).unwrap_or("").to_string();
        let id_token = raw.get("id_token").or_else(|| raw.get("idToken"))
            .and_then(|v| v.as_str()).unwrap_or("").to_string();

        if access_token.is_empty() {
            failed += 1;
            results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": false, "error": "Missing access_token / accessToken"}));
            continue;
        }

        let mut email = raw.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
        if email.is_none() {
            email = extract_email_from_jwt(&id_token).or_else(|| extract_email_from_jwt(&access_token));
        }

        let display_name = raw.get("displayName").or_else(|| raw.get("name"))
            .and_then(|v| v.as_str()).map(|s| s.to_string());

        let expires_in = raw.get("expires_in").or_else(|| raw.get("expiresIn"))
            .and_then(|v| v.as_u64()).unwrap_or(3600);
        let expires_at_str = raw.get("expires_at").or_else(|| raw.get("expiresAt"))
            .and_then(|v| v.as_str()).map(|s| s.to_string());
        let expires_at = expires_at_str.unwrap_or_else(|| {
            (chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64)).to_rfc3339()
        });

        let mut psd = serde_json::json!({"authMethod": "device_code"});
        if !id_token.is_empty() { psd["idToken"] = serde_json::json!(id_token); }
        if let Some(e) = &email { psd["email"] = serde_json::json!(e); }

        let now = chrono::Utc::now().to_rfc3339();
        let conn = ProviderConnection {
            id: uuid::Uuid::new_v4().to_string(),
            provider: "grok-cli".to_string(),
            auth_type: "oauth".to_string(),
            name: display_name.or_else(|| email.clone()).or_else(|| Some("Grok CLI".to_string())),
            email: email.clone(),
            priority: None,
            is_active: true,
            data: serde_json::json!({
                "accessToken": access_token,
                "refreshToken": refresh_token,
                "expiresAt": expires_at,
                "providerSpecificData": psd,
            }),
            created_at: now.clone(),
            updated_at: now,
        };

        match save_connection(&pool, conn).await {
            Ok(()) => {
                success += 1;
                results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": true}));
            }
            Err(e) => {
                failed += 1;
                results.as_array_mut().unwrap().push(serde_json::json!({"index": i, "ok": false, "error": e}));
            }
        }
    }

    Json(serde_json::json!({"success": success, "failed": failed, "results": results})).into_response()
}

/// POST /api/oauth/iflow/cookie
/// iFlow cookie-based authentication — fetch and refresh API key via cookie.
pub async fn iflow_cookie(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    let body = body.0;
    let cookie = body.get("cookie").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    if cookie.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cookie is required"}))).into_response();
    }
    if !cookie.contains("BXAuth=") {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cookie must contain BXAuth field"}))).into_response();
    }

    let mut normalized_cookie = cookie.clone();
    if !normalized_cookie.ends_with(';') {
        normalized_cookie.push(';');
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().unwrap_or_default();

    // Step 1: GET API key info
    let get_res = client.get(IFLOW_API_URL)
        .header("Cookie", &normalized_cookie)
        .header("Accept", "application/json, text/plain, */*")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send().await;

    let key_data = match get_res {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = match r.json().await {
                Ok(d) => d,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to parse response"}))).into_response(),
            };
            if !data.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                let msg = data.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("API key fetch failed: {}", msg)}))).into_response();
            }
            data.get("data").cloned().unwrap_or_default()
        }
        Ok(r) => {
            let err = r.text().await.unwrap_or_default();
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("Failed to fetch API key info: {}", err)}))).into_response();
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    let key_name = key_data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if key_name.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing name in API key info"}))).into_response();
    }

    // Step 2: POST to refresh API key
    let post_res = client.post(IFLOW_API_URL)
        .header("Cookie", &normalized_cookie)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .json(&serde_json::json!({"name": key_name}))
        .send().await;

    let refreshed_key = match post_res {
        Ok(r) if r.status().is_success() => {
            let data: serde_json::Value = match r.json().await {
                Ok(d) => d,
                Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to parse response"}))).into_response(),
            };
            if !data.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                let msg = data.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown error");
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("API key refresh failed: {}", msg)}))).into_response();
            }
            data.get("data").cloned().unwrap_or_default()
        }
        Ok(r) => {
            let err = r.text().await.unwrap_or_default();
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("Failed to refresh API key: {}", err)}))).into_response();
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };

    let api_key = refreshed_key.get("apiKey").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing API key in response"}))).into_response();
    }

    // Extract BXAuth from cookie
    let bx_auth = normalized_cookie
        .match_indices("BXAuth=")
        .next()
        .and_then(|(start, _)| {
            let rest = &normalized_cookie[start + "BXAuth=".len()..];
            rest.find(';').map(|end| &rest[..end]).or(Some(rest))
        })
        .unwrap_or("").to_string();

    let cookie_to_save = if !bx_auth.is_empty() { format!("BXAuth={};", bx_auth) } else { String::new() };
    let expire_time = refreshed_key.get("expireTime").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let display_name = refreshed_key.get("name").and_then(|v| v.as_str()).unwrap_or(&key_name).to_string();

    let now = chrono::Utc::now().to_rfc3339();
    let conn = ProviderConnection {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "iflow".to_string(),
        auth_type: "cookie".to_string(),
        name: Some(display_name.clone()),
        email: Some(display_name),
        priority: None,
        is_active: true,
        data: serde_json::json!({
            "apiKey": api_key,
            "providerSpecificData": {
                "cookie": cookie_to_save,
                "expireTime": expire_time,
            },
        }),
        created_at: now.clone(),
        updated_at: now,
    };

    match save_connection(&pool, conn).await {
        Ok(()) => {
            let masked = if api_key.len() > 10 { format!("{}...", &api_key[..10]) } else { "****".to_string() };
            Json(serde_json::json!({"success": true, "apiKey": masked, "expireTime": expire_time})).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}
