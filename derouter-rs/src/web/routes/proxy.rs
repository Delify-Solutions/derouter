//! Proxy route handlers — /v1/* endpoints.
//! Phase 1: full proxy implementation.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::db::DbPool;
use crate::proxy::chat;

/// POST /v1/chat/completions — OpenAI chat completions
pub async fn handle_chat_completions(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    chat::handle_chat(pool, body, headers, "/v1/chat/completions").await
}

/// POST /v1/completions — legacy OpenAI completions (same handler)
pub async fn handle_completions(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    chat::handle_chat(pool, body, headers, "/v1/completions").await
}

/// GET /v1/models — list available models
pub async fn handle_models(
    State(pool): State<DbPool>,
    headers: HeaderMap,
) -> Response {
    crate::proxy::models::handle_models_list(pool, headers).await
}

/// POST /v1/embeddings — embeddings
pub async fn handle_embeddings(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::embeddings::handle_embeddings(pool, body, headers).await
}

/// POST /v1/images/generations — image generation
pub async fn handle_images(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::images::handle_image_generation(pool, body, headers).await
}

/// POST /v1/audio/speech — TTS
pub async fn handle_audio_speech(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::audio::handle_tts(pool, body, headers).await
}

/// POST /v1/audio/transcriptions — STT
pub async fn handle_audio_transcriptions(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::audio::handle_stt(pool, body, headers).await
}

/// POST /v1/videos/generations — video generation
pub async fn handle_video_generations(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::video::handle_video_generation(pool, body, headers).await
}

/// POST /v1/responses — OpenAI Responses API
pub async fn handle_responses(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    chat::handle_chat(pool, body, headers, "/v1/responses").await
}

/// POST /v1/search — web search
pub async fn handle_search(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    crate::proxy::search::handle_search(pool, body, headers).await
}

/// POST /v1/messages — Anthropic Messages API
pub async fn handle_messages(
    State(pool): State<DbPool>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    chat::handle_chat(pool, body, headers, "/v1/messages").await
}

/// POST /v1/messages/count_tokens — token estimation (mock, like Node)
pub async fn handle_messages_count_tokens(
    State(_pool): State<DbPool>,
    body: axum::body::Bytes,
) -> Response {
    // Port of count_tokens route — estimates input tokens from message content
    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "Invalid JSON body" })),
        ).into_response(),
    };

    let input_tokens = estimate_anthropic_input_tokens(&body_json);
    (
        StatusCode::OK,
        axum::Json(json!({ "input_tokens": input_tokens })),
    ).into_response()
}

/// Estimate input tokens for Anthropic-style messages.
/// Port of estimateAnthropicInputTokens from messages/count_tokens/route.js.
fn estimate_anthropic_input_tokens(body: &serde_json::Value) -> i64 {
    let mut total_chars: i64 = 0;

    // System prompt
    if let Some(system) = body.get("system") {
        total_chars += count_value_chars(system);
    }

    // Tools
    if let Some(tools) = body.get("tools") {
        total_chars += count_value_chars(tools);
    }

    // Messages
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            total_chars += count_message_chars(msg);
        }
    }

    (total_chars + 3) / 4 // ceil(total/4)
}

fn count_value_chars(value: &serde_json::Value) -> i64 {
    match value {
        serde_json::Value::Null => 0,
        serde_json::Value::Bool(b) => b.to_string().len() as i64,
        serde_json::Value::Number(n) => n.to_string().len() as i64,
        serde_json::Value::String(s) => s.len() as i64,
        serde_json::Value::Array(arr) => arr.iter().map(count_value_chars).sum(),
        serde_json::Value::Object(obj) => obj.iter().map(|(k, v)| k.len() as i64 + count_value_chars(v)).sum(),
    }
}

fn count_content_block_chars(block: &serde_json::Value) -> i64 {
    if let Some(s) = block.as_str() {
        return s.len() as i64;
    }
    match block.get("type").and_then(|v| v.as_str()) {
        Some("text") => block.get("text").map(count_value_chars).unwrap_or(0),
        Some("tool_use") => {
            block.get("name").map(count_value_chars).unwrap_or(0)
                + block.get("input").map(count_value_chars).unwrap_or(0)
        }
        Some("tool_result") => block.get("content").map(count_value_chars).unwrap_or(0),
        Some("thinking") => block.get("thinking").map(count_value_chars).unwrap_or(0),
        _ => count_value_chars(block),
    }
}

fn count_message_chars(msg: &serde_json::Value) -> i64 {
    let content = msg.get("content");
    match content {
        Some(serde_json::Value::String(s)) => s.len() as i64,
        Some(serde_json::Value::Array(arr)) => arr.iter().map(count_content_block_chars).sum(),
        Some(v) => count_value_chars(v),
        None => 0,
    }
}
