//! Qoder executor.
//! Port of open-sse/executors/qoder.js.
//!
//! Routes chat completions through Qoder's COSY-signed inference endpoint
//! at api3.qoder.sh. The request body is transformed from OpenAI chat format
//! to Qoder's native shape, and the response is an SSE stream with a
//! `{statusCodeValue, body}` envelope that is unwrapped back to plain OpenAI SSE.
//!
//! Auth: Qoder device token (dt-...), job token (jt-...), or PAT (pt-...).
//! The Node version uses COSY (RSA + AES + MD5 + ~17 Cosy-* headers) for signing.
//! This Rust port forwards the request with Bearer auth and notes that the COSY
//! signing layer needs to be ported for production use.
//!
//! NOTE: The COSY signing (qoderEncodeBody, buildCosyHeaders) is not yet ported.
//! This executor sends the body as-is with Bearer auth. When the COSY module is
//! available, it should be wired in here. The SSE envelope unwrapping is
//! implemented inline.

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use uuid::Uuid;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct QoderExecutor;

const QODER_CHAT_URL_ENCODED: &str =
    "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation";
const QODER_CHAT_BASE_ALT: &str = "https://api2.qoder.sh";
const QODER_CHAT_SIG_PATH: &str = "/api/v2/service/pro/sse/agent_chat_generation";

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Extract text from message content (string or array of parts)
fn extract_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                    item.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    item.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                }
            })
            .collect();
        return parts.join("\n");
    }
    String::new()
}

/// Normalize messages: hoist system out of array, flatten multipart content
fn normalize_messages(messages: &[serde_json::Value]) -> (Vec<serde_json::Value>, String) {
    let mut system_parts = Vec::new();
    let mut out = Vec::new();
    for msg in messages {
        let text = extract_text(msg.get("content").unwrap_or(&serde_json::Value::Null));
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        if role == "system" {
            if !text.is_empty() {
                system_parts.push(text);
            }
            continue;
        }
        let mut cloned = msg.clone();
        if let Some(obj) = cloned.as_object_mut() {
            obj.insert("content".to_string(), serde_json::Value::String(text));
        }
        out.push(cloned);
    }
    (out, system_parts.join("\n\n"))
}

fn last_user_text(messages: &[serde_json::Value]) -> String {
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) == Some("user") {
            if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                return content.to_string();
            }
        }
    }
    String::new()
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() > n {
        format!("{}...", &s[..n])
    } else {
        s.to_string()
    }
}

fn stable_hash(prefix: &str, parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(prefix);
    for p in parts {
        h.update("\0");
        h.update(p);
    }
    let result = h.finalize();
    format!("{:016x}", u128::from_be_bytes(result[..16].try_into().unwrap_or([0u8; 16])))
}

/// Check if a token is a PAT (pt-...)
fn is_pat(token: &str) -> bool {
    token.starts_with("pt-")
}

/// Check if a token is a job token (jt-...)
fn is_jt(token: &str) -> bool {
    token.starts_with("jt-")
}

/// Build the Qoder request body from the OpenAI chat completion body.
fn build_qoder_request_body(
    model: &str,
    body: &serde_json::Value,
    data: &serde_json::Value,
) -> serde_json::Value {
    let qoder_key = model.trim_start_matches("qoder/").to_string();

    let messages = body
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let (messages, system_text) = normalize_messages(&messages);
    let tools = body.get("tools").cloned().unwrap_or(serde_json::Value::Array(vec![]));
    let last_user = last_user_text(&messages);

    let psd = data
        .get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"))
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let user_id = psd
        .get("userId")
        .or_else(|| psd.get("user_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let session_id = stable_hash("qoder-session", &[user_id, &qoder_key]);
    let max_tokens = body
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(32768);
    let record_id = stable_hash("qoder-record", &[&format!("{}", max_tokens)]);

    serde_json::json!({
        "request_id": Uuid::new_v4().to_string(),
        "request_set_id": record_id,
        "chat_record_id": record_id,
        "session_id": session_id,
        "stream": true,
        "chat_task": "FREE_INPUT",
        "is_reply": true,
        "is_retry": false,
        "source": 1,
        "version": "3",
        "session_type": "qodercli",
        "agent_id": "agent_common",
        "task_id": "common",
        "code_language": "",
        "chat_prompt": "",
        "image_urls": null,
        "aliyun_user_type": "",
        "system": system_text,
        "messages": messages,
        "tools": tools,
        "parameters": { "max_tokens": max_tokens },
        "chat_context": {
            "chatPrompt": "",
            "imageUrls": null,
            "extra": {
                "context": [],
                "modelConfig": { "key": qoder_key, "is_reasoning": false },
                "originalContent": last_user,
            },
            "features": [],
            "text": last_user,
        },
        "model_config": {
            "key": qoder_key,
            "is_reasoning": false,
            "source": "system",
        },
        "business": {
            "product": "cli",
            "version": "1.0.0",
            "type": "agent",
            "stage": "start",
            "id": Uuid::new_v4().to_string(),
            "name": truncate(&last_user, 30),
            "begin_at": now_ms(),
        },
    })
}

/// Check if an error message indicates a billing/quota block
fn is_billing_block(inner: &str) -> bool {
    let lower = inner.to_lowercase();
    lower.contains("\"code\":\"112\"") || lower.contains("\"code\":\"10605\"") || lower.contains("pricingurl")
}

/// Wrap the Qoder `{statusCodeValue, body}` SSE envelope into plain OpenAI SSE.
fn wrap_qoder_sse(
    upstream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin + 'static,
    model: String,
) -> Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);

    tokio::spawn(async move {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut done_emitted = false;

        while !done_emitted {
            while let Some(nl) = buffer.find('\n') {
                let line = buffer[..nl].trim().to_string();
                buffer = buffer[nl + 1..].to_string();

                if line.is_empty() || !line.starts_with("data:") {
                    continue;
                }
                if done_emitted {
                    continue;
                }

                let data = line[5..].trim_start();
                if data == "[DONE]" {
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                    done_emitted = true;
                    break;
                }

                let envelope: serde_json::Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let status_val = envelope
                    .get("statusCodeValue")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(200);
                let inner = envelope
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if status_val != 200 && is_billing_block(inner) {
                    let err = serde_json::json!({
                        "error": {"message": inner, "code": status_val}
                    });
                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err)))).await;
                    done_emitted = true;
                    break;
                }

                if status_val != 200 {
                    let msg = if !inner.is_empty() {
                        truncate(inner, 200)
                    } else {
                        format!("upstream status {}", status_val)
                    };
                    let err_chunk = serde_json::json!({
                        "id": format!("qoder-error-{}", now_ms()),
                        "object": "chat.completion.chunk",
                        "created": now_secs(),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": format!("\n[qoder error {}: {}]", status_val, msg)},
                            "finish_reason": "stop",
                        }],
                    });
                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk)))).await;
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                    done_emitted = true;
                    break;
                }

                if inner.is_empty() {
                    continue;
                }
                if inner == "[DONE]" {
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                    done_emitted = true;
                    break;
                }

                // Strip embedded newlines so the SSE frame stays a single event
                let sanitized = inner.replace(['\r', '\n'], "");
                let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", sanitized)))).await;
            }
            if done_emitted {
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
                        let trimmed = buffer.trim();
                        if trimmed.starts_with("data:") && !trimmed[5..].trim_start().is_empty() {
                            // Process as final line
                        }
                    }
                    break;
                }
            }
        }

        if !done_emitted {
            // Emit terminal [DONE]
            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
        }
    });

    Box::new(ReceiverStream::new(rx))
}

#[async_trait::async_trait]
impl ProviderExecutor for QoderExecutor {
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
        // Qoder is stream-only; route complete through stream
        self.execute(conn, body, true).await
    }
}

impl QoderExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let raw_token = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Qoder connection missing apiKey or accessToken"))?;

        let psd = conn
            .data
            .get("providerSpecificData")
            .or_else(|| conn.data.get("provider_specific_data"));
        let user_id = psd
            .and_then(|p| p.get("userId").or_else(|| p.get("user_id")))
            .and_then(|v| v.as_str());

        if user_id.is_none() {
            return Ok(UpstreamResponse::Error {
                status: StatusCode::UNAUTHORIZED,
                message: r#"{"error":{"message":"qoder credential is missing userId; reconnect the account"}}"#
                    .to_string(),
            });
        }

        if conn.data.get("accessToken").or_else(|| conn.data.get("access_token")).is_none() {
            return Ok(UpstreamResponse::Error {
                status: StatusCode::UNAUTHORIZED,
                message: r#"{"error":{"message":"qoder credential is missing accessToken; reconnect the account"}}"#
                    .to_string(),
            });
        }

        let access_token = conn
            .data
            .get("accessToken")
            .or_else(|| conn.data.get("access_token"))
            .and_then(|v| v.as_str())
            .unwrap_or(&raw_token);

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();

        // Build URL: job tokens (jt-) use api2.qoder.sh
        let url = if is_jt(&raw_token) {
            format!(
                "{}/algo{}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
                QODER_CHAT_BASE_ALT, QODER_CHAT_SIG_PATH
            )
        } else {
            QODER_CHAT_URL_ENCODED.to_string()
        };

        let qoder_key = model.trim_start_matches("qoder/").to_string();
        let payload = build_qoder_request_body(&model, &body, &conn.data);

        // NOTE: The Node version applies COSY signing (qoderEncodeBody + buildCosyHeaders)
        // here. Those modules are not yet ported to Rust. We send the body as-is with
        // Bearer auth. When the COSY module is available, it should be wired in here:
        //   let encoded_body = qoder_encode_body(&payload_json);
        //   let cosy_headers = build_cosy_headers(&encoded_body, &url, &signing_info);
        //   req = req.body(encoded_body).headers(cosy_headers);
        let payload_json = serde_json::to_string(&payload).unwrap_or_default();

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("X-Model-Key", &qoder_key)
            .header("X-Model-Source", "system")
            .header("Accept-Encoding", "identity")
            .header("Authorization", format!("Bearer {}", access_token))
            .body(payload_json)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let upstream = resp.bytes_stream();
        let boxed = wrap_qoder_sse(upstream, model);
        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: boxed,
        })
    }
}
