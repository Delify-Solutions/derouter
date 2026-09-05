//! Render helpers — Askama template rendering with Hx-Request partial detection.

use askama::Template;
use axum::{
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
};

/// A template that can render as either a full page (with layout) or a partial
/// (without layout), depending on the Hx-Request header.
pub struct Render<T: Template> {
    template: T,
}

impl<T: Template> Render<T> {
    pub fn new(template: T) -> Self {
        Self { template }
    }
}

impl<T: Template> IntoResponse for Render<T> {
    fn into_response(self) -> Response {
        match self.template.render() {
            Ok(html) => Html(html).into_response(),
            Err(err) => {
                tracing::error!("Template render error: {}", err);
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// Check if a request is an HTMX request (Hx-Request: true)
pub fn is_htmx_request(headers: &HeaderMap) -> bool {
    headers
        .get("hx-request")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}
