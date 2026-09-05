//! Auth route handlers — login/logout. Phase 2.
//! Port of src/app/login/ + src/lib/auth/dashboardSession.js.

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::HeaderValue;
use axum::response::{Redirect, IntoResponse, Response};
use crate::db::DbPool;
use crate::web::render;
use crate::templates::LoginPage;
use crate::auth;

pub async fn login_page() -> impl IntoResponse {
    render::Render::new(LoginPage { error: None })
}

pub async fn login_submit(
    State(pool): State<DbPool>,
    form: axum::Form<LoginFormData>,
) -> Response {
    let password = form.password.clone().unwrap_or_default();

    // Get stored password hash from settings
    let pool_clone = pool.clone();
    let stored_hash = tokio::task::spawn_blocking(move || -> Option<String> {
        let conn = pool_clone.get().ok()?;
        let settings = crate::db::repos::settings::get_settings(&conn).ok()?;
        settings.get("password").and_then(|v| v.as_str()).map(|s| s.to_string())
    })
    .await
    .ok()
    .flatten();

    // Verify password
    if auth::verify_dashboard_password(&password, stored_hash.as_deref()) {
        // Issue JWT token
        match auth::issue_token() {
            Ok(token) => {
                // Set cookie and redirect to dashboard
                let cookie_value = format!(
                    "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400",
                    auth::ADMIN_COOKIE_NAME, token
                );
                let mut response = Redirect::to("/dashboard").into_response();
                response.headers_mut().insert(
                    SET_COOKIE,
                    HeaderValue::from_str(&cookie_value).unwrap(),
                );
                response
            }
            Err(_) => {
                render::Render::new(LoginPage {
                    error: Some("Failed to create session".to_string()),
                })
                .into_response()
            }
        }
    } else {
        render::Render::new(LoginPage {
            error: Some("Invalid password".to_string()),
        })
        .into_response()
    }
}

pub async fn logout() -> impl IntoResponse {
    let cookie_value = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        auth::ADMIN_COOKIE_NAME
    );
    let mut response = Redirect::to("/login").into_response();
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(&cookie_value).unwrap(),
    );
    response
}

#[derive(serde::Deserialize)]
pub struct LoginFormData {
    pub username: Option<String>,
    pub password: Option<String>,
}
