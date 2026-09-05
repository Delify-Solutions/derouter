//! derouter — Rust rewrite of the AI proxy-fallback router.
//! Single binary: Axum + rusqlite + Askama + HTMX.

mod auth;
mod db;
mod proxy;
mod templates;
mod web;

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use axum::routing::{get, post};
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Init tracing
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Resolve DB path: ${DATA_DIR}/db/data.sqlite — matches Node's dataDir.js
    // DATA_DIR env var, fallback to ~/.derouter (the Node defaultDir)
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

    // Build router
    let app = build_router(pool.clone());

    // Start background flush task for request details
    db::repos::request_details::start_flush_task(pool.clone());

    // Listen on port 20128 (distinct from Node's 20127)
    let port: u16 = std::env::var("DEROUTER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(20128);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn build_router(pool: db::DbPool) -> axum::Router {
    axum::Router::new()
        // Proxy routes (Phase 1 — full proxy implementation)
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
        // Auth routes (public)
        .route("/login", get(web::routes::auth::login_page).post(web::routes::auth::login_submit))
        .route("/logout", get(web::routes::auth::logout))
        // Public usage routes (no admin guard)
        .route("/usage", get(web::routes::public_usage::page))
        .route("/usage/key/receipts", get(web::routes::public_usage::receipts))
        .route("/usage/key/receipts/detail", get(web::routes::public_usage::receipt_detail))
        .route("/usage/key/history", axum::routing::delete(web::routes::public_usage::clear_history))
        // Dashboard routes (guarded by path-based middleware)
        .route("/dashboard", get(dashboard_page))
        .route("/dashboard/providers", get(web::routes::providers::list).post(web::routes::providers::create))
        .route("/dashboard/providers/new", get(web::routes::providers::new))
        .route("/dashboard/providers/{id}", get(web::routes::providers::edit).put(web::routes::providers::update).delete(web::routes::providers::delete))
        .route("/dashboard/combos", get(web::routes::combos::list).post(web::routes::combos::create))
        .route("/dashboard/combos/new", get(web::routes::combos::new))
        .route("/dashboard/combos/{name}/test", post(web::routes::combos::test))
        .route("/dashboard/combos/{id}", get(web::routes::combos::edit).put(web::routes::combos::update).delete(web::routes::combos::delete))
        .route("/dashboard/keys", get(web::routes::keys::list).post(web::routes::keys::create))
        .route("/dashboard/keys/new", get(web::routes::keys::new))
        .route("/dashboard/keys/{id}", get(web::routes::keys::edit).put(web::routes::keys::update).delete(web::routes::keys::delete))
        .route("/dashboard/groups", get(web::routes::groups::list).post(web::routes::groups::create))
        .route("/dashboard/groups/new", get(web::routes::groups::new))
        .route("/dashboard/groups/{id}", get(web::routes::groups::edit).put(web::routes::groups::update).delete(web::routes::groups::delete))
        .route("/dashboard/pricing", get(web::routes::pricing::page).post(web::routes::pricing::update))
        .route("/dashboard/usage", get(web::routes::usage::page))
        .route("/dashboard/usage/overview", get(web::routes::usage::overview_tab))
        .route("/dashboard/usage/keys", get(web::routes::usage::keys_tab))
        .route("/dashboard/usage/keys/table", get(web::routes::usage::keys_table))
        .route("/dashboard/usage/keys/{id}/models", get(web::routes::usage::key_models))
        .route("/dashboard/usage/details", get(web::routes::usage::details_tab))
        .route("/dashboard/usage/details/table", get(web::routes::usage::details_table))
        .route("/dashboard/usage/details/{id}", get(web::routes::usage::detail_drawer))
        // Auth guard — only applies to /dashboard/* paths
        .layer(axum::middleware::from_fn(admin_guard))
        // Static files
        .fallback_service(ServeDir::new("static"))
        .with_state(pool)
}

/// Dashboard overview page
async fn dashboard_page(
    axum::extract::State(_pool): axum::extract::State<db::DbPool>,
) -> impl axum::response::IntoResponse {
    web::render::Render::new(web::templates::DashboardPage {
        content: "Dashboard — Phase 2".to_string(),
    })
}

/// Middleware that checks for admin authentication.
/// Only applies to /dashboard/* paths; other paths pass through.
async fn admin_guard(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::extract::Request;
    use axum::extract::FromRequestParts;
    use auth::RequireAdmin;

    // Only guard /dashboard paths
    let path = request.uri().path();
    if !path.starts_with("/dashboard") {
        return next.run(request).await;
    }

    let (mut parts, body) = request.into_parts();
    match RequireAdmin::from_request_parts(&mut parts, &()).await {
        Ok(_) => next.run(Request::from_parts(parts, body)).await,
        Err(response) => response,
    }
}
