//! Windsurf executor.
//! Port of open-sse/executors/windsurf.js.
//!
//! Routes chat completions through Codeium's gRPC-web endpoint
//! (https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage).
//!
//! Auth: Codeium apiKey (sk-ws-... or Firebase-derived) from
//! connection.data.accessToken or .apiKey. Sent as Bearer header AND embedded
//! in the protobuf Metadata.api_key field.
//!
//! Wire protocol: gRPC-web over HTTPS (Content-Type: application/grpc-web+proto).
//! Request: minimal protobuf GetChatMessageRequest (metadata, cascade_id,
//! model_or_alias, repeated messages). Response: streamed CompletionChunk
//! frames (content/done/error), re-emitted as OpenAI-compatible SSE.
//!
//! NOTE: The model alias map (catalog name → Windsurf wire name) is inlined.

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use uuid::Uuid;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct WindsurfExecutor;

const WS_CHAT_URL: &str =
    "https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage";
const WS_IDE_NAME: &str = "windsurf";
const WS_IDE_VERSION: &str = "3.14.0";
const WS_EXT_VERSION: &str = "3.14.0";
const WS_LOCALE: &str = "en-US";

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Model alias map: catalog name → Windsurf wire name
fn model_alias_map() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    // SWE models
    m.insert("swe-1.6-fast", "swe-1-6-fast");
    m.insert("swe-1.6", "swe-1-6");
    m.insert("swe-1.5-fast", "swe-1-5-fast");
    m.insert("swe-1.5", "swe-1-5");
    // Claude Opus 4.7 — effort-tiered
    m.insert("claude-opus-4.7-max", "claude-opus-4-7-max");
    m.insert("claude-opus-4.7-xhigh", "claude-opus-4-7-xhigh");
    m.insert("claude-opus-4.7-high", "claude-opus-4-7-high");
    m.insert("claude-opus-4.7-medium", "claude-opus-4-7-medium");
    m.insert("claude-opus-4.7-low", "claude-opus-4-7-low");
    m.insert("claude-opus-4.7-review", "opus-4-7-review");
    // Claude 4.6
    m.insert("claude-sonnet-4.6-thinking-1m", "claude-sonnet-4-6-thinking-1m");
    m.insert("claude-sonnet-4.6-1m", "claude-sonnet-4-6-1m");
    m.insert("claude-sonnet-4.6-thinking", "claude-sonnet-4-6-thinking");
    m.insert("claude-sonnet-4.6", "claude-sonnet-4-6");
    m.insert("claude-opus-4.6-thinking", "claude-opus-4-6-thinking");
    m.insert("claude-opus-4.6", "claude-opus-4-6");
    // Claude 4.5
    m.insert("claude-opus-4.5-thinking", "MODEL_CLAUDE_4_5_OPUS_THINKING");
    m.insert("claude-opus-4.5", "MODEL_CLAUDE_4_5_OPUS");
    m.insert("claude-sonnet-4.5-thinking", "MODEL_PRIVATE_3");
    m.insert("claude-sonnet-4.5", "MODEL_PRIVATE_2");
    m.insert("claude-haiku-4.5", "MODEL_PRIVATE_11");
    // GPT models
    m.insert("gpt-5", "gpt-5");
    m.insert("gpt-4.1", "MODEL_CHAT_GPT_4_1_2025_04_14");
    m.insert("gpt-4.1-mini", "gpt-4.1-mini");
    m.insert("gpt-4o", "MODEL_CHAT_GPT_4O_2024_08_06");
    // Gemini
    m.insert("gemini-2.5-pro", "MODEL_GOOGLE_GEMINI_2_5_PRO");
    // Others
    m.insert("deepseek-v4", "deepseek-v4");
    m.insert("kimi-k2.6", "kimi-k2-6");
    m.insert("kimi-k2.5", "kimi-k2-5");
    m.insert("glm-5.1", "glm-5-1");
    m
}

fn resolve_ws_model_id(model: &str) -> String {
    model_alias_map()
        .get(model)
        .map(|s| s.to_string())
        .unwrap_or_else(|| model.to_string())
}

// ─── Minimal protobuf encoder ──────────────────────────────────────────────────

fn encode_varint(value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut v = value;
    while v > 0x7f {
        bytes.push((v & 0x7f) as u8 | 0x80);
        v >>= 7;
    }
    bytes.push(v as u8 & 0x7f);
    bytes
}

fn encode_field(field_num: u32, payload: &[u8]) -> Vec<u8> {
    let tag = encode_varint(((field_num as u64) << 3) | 2);
    let len = encode_varint(payload.len() as u64);
    let mut out = Vec::with_capacity(tag.len() + len.len() + payload.len());
    out.extend_from_slice(&tag);
    out.extend_from_slice(&len);
    out.extend_from_slice(payload);
    out
}

fn encode_string(field_num: u32, value: &str) -> Vec<u8> {
    encode_field(field_num, value.as_bytes())
}

fn encode_message(field_num: u32, msg: &[u8]) -> Vec<u8> {
    encode_field(field_num, msg)
}

fn concat_bytes(arrays: &[Vec<u8>]) -> Vec<u8> {
    let total = arrays.iter().map(|a| a.len()).sum();
    let mut out = Vec::with_capacity(total);
    for a in arrays {
        out.extend_from_slice(a);
    }
    out
}

fn build_metadata(api_key: &str, session_id: &str) -> Vec<u8> {
    concat_bytes(&[
        encode_string(1, api_key),
        encode_string(2, WS_IDE_NAME),
        encode_string(3, WS_IDE_VERSION),
        encode_string(4, WS_EXT_VERSION),
        encode_string(5, session_id),
        encode_string(6, WS_LOCALE),
    ])
}

fn build_model_or_alias(model: &str) -> Vec<u8> {
    encode_string(1, model)
}

struct WsMessage {
    role: String,
    content: String,
    #[allow(dead_code)]
    tool_call_id: Option<String>,
}

/// Build the gRPC-web framed request: 5-byte header (flag + big-endian length) + payload
fn grpc_web_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0u8; 5 + payload.len()];
    frame[0] = 0x00; // no compression
    let len = payload.len() as u32;
    frame[1] = (len >> 24) as u8;
    frame[2] = (len >> 16) as u8;
    frame[3] = (len >> 8) as u8;
    frame[4] = len as u8;
    frame[5..].copy_from_slice(payload);
    frame
}

fn build_get_chat_message_request(api_key: &str, model: &str, messages: &[WsMessage]) -> Vec<u8> {
    let session_id = Uuid::new_v4().to_string();
    let cascade_id = Uuid::new_v4().to_string();

    let mut parts = vec![
        encode_message(1, &build_metadata(api_key, &session_id)), // metadata
        encode_string(2, &cascade_id),                              // cascade_id
        encode_message(3, &build_model_or_alias(model)),           // model_or_alias
    ];

    for msg in messages {
        let mut msg_parts = vec![
            encode_string(1, &msg.role),
            encode_string(2, &msg.content),
        ];
        if let Some(ref tcid) = msg.tool_call_id {
            msg_parts.push(encode_string(3, tcid));
        }
        parts.push(encode_message(4, &concat_bytes(&msg_parts)));
    }

    concat_bytes(&parts)
}

// ─── Protobuf response decoder ─────────────────────────────────────────────────
// CompletionChunk (oneof):
//   field 1 → ContentChunk { field 1: string text }
//   field 2 → ToolCallChunk (skipped)
//   field 3 → DoneChunk    { field 1: UsageStats{ field1: prompt, field2: completion } }
//   field 4 → ErrorChunk   { field 1: string message }

enum DecodeResult {
    Content { text: String },
    Done { prompt_tokens: u64, completion_tokens: u64 },
    Error { message: String },
    Unknown,
}

fn read_varint(buf: &[u8], offset: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    while *offset < buf.len() {
        let b = buf[*offset];
        *offset += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if (b & 0x80) == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

fn decode_string_field(buf: &[u8], target_field: u32) -> Option<String> {
    let mut offset = 0;
    while offset < buf.len() {
        let tag = read_varint(buf, &mut offset)?;
        let field_num = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u8;
        if wire_type == 2 {
            let len = read_varint(buf, &mut offset)? as usize;
            let payload = &buf[offset..offset + len];
            offset += len;
            if field_num == target_field {
                return String::from_utf8(payload.to_vec()).ok();
            }
        } else if wire_type == 0 {
            read_varint(buf, &mut offset)?;
        } else if wire_type == 1 {
            offset += 8;
        } else if wire_type == 5 {
            offset += 4;
        } else {
            break;
        }
    }
    None
}

fn decode_done_chunk(buf: &[u8]) -> (u64, u64) {
    let mut offset = 0;
    let mut usage_bytes: &[u8] = &[];
    let mut found = false;
    while offset < buf.len() {
        let tag = match read_varint(buf, &mut offset) {
            Some(t) => t,
            None => break,
        };
        let field_num = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u8;
        if wire_type == 2 {
            let len = match read_varint(buf, &mut offset) {
                Some(l) => l as usize,
                None => break,
            };
            if field_num == 1 {
                usage_bytes = &buf[offset..offset + len];
                found = true;
            }
            offset += len;
        } else if wire_type == 0 {
            read_varint(buf, &mut offset);
        } else {
            break;
        }
    }
    if !found {
        return (0, 0);
    }
    let mut pt = 0u64;
    let mut ct = 0u64;
    let mut off = 0;
    while off < usage_bytes.len() {
        let tag = match read_varint(usage_bytes, &mut off) {
            Some(t) => t,
            None => break,
        };
        let field_num = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u8;
        if wire_type == 0 {
            let v = read_varint(usage_bytes, &mut off).unwrap_or(0);
            if field_num == 1 {
                pt = v;
            } else if field_num == 2 {
                ct = v;
            }
        } else if wire_type == 2 {
            let len = read_varint(usage_bytes, &mut off).unwrap_or(0) as usize;
            off += len;
        } else {
            break;
        }
    }
    (pt, ct)
}

fn decode_completion_chunk(buf: &[u8]) -> DecodeResult {
    let mut offset = 0;
    while offset < buf.len() {
        let tag = match read_varint(buf, &mut offset) {
            Some(t) => t,
            None => break,
        };
        let field_num = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u8;

        if wire_type == 2 {
            let len = match read_varint(buf, &mut offset) {
                Some(l) => l as usize,
                None => break,
            };
            let payload = &buf[offset..offset + len];
            offset += len;

            if field_num == 1 {
                if let Some(text) = decode_string_field(payload, 1) {
                    return DecodeResult::Content { text };
                }
            } else if field_num == 3 {
                let (pt, ct) = decode_done_chunk(payload);
                return DecodeResult::Done {
                    prompt_tokens: pt,
                    completion_tokens: ct,
                };
            } else if field_num == 4 {
                let msg = decode_string_field(payload, 1).unwrap_or_else(|| "unknown windsurf error".to_string());
                return DecodeResult::Error { message: msg };
            }
            // field 2 = ToolCallChunk — skip
        } else if wire_type == 0 {
            read_varint(buf, &mut offset);
        } else if wire_type == 1 {
            offset += 8;
        } else if wire_type == 5 {
            offset += 4;
        } else {
            break;
        }
    }
    DecodeResult::Unknown
}

/// Convert OpenAI messages to Windsurf wire messages
fn openai_messages_to_ws(messages: &[serde_json::Value]) -> Vec<WsMessage> {
    let mut out = Vec::new();
    for m in messages {
        let role = m
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .to_string();
        let content = if let Some(s) = m.get("content").and_then(|v| v.as_str()) {
            s.to_string()
        } else if let Some(arr) = m.get("content").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|p| {
                    if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                        p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        } else {
            String::new()
        };
        let tool_call_id = m
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(WsMessage {
            role,
            content,
            tool_call_id,
        });
    }
    out
}

/// Wrap the gRPC-web response into OpenAI-compatible SSE stream
fn wrap_windsurf_stream(
    upstream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin + 'static,
    model: String,
) -> Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);

    tokio::spawn(async move {
        let mut upstream = Box::pin(upstream);
        let response_id = format!("chatcmpl-ws-{}", now_ms());
        let created = now_secs();
        let mut role_emitted = false;
        let mut total_text = String::new();
        let mut prompt_tokens: u64 = 0;
        let mut completion_tokens: u64 = 0;
        let mut had_error: Option<String> = None;
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match upstream.next().await {
                Some(Ok(chunk)) => {
                    pending.extend_from_slice(&chunk);
                }
                Some(Err(e)) => {
                    let _ = tx
                        .send(Err(std::io::Error::new(std::io::ErrorKind::Other, e)))
                        .await;
                    return;
                }
                None => break,
            }

            // Drain frames from pending
            let mut offset = 0;
            while offset + 5 <= pending.len() {
                let flag = pending[offset];
                let len = ((pending[offset + 1] as u32) << 24)
                    | ((pending[offset + 2] as u32) << 16)
                    | ((pending[offset + 3] as u32) << 8)
                    | (pending[offset + 4] as u32);
                if offset + 5 + len as usize > pending.len() {
                    break;
                }
                let payload = &pending[offset + 5..offset + 5 + len as usize];
                offset += 5 + len as usize;

                if flag == 0x80 {
                    // Trailer frame — check grpc-status
                    let trailer = String::from_utf8_lossy(payload);
                    if let Some(status_match) = trailer.find("grpc-status:") {
                        let rest = &trailer[status_match + 12..];
                        let status_str = rest.trim();
                        if !status_str.starts_with('0') {
                            let msg_start = trailer.find("grpc-message:");
                            let msg = if let Some(ms) = msg_start {
                                let m = &trailer[ms + 13..];
                                m.trim().to_string()
                            } else {
                                format!("gRPC status {}", status_str.split(['\r', '\n']).next().unwrap_or(""))
                            };
                            had_error = Some(msg);
                        }
                    }
                    continue;
                }
                if flag != 0x00 {
                    continue;
                }

                let chunk = decode_completion_chunk(payload);
                match chunk {
                    DecodeResult::Content { text } => {
                        if !text.is_empty() {
                            total_text.push_str(&text);
                            if !role_emitted {
                                let role_chunk = serde_json::json!({
                                    "id": response_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {"role": "assistant", "content": ""},
                                        "finish_reason": null,
                                    }],
                                });
                                let _ = tx
                                    .send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk))))
                                    .await;
                                role_emitted = true;
                            }
                            let content_chunk = serde_json::json!({
                                "id": response_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model,
                                "choices": [{
                                    "index": 0,
                                    "delta": {"content": text},
                                    "finish_reason": null,
                                }],
                            });
                            let _ = tx
                                .send(Ok(Bytes::from(format!("data: {}\n\n", content_chunk))))
                                .await;
                        }
                    }
                    DecodeResult::Done {
                        prompt_tokens: pt,
                        completion_tokens: ct,
                    } => {
                        prompt_tokens = pt;
                        completion_tokens = ct;
                    }
                    DecodeResult::Error { message } => {
                        had_error = Some(message);
                    }
                    DecodeResult::Unknown => {}
                }
            }
            // Remove consumed bytes from pending
            if offset > 0 {
                pending.drain(..offset);
            }
        }

        // Emit error if any
        if let Some(err_msg) = had_error {
            let err_chunk = serde_json::json!({
                "error": {"message": err_msg, "type": "windsurf_error", "code": "upstream_error"},
            });
            let _ = tx
                .send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk))))
                .await;
            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
            return;
        }

        // Unary fallback: nothing streamed but text decoded → emit as one chunk
        if !role_emitted && !total_text.is_empty() {
            let role_chunk = serde_json::json!({
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": ""},
                    "finish_reason": null,
                }],
            });
            let _ = tx
                .send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk))))
                .await;
            let content_chunk = serde_json::json!({
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {"content": total_text},
                    "finish_reason": null,
                }],
            });
            let _ = tx
                .send(Ok(Bytes::from(format!("data: {}\n\n", content_chunk))))
                .await;
        }

        // Emit finish chunk
        let mut finish_payload = serde_json::json!({
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }],
        });
        if prompt_tokens > 0 || completion_tokens > 0 {
            finish_payload["usage"] = serde_json::json!({
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            });
        }
        let _ = tx
            .send(Ok(Bytes::from(format!("data: {}\n\n", finish_payload))))
            .await;
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
    });

    Box::new(ReceiverStream::new(rx))
}

#[async_trait::async_trait]
impl ProviderExecutor for WindsurfExecutor {
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
        // Windsurf is stream-only
        self.execute(conn, body, true).await
    }
}

impl WindsurfExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Windsurf connection missing apiKey or accessToken"))?;

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("claude-sonnet-4.6")
            .to_string();
        let ws_model = resolve_ws_model_id(&model);

        let raw_messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut ws_messages = openai_messages_to_ws(&raw_messages);
        if ws_messages.is_empty() {
            ws_messages.push(WsMessage {
                role: "user".to_string(),
                content: String::new(),
                tool_call_id: None,
            });
        }

        let proto_payload = build_get_chat_message_request(&api_key, &ws_model, &ws_messages);
        let framed_payload = grpc_web_frame(&proto_payload);

        let client = build_client();
        let resp = client
            .post(WS_CHAT_URL)
            .header("Content-Type", "application/grpc-web+proto")
            .header("Accept", "application/grpc-web+proto")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", format!("windsurf/{}", WS_IDE_VERSION))
            .header("X-Grpc-Web", "1")
            .body(framed_payload)
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

        if stream {
            let upstream = resp.bytes_stream();
            let boxed = wrap_windsurf_stream(upstream, model);
            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: boxed,
            })
        } else {
            // Windsurf is stream-only but if called for complete, return raw bytes
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: bytes,
            })
        }
    }
}
