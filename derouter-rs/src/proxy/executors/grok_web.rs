//! Grok Web executor.
//! Port of open-sse/executors/grok-web.js.
//!
//! Routes chat completions through grok.com's web SSE endpoint
//! (https://grok.com/rest/app-chat/conversations/new).
//!
//! Auth: web cookie — the `sso=` cookie value from grok.com is stored in
//! connection.data.apiKey or .cookie. It is sent as `Cookie: sso=<value>`.
//!
//! The request body is transformed from OpenAI chat format to Grok Web's
//! expected shape (conversational turn array), and the response is an SSE
//! stream of `{ result: { response: { text: "..." } } }` frames that are
//! re-emitted as OpenAI chat.completion.chunk SSE.
//!
//! This executor overrides the full pipeline (like zed.rs). The body is
//! transformed inline; no translator adapter is needed.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::{Stream, StreamExt};

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct GrokWebExecutor;

const GROK_WEB_URL: &str = "https://grok.com/rest/app-chat/conversations/new";

/// Per-process conversation id cache: key = connectionId, value = conversation id
static GROK_WEB_CONVERSATION_CACHE: once_cell::sync::Lazy<Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Extract text content from an OpenAI message.
fn extract_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                    p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        return parts.join("\n");
    }
    String::new()
}

/// Map models like grok-3-thinking to Grok Web's modelKey.
fn resolve_grok_web_model(model: &str) -> String {
    // Grok Web uses the model id directly; strip any prefix
    model.to_string()
}

/// Build the Grok Web request body from the OpenAI chat completion body.
fn build_grok_web_body(
    body: &serde_json::Value,
    _connection_id: &str,
) -> (serde_json::Value, String) {
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("grok-3")
        .to_string();
    let grok_model = resolve_grok_web_model(&model);

    let mut system_text = String::new();
    let mut messages = Vec::new();

    if let Some(msgs) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in msgs {
            let role = msg
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("user")
                .to_string();
            let content = extract_text(msg.get("content").unwrap_or(&serde_json::Value::Null));

            if role == "system" {
                if !system_text.is_empty() {
                    system_text.push('\n');
                }
                system_text.push_str(&content);
            } else {
                messages.push(serde_json::json!({
                    "message": content,
                    "role": if role == "assistant" { "assistant" } else { "user" },
                    "sender": "user",
                }));
            }
        }
    }

    let conversation_id = uuid::Uuid::new_v4().to_string();

    let mut request_body = serde_json::json!({
        "conversationId": conversation_id,
        "returnSearchResults": false,
        "returnRelatedQuestions": false,
        "sendMetadata": false,
        "isReasoning": false,
        "isPreset": false,
        "modelKey": grok_model,
        "messages": messages,
        "systemPromptName": "default",
        "temporary": false,
    });

    if !system_text.is_empty() {
        if let Some(obj) = request_body.as_object_mut() {
            obj.insert(
                "systemInstructions".to_string(),
                serde_json::Value::String(system_text),
            );
        }
    }

    // Add reasoning flag for thinking models
    let m = model.to_lowercase();
    if m.contains("thinking") || m.contains("mini") {
        if let Some(obj) = request_body.as_object_mut() {
            obj.insert("isReasoning".to_string(), serde_json::json!(true));
        }
    }

    (request_body, conversation_id)
}

/// Parse a single SSE line from Grok Web and extract content.
enum GrokWebLine {
    Delta(String),
    Done,
    Error(String),
    None,
}

fn parse_grok_web_line(line: &str) -> GrokWebLine {
    let text = line.trim();
    if text.is_empty() {
        return GrokWebLine::None;
    }
    let data = if let Some(rest) = text.strip_prefix("data:") {
        rest.trim_start()
    } else {
        text
    };
    if data == "[DONE]" {
        return GrokWebLine::Done;
    }
    let parsed: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return GrokWebLine::None,
    };

    // Error check
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return GrokWebLine::Error(err.to_string());
    }

    // Extract text from result.response.text or result.token
    let result = parsed.get("result").unwrap_or(&parsed);
    let response = result.get("response").or_else(|| result.get("token"));
    if let Some(resp) = response {
        if let Some(text) = resp.get("text").and_then(|v| v.as_str()) {
            return GrokWebLine::Delta(text.to_string());
        }
        if let Some(token) = resp.as_str() {
            return GrokWebLine::Delta(token.to_string());
        }
    }
    // Sometimes the text is at top level
    if let Some(text) = parsed.get("token").and_then(|v| v.as_str()) {
        return GrokWebLine::Delta(text.to_string());
    }
    GrokWebLine::None
}

/// Wrap the Grok Web response stream into OpenAI-compatible SSE.
fn wrap_grok_web_stream(
    upstream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin + 'static,
    model: String,
) -> Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);

    tokio::spawn(async move {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut done = false;
        let cid = format!("chatcmpl-grok-web-{}", now_ms());
        let created = now_secs();

        // Emit initial role chunk
        let role_chunk = serde_json::json!({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": ""},
                "finish_reason": null,
                "logprobs": null,
            }],
        });
        let _ = tx
            .send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk))))
            .await;

        while !done {
            while let Some(nl) = buffer.find('\n') {
                let line = buffer[..nl].to_string();
                buffer = buffer[nl + 1..].to_string();
                match parse_grok_web_line(&line) {
                    GrokWebLine::None => {}
                    GrokWebLine::Done => {
                        done = true;
                        break;
                    }
                    GrokWebLine::Error(msg) => {
                        let chunk = serde_json::json!({
                            "id": cid,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "delta": {"content": format!("[Grok Web error: {}]", msg)},
                                "finish_reason": "stop",
                                "logprobs": null,
                            }],
                        });
                        let _ = tx
                            .send(Ok(Bytes::from(format!("data: {}\n\n", chunk))))
                            .await;
                        done = true;
                        break;
                    }
                    GrokWebLine::Delta(text) => {
                        let chunk = serde_json::json!({
                            "id": cid,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [{
                                "index": 0,
                                "delta": {"content": text},
                                "finish_reason": null,
                                "logprobs": null,
                            }],
                        });
                        let _ = tx
                            .send(Ok(Bytes::from(format!("data: {}\n\n", chunk))))
                            .await;
                    }
                }
            }
            if done {
                break;
            }

            match upstream.next().await {
                Some(Ok(chunk)) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                }
                Some(Err(e)) => {
                    let _ = tx
                        .send(Err(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        .await;
                    return;
                }
                None => {
                    // Process remaining buffer
                    if !buffer.is_empty() {
                        match parse_grok_web_line(&buffer) {
                            GrokWebLine::Delta(text) => {
                                let chunk = serde_json::json!({
                                    "id": cid,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {"content": text},
                                        "finish_reason": null,
                                        "logprobs": null,
                                    }],
                                });
                                let _ = tx
                                    .send(Ok(Bytes::from(format!("data: {}\n\n", chunk))))
                                    .await;
                            }
                            _ => {}
                        }
                    }
                    break;
                }
            }
        }

        // Emit finish chunk
        let finish_chunk = serde_json::json!({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
                "logprobs": null,
            }],
        });
        let _ = tx
            .send(Ok(Bytes::from(format!("data: {}\n\n", finish_chunk))))
            .await;
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
    });

    Box::new(ReceiverStream::new(rx))
}

#[async_trait::async_trait]
impl ProviderExecutor for GrokWebExecutor {
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
        // Grok Web is stream-only; route complete through stream
        self.execute(conn, body, true).await
    }
}

impl GrokWebExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let cookie = get_connection_auth(&conn.data)
            .or_else(|| {
                conn.data
                    .get("cookie")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .ok_or_else(|| anyhow::anyhow!("Grok Web connection missing cookie (sso= value)"))?;

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("grok-3")
            .to_string();

        let conn_id = conn.id.clone();

        let (grok_body, _conversation_id) = build_grok_web_body(&body, &conn_id);

        let client = build_client();
        let resp = client
            .post(GROK_WEB_URL)
            .header(
                "Cookie",
                format!("sso={}", cookie),
            )
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
            .header("Origin", "https://grok.com")
            .header("Referer", "https://grok.com/")
            .json(&grok_body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let msg = if status.as_u16() == 401 || status.as_u16() == 403 {
                "Grok Web auth failed — sso cookie may be expired. Re-paste your sso= cookie value from grok.com.".to_string()
            } else {
                text
            };
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: msg,
            });
        }

        let upstream = resp.bytes_stream();
        let boxed = wrap_grok_web_stream(upstream, model);
        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: boxed,
        })
    }
}
