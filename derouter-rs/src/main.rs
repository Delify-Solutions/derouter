//! derouter — Rust rewrite of the AI proxy-fallback router.
//! Single binary: Axum + rusqlite + tower-http (CORS, Trace).
//! Phase 1: JSON API routes under /api/*, proxy routes under /v1/*.
//! Phase 2: Extended admin routes (proxy-pools, provider-nodes, models, system-ops, usage sub-routes).

mod auth;
mod db;
mod proxy;
mod providers;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use axum::http::{header, HeaderValue, Method};
use axum::routing::{any, get, post, put, delete};
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

/// App start time for uptime calculation.
static APP_START: once_cell::sync::Lazy<Instant> = once_cell::sync::Lazy::new(Instant::now);

/// Application state shared with handlers.
/// Contains the DB pool and a shutdown signal channel.
#[derive(Clone)]
pub struct AppState {
    pub pool: db::DbPool,
    pub shutdown_tx: Option<Arc<tokio::sync::watch::Sender<bool>>>,
}

impl AppState {
    /// Get the DB pool (for routes that only need the pool, not the full state).
    pub fn pool(&self) -> &db::DbPool {
        &self.pool
    }
}

/// Allow extracting DbPool from AppState (for Phase 1 routes that use `State(pool)`).
impl axum::extract::FromRef<AppState> for db::DbPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Resolve DB path: ${DATA_DIR}/db/data.sqlite — matches Node's dataDir.js
    let data_dir = std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(".derouter")
        });
    let db_path = data_dir.join("db").join("data.sqlite");

    tracing::info!("derouter starting — DATA_DIR: {}, db: {}", data_dir.display(), db_path.display());

    // Init r2d2 pool
    let pool = db::init_pool(&db_path)
        .context("Failed to init database pool")?;

    // Run migrations
    db::run_migrations(&pool)
        .context("Failed to run migrations")?;

    tracing::info!("Migrations complete");

    // Shutdown channel
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

    // Build app state
    let state = AppState {
        pool: pool.clone(),
        shutdown_tx: Some(Arc::new(shutdown_tx)),
    };

    // Build router
    let app = build_router(state);

    // Start background flush task for request details
    db::repos::request_details::start_flush_task(pool.clone());

    // Listen on port 20128 (distinct from Node's 20127)
    let port: u16 = std::env::var("DEROUTER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(20128);

    // Bind host: default 0.0.0.0 (all interfaces) for Docker compatibility.
    let host = std::env::var("HOST")
        .unwrap_or_else(|_| "0.0.0.0".to_string());

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("invalid bind address");
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Serve with graceful shutdown
    let serve = axum::serve(listener, app);

    tokio::select! {
        result = serve => {
            if let Err(e) = result {
                tracing::error!("Server error: {}", e);
            }
        }
        _ = shutdown_rx.changed() => {
            tracing::info!("Shutdown signal received, draining connections...");
            // Give in-flight requests a short grace period
        }
    }

    tracing::info!("Server stopped.");
    Ok(())
}

fn build_router(state: AppState) -> axum::Router {
    // CORS layer: allow credentials, specific origin from CORS_ORIGIN env.
    let cors = build_cors_layer();

    axum::Router::new()
        // ===== Proxy routes (kept from Phase 0) =====
        .route("/v1/chat/completions", post(web::routes::proxy::handle_chat_completions))
        .route("/v1/completions", post(web::routes::proxy::handle_completions))
        .route("/v1/models", get(web::routes::proxy::handle_models))
        .route("/v1/embeddings", post(web::routes::proxy::handle_embeddings))
        .route("/v1/images/generations", post(web::routes::proxy::handle_images))
        .route("/v1/audio/speech", post(web::routes::proxy::handle_audio_speech))
        .route("/v1/audio/transcriptions", post(web::routes::proxy::handle_audio_transcriptions))
        .route("/v1/videos/generations", post(web::routes::proxy::handle_video_generations))
        .route("/v1/responses", post(web::routes::proxy::handle_responses))
        .route("/v1/responses/compact", post(web::routes::proxy::handle_responses))
        .route("/v1/search", post(web::routes::proxy::handle_search))
        .route("/v1/messages", post(web::routes::proxy::handle_messages))
        .route("/v1/messages/count_tokens", post(web::routes::proxy::handle_messages_count_tokens))

        // ===== Auth routes (JSON API) =====
        .route("/api/auth/login", post(web::routes::auth::login))
        .route("/api/auth/status", get(web::routes::auth::status))
        .route("/api/auth/logout", post(web::routes::auth::logout))
        .route("/api/auth/reset-password", post(web::routes::auth::reset_password))

        // ===== Provider routes (JSON API) =====
        .route("/api/providers", get(web::routes::providers::list).post(web::routes::providers::create))
        .route("/api/providers/{id}", put(web::routes::providers::update).delete(web::routes::providers::delete))
        .route("/api/providers/{id}/models", get(web::routes::providers::get_models))
        .route("/api/providers/{id}/test", post(web::routes::providers::test_connection))
        .route("/api/providers/{id}/test-models", post(web::routes::providers::test_models))
        .route("/api/providers/client", get(web::routes::providers::client))
        .route("/api/providers/kilo/free-models", get(web::routes::providers::kilo_free_models))
        .route("/api/providers/suggested-models", get(web::routes::providers::suggested_models))
        .route("/api/providers/test-batch", post(web::routes::providers::test_batch))
        .route("/api/providers/validate", post(web::routes::providers::validate))

        // ===== Combo routes (JSON API) =====
        .route("/api/combos", get(web::routes::combos::list).post(web::routes::combos::create))
        .route("/api/combos/{name}/test", post(web::routes::combos::test))
        .route("/api/combos/{id}", put(web::routes::combos::update).delete(web::routes::combos::delete))

        // ===== Key routes (JSON API) =====
        .route("/api/keys", get(web::routes::keys::list).post(web::routes::keys::create))
        .route("/api/keys/{id}", put(web::routes::keys::update).delete(web::routes::keys::delete))

        // ===== Group routes (JSON API) =====
        .route("/api/groups", get(web::routes::groups::list).post(web::routes::groups::create))
        .route("/api/groups/{id}", put(web::routes::groups::update).delete(web::routes::groups::delete))

        // ===== Pricing routes (JSON API) =====
        .route("/api/pricing", get(web::routes::pricing::list).patch(web::routes::pricing::update).delete(web::routes::pricing::delete))

        // ===== Settings routes (JSON API) =====
        .route("/api/settings", get(web::routes::settings::list).patch(web::routes::settings::update))
        .route("/api/settings/database", get(web::routes::settings::database_export).post(web::routes::settings::database_import))
        .route("/api/settings/proxy-test", post(web::routes::settings::proxy_test))
        .route("/api/settings/require-login", get(web::routes::settings::require_login))

        // ===== Usage routes (JSON API, admin) =====
        .route("/api/usage/stats", get(web::routes::usage::stats))
        .route("/api/usage/request-details", get(web::routes::usage::request_details))
        .route("/api/usage/request-logs", get(web::routes::usage::request_logs))
        .route("/api/usage/keys", get(web::routes::usage::keys_table))
        .route("/api/usage/groups", get(web::routes::usage::groups_list))
        .route("/api/usage/stream", get(web::routes::usage::stream))
        .route("/api/usage/chart", get(web::routes::usage::chart))
        .route("/api/usage/history", get(web::routes::usage::history))
        .route("/api/usage/key-summary", get(web::routes::usage::key_summary))
        .route("/api/usage/logs", get(web::routes::usage::logs))
        .route("/api/usage/providers", get(web::routes::usage::providers))
        .route("/api/usage/{connectionId}", get(web::routes::usage::connection_usage))
        .route("/api/usage/{connectionId}/codex-reset-credits", post(web::routes::usage::codex_reset_credits))

        // ===== Public usage routes (JSON API, no auth) =====
        .route("/api/usage/key", get(web::routes::public_usage::key_usage_json))
        .route("/api/usage/key/history", delete(web::routes::public_usage::clear_history_json))

        // ===== Proxy pool routes (JSON API) =====
        .route("/api/proxy-pools", get(web::routes::proxy_pools::list).post(web::routes::proxy_pools::create))
        .route("/api/proxy-pools/{id}", put(web::routes::proxy_pools::update).delete(web::routes::proxy_pools::delete))
        .route("/api/proxy-pools/{id}/test", post(web::routes::proxy_pools::test))
        .route("/api/proxy-pools/cloudflare-deploy", post(web::routes::proxy_pools::cloudflare_deploy))
        .route("/api/proxy-pools/deno-deploy", post(web::routes::proxy_pools::deno_deploy))
        .route("/api/proxy-pools/vercel-deploy", post(web::routes::proxy_pools::vercel_deploy))

        // ===== Provider node routes (JSON API) =====
        .route("/api/provider-nodes", get(web::routes::provider_nodes::list).post(web::routes::provider_nodes::create))
        .route("/api/provider-nodes/{id}", put(web::routes::provider_nodes::update).delete(web::routes::provider_nodes::delete))
        .route("/api/provider-nodes/validate", post(web::routes::provider_nodes::validate))

        // ===== Models routes (JSON API) =====
        .route("/api/models", get(web::routes::models::list))
        .route("/api/models/alias", get(web::routes::models::get_aliases).post(web::routes::models::set_alias))
        .route("/api/models/availability", get(web::routes::models::availability))
        .route("/api/models/catalog-sync", post(web::routes::models::catalog_sync))
        .route("/api/models/custom", get(web::routes::models::list_custom).post(web::routes::models::add_custom))
        .route("/api/models/disabled", get(web::routes::models::list_disabled).post(web::routes::models::disable_models))
        .route("/api/models/test", post(web::routes::models::test_model))

        // ===== System operations routes =====
        .route("/api/version", get(web::routes::version::version))
        .route("/api/version/shutdown", post(web::routes::version::shutdown))
        .route("/api/version/update", post(web::routes::version::update))
        .route("/api/shutdown", post(web::routes::version::shutdown_alias))
        .route("/api/locale", get(web::routes::locale::locale).post(web::routes::locale::set_locale))
        .route("/api/init", get(web::routes::init::init))
        .route("/api/tags", get(web::routes::tags::tags))

        // ===== Health route (PUBLIC — no auth) =====
        .route("/api/health", get(web::routes::health::health))

        // ===== OAuth routes (JSON API) =====
        .route("/api/oauth/gitlab/pat", post(web::routes::oauth::gitlab_pat))
        .route("/api/oauth/cursor/auto-import", post(web::routes::oauth::cursor_auto_import))
        .route("/api/oauth/cursor/import", post(web::routes::oauth::cursor_import))
        .route("/api/oauth/kiro/api-key", post(web::routes::oauth::kiro_api_key))
        .route("/api/oauth/kiro/auto-import", post(web::routes::oauth::kiro_auto_import))
        .route("/api/oauth/kiro/import", post(web::routes::oauth::kiro_import))
        .route("/api/oauth/kiro/import-cli-proxy", post(web::routes::oauth::kiro_import_cli_proxy))
        .route("/api/oauth/kiro/social-authorize", post(web::routes::oauth::kiro_social_authorize))
        .route("/api/oauth/kiro/social-exchange", post(web::routes::oauth::kiro_social_exchange))
        .route("/api/oauth/codex/bulk-import", post(web::routes::oauth::codex_bulk_import))
        .route("/api/oauth/codex/import-token", post(web::routes::oauth::codex_import_token))
        .route("/api/oauth/grok-cli/bulk-import", post(web::routes::oauth::grok_cli_bulk_import))
        .route("/api/oauth/iflow/cookie", post(web::routes::oauth::iflow_cookie))

        // ===== MCP routes (JSON API + SSE) =====
        .route("/api/mcp/{plugin}/sse", get(web::routes::mcp::sse))
        .route("/api/mcp/{plugin}/message", post(web::routes::mcp::message))

        // ===== Media providers routes (JSON API) =====
        .route("/api/media-providers/tts/voices", get(web::routes::media_providers::voices))
        .route("/api/media-providers/tts/{provider}/voices", get(web::routes::media_providers::provider_voices))

        // ===== Tunnel routes (JSON API + SSE) =====
        .route("/api/tunnel/status", get(web::routes::tunnel::status))
        .route("/api/tunnel/enable", post(web::routes::tunnel::enable))
        .route("/api/tunnel/disable", post(web::routes::tunnel::disable))
        .route("/api/tunnel/tailscale-check", get(web::routes::tunnel::tailscale_check))
        .route("/api/tunnel/tailscale-enable", post(web::routes::tunnel::tailscale_enable))
        .route("/api/tunnel/tailscale-disable", post(web::routes::tunnel::tailscale_disable))
        .route("/api/tunnel/tailscale-install", post(web::routes::tunnel::tailscale_install))

        // ===== PXPIPE routes (JSON API) =====
        .route("/api/pxpipe/status", get(web::routes::pxpipe::status))
        .route("/api/pxpipe/start", post(web::routes::pxpipe::start))
        .route("/api/pxpipe/stop", post(web::routes::pxpipe::stop))
        .route("/api/pxpipe/restart", post(web::routes::pxpipe::restart))
        .route("/api/pxpipe/logs", get(web::routes::pxpipe::logs))
        .route("/api/pxpipe/health", get(web::routes::pxpipe::health_get).post(web::routes::pxpipe::health))
        .route("/api/pxpipe/stats", get(web::routes::pxpipe::stats))
        .route("/api/pxpipe/install", post(web::routes::pxpipe::install))

        // ===== Headroom routes (JSON API) =====
        .route("/api/headroom/status", get(web::routes::headroom::status))
        .route("/api/headroom/start", post(web::routes::headroom::start))
        .route("/api/headroom/stop", post(web::routes::headroom::stop))
        .route("/api/headroom/restart", post(web::routes::headroom::restart))
        .route("/api/headroom/extras", get(web::routes::headroom::extras))
        .route("/api/headroom/proxy/{*path}", any(web::routes::headroom::proxy))

        // ===== Translator routes (JSON API + SSE) =====
        .route("/api/translator/load", get(web::routes::translator::load))
        .route("/api/translator/save", post(web::routes::translator::save))
        .route("/api/translator/send", post(web::routes::translator::send))
        .route("/api/translator/translate", post(web::routes::translator::translate))
        .route("/api/translator/console-logs", get(web::routes::translator::console_logs_get).delete(web::routes::translator::console_logs_delete))
        .route("/api/translator/console-logs/stream", get(web::routes::translator::console_logs_stream))

        // ===== CLI tools routes (JSON API) =====
        .route("/api/cli-tools/all-statuses", get(web::routes::cli_tools::all_statuses))
        .route("/api/cli-tools/{tool}", get(web::routes::cli_tools::get_tool).post(web::routes::cli_tools::set_tool).delete(web::routes::cli_tools::delete_tool).patch(web::routes::cli_tools::patch_tool))
        .route("/api/cli-tools/antigravity-mitm", get(web::routes::cli_tools::antigravity::get).post(web::routes::cli_tools::antigravity::post).delete(web::routes::cli_tools::antigravity::delete).patch(web::routes::cli_tools::antigravity::patch))
        .route("/api/cli-tools/antigravity-mitm/alias", get(web::routes::cli_tools::antigravity::get_alias).put(web::routes::cli_tools::antigravity::put_alias))
        .route("/api/cli-tools/cowork-mcp-registry", get(web::routes::cli_tools::cowork_mcp::registry_get))
        .route("/api/cli-tools/cowork-mcp-tools", post(web::routes::cli_tools::cowork_mcp::tools_post))

        // Static files fallback — JSON 404 for unmatched routes
        .fallback_service(axum::routing::any(json_not_found))
        .layer(cors)
        .with_state(state)
}

/// Build the CORS layer from CORS_ORIGIN env var.
/// allow_credentials is always true (cookie-based auth).
/// When CORS_ORIGIN is set, parse comma-separated origins into an explicit list.
/// When unset, default to ["http://localhost:3000", "http://localhost:20127"].
/// Never use `Any` — it is invalid with `allow_credentials(true)` per the CORS spec.
fn build_cors_layer() -> CorsLayer {
    let default_origins = ["http://localhost:3000", "http://localhost:20127"];

    let origins: Vec<HeaderValue> = match std::env::var("CORS_ORIGIN") {
        Ok(env_val) if !env_val.is_empty() => {
            env_val
                .split(',')
                .map(|o| o.trim())
                .filter(|o| !o.is_empty())
                .map(|o| {
                    o.parse::<HeaderValue>()
                        .expect("Invalid CORS_ORIGIN value")
                })
                .collect()
        }
        _ => {
            // Default origins when CORS_ORIGIN is unset
            default_origins
                .iter()
                .map(|o| {
                    o.parse::<HeaderValue>()
                        .expect("Hardcoded default origin should always parse")
                })
                .collect()
        }
    };

    CorsLayer::new()
        .allow_credentials(true)
        .allow_headers([
            header::COOKIE,
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .expose_headers([
            header::SET_COOKIE,
            axum::http::HeaderName::from_static("retry-after"),
        ])
        .allow_origin(origins)
}

/// JSON 404 for unmatched routes (API-style error, not empty/HTML).
async fn json_not_found() -> impl axum::response::IntoResponse {
    (
        axum::http::StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"error":{"message":"Not Found","type":"invalid_request_error"}}"#,
    )
}
