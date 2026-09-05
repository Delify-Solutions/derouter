//! Perplexity Web executor.
//! Port of open-sse/executors/perplexity-web.js.
//!
//! Routes chat completions through the Perplexity web SSE endpoint
//! (https://www.perplexity.ai/rest/sse/perplexity_ask).
//!
//! Auth: web cookie — the `__Secure-next-auth.session-token` cookie value
//! from perplexity.ai is stored in connection.data.apiKey. It is sent as
//! `Cookie: __Secure-next-auth.session-token=<value>`. Alternatively, an
//! `accessToken` may be sent as `Authorization: Bearer <token>`.
//!
//! The request body is transformed from OpenAI chat format to Perplexity's
//! native format, and the response is an SSE stream of `{ blocks: [...] }`
//! frames that are re-emitted as OpenAI chat.completion.chunk SSE.

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use tokio::sync::Mutex;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct PerplexityWebExecutor;

const PPLX_SSE_ENDPOINT: &str = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const PPLX_API_VERSION: &str = "2.18";
const PPLX_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Model map: catalog name → [mode, model_preference]
fn model_map() -> HashMap<&'static str, (&'static str, &'static str)> {
    let mut m = HashMap::new();
    m.insert("pplx-auto", ("concise", "pplx_pro"));
    m.insert("pplx-sonar", ("copilot", "experimental"));
    m.insert("pplx-gpt", ("copilot", "gpt54"));
    m.insert("pplx-gemini", ("copilot", "gemini31pro_high"));
    m.insert("pplx-sonnet", ("copilot", "claude46sonnet"));
    m.insert("pplx-opus", ("copilot", "claude46opus"));
    m.insert("pplx-nemotron", ("copilot", "nv_nemotron_3_super"));
    m
}

fn thinking_map() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("pplx-gpt", "gpt54_thinking");
    m.insert("pplx-sonnet", "claude46sonnetthinking");
    m.insert("pplx-opus", "claude46opusthinking");
    m
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Session cache: FNV-1a hash of conversation history → backend UUID
static SESSION_CACHE: once_cell::sync::Lazy<Mutex<HashMap<String, (String, u64)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

const SESSION_MAX_AGE_MS: u64 = 3600_000;
const SESSION_MAX_ENTRIES: usize = 200;

/// Compute FNV-1a hash of conversation history for session key lookup
fn session_key(history: &[(String, String)]) -> String {
    let parts: Vec<String> = history
        .iter()
        .map(|(role, content)| format!("{}:{}", role, content))
        .collect();
    let joined = parts.join("\n");
    let mut hash: u32 = 0x811c9dc5;
    for b in joined.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{:08x}", hash)
}

async fn session_lookup(history: &[(String, String)]) -> Option<String> {
    if history.is_empty() {
        return None;
    }
    let key = session_key(history);
    let cache = SESSION_CACHE.lock().await;
    if let Some((backend_uuid, ts)) = cache.get(&key) {
        if now_ms().saturating_sub(*ts) < SESSION_MAX_AGE_MS {
            return Some(backend_uuid.clone());
        }
    }
    None
}

async fn session_store(
    history: &[(String, String)],
    current_msg: &str,
    response_text: &str,
    backend_uuid: &str,
) {
    if backend_uuid.is_empty() {
        return;
    }
    let mut full = history.to_vec();
    full.push(("user".to_string(), current_msg.to_string()));
    full.push(("assistant".to_string(), response_text.to_string()));
    let key = session_key(&full);
    let mut cache = SESSION_CACHE.lock().await;
    if cache.len() >= SESSION_MAX_ENTRIES {
        // Evict oldest entry
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, (_, ts))| *ts)
            .map(|(k, _)| k.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(key, (backend_uuid.to_string(), now_ms()));
}

/// Clean response text: strip XML declarations, citations, grok tags, etc.
fn clean_response(text: &str) -> String {
    let mut t = text.to_string();
    // Strip XML declarations
    if let Some(idx) = t.find("<?xml") {
        if let Some(end) = t[idx..].find("?>") {
            t.replace_range(idx..idx + end + 2, "");
        }
    }
    // Strip [N] citations
    let re: regex_like::CitationStripper = regex_like::CitationStripper;
    t = re.strip(&t);
    t.trim().to_string()
}

mod regex_like {
    /// Minimal inline citation stripper: removes [digit+] patterns
    pub struct CitationStripper;
    impl CitationStripper {
        pub fn strip(&self, text: &str) -> String {
            let mut result = String::with_capacity(text.len());
            let chars: Vec<char> = text.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                if chars[i] == '[' {
                    let mut j = i + 1;
                    let mut is_digit = false;
                    while j < chars.len() && chars[j].is_ascii_digit() {
                        is_digit = true;
                        j += 1;
                    }
                    if is_digit && j < chars.len() && chars[j] == ']' {
                        i = j + 1;
                        continue;
                    }
                }
                result.push(chars[i]);
                i += 1;
            }
            result
        }
    }
}

/// Parse OpenAI messages into system text, history, and current message.
struct ParsedMessages {
    system_msg: String,
    history: Vec<(String, String)>,
    current_msg: String,
}

fn parse_openai_messages(messages: &serde_json::Value) -> ParsedMessages {
    let mut system_msg = String::new();
    let mut history: Vec<(String, String)> = Vec::new();

    let empty_msgs = Vec::new();
    let msgs = messages.as_array().unwrap_or(&empty_msgs);
    for msg in msgs {
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .to_string();
        let role = if role == "developer" {
            "system".to_string()
        } else {
            role
        };

        let content = if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
            s.to_string()
        } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|c| {
                    if c.get("type").and_then(|v| v.as_str()) == Some("text") {
                        c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            String::new()
        };

        if content.trim().is_empty() {
            continue;
        }

        if role == "system" {
            system_msg.push_str(&content);
            system_msg.push('\n');
        } else if role == "user" || role == "assistant" {
            history.push((role, content));
        }
    }

    let mut current_msg = String::new();
    if let Some(last) = history.last() {
        if last.0 == "user" {
            current_msg = history.pop().unwrap().1;
        }
    }

    ParsedMessages {
        system_msg,
        history,
        current_msg,
    }
}

/// Build the Perplexity web request body.
fn build_pplx_request_body(
    query: &str,
    mode: &str,
    model_pref: &str,
    follow_up_uuid: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "query_str": query,
        "params": {
            "query_str": query,
            "search_focus": "internet",
            "mode": mode,
            "model_preference": model_pref,
            "sources": ["web"],
            "attachments": [],
            "frontend_uuid": uuid::Uuid::new_v4().to_string(),
            "frontend_context_uuid": uuid::Uuid::new_v4().to_string(),
            "version": PPLX_API_VERSION,
            "language": "en-US",
            "timezone": "UTC",
            "search_recency_filter": null,
            "is_incognito": true,
            "use_schematized_api": true,
            "last_backend_uuid": follow_up_uuid,
        },
    })
}

/// Format tools hint for the query
fn format_tools_hint(tools: &serde_json::Value) -> String {
    let arr = match tools.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return String::new(),
    };
    let lines: Vec<String> = arr
        .iter()
        .map(|t| {
            let f = t
                .get("function")
                .unwrap_or(t);
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed");
            let desc = f
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .split('\n')
                .next()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect::<String>();
            format!("- {}: {}", name, desc)
        })
        .collect();
    format!(
        "Available tools (reference only, cannot invoke):\n{}",
        lines.join("\n")
    )
}

/// Build the query string from parsed messages
fn build_query(parsed: &ParsedMessages, follow_up_uuid: Option<&str>, tools: &serde_json::Value) -> String {
    if follow_up_uuid.is_some() {
        return parsed.current_msg.clone();
    }
    let mut obj = serde_json::Map::new();
    let mut instr = Vec::new();
    if !parsed.system_msg.trim().is_empty() {
        instr.push(parsed.system_msg.trim().to_string());
    }
    let hint = format_tools_hint(tools);
    if !hint.is_empty() {
        instr.push(hint);
    }
    instr.push(
        "You have built-in web search. Answer questions directly using search results."
            .to_string(),
    );
    obj.insert("instructions".to_string(), serde_json::Value::String(instr.join("\n")));
    if !parsed.history.is_empty() {
        let hist: Vec<serde_json::Value> = parsed
            .history
            .iter()
            .map(|(role, content)| serde_json::json!({"role": role, "content": content}))
            .collect();
        obj.insert("history".to_string(), serde_json::Value::Array(hist));
    }
    if !parsed.current_msg.is_empty() {
        obj.insert("query".to_string(), serde_json::Value::String(parsed.current_msg.clone()));
    } else if parsed.history.is_empty() {
        obj.insert("query".to_string(), serde_json::Value::String("".to_string()));
    }
    let json = serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default();
    if json.len() > 96000 {
        json[json.len() - 96000..].to_string()
    } else {
        json
    }
}

/// Read Pplx SSE events from the upstream response body
enum PplxEvent {
    Delta(String),
    Thinking(String),
    Error(String),
    Done,
    BackendUuid(String),
}

fn extract_content_from_events(
    upstream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin + 'static,
    model: String,
    cid: String,
    created: u64,
    history: Vec<(String, String)>,
    current_msg: String,
) -> Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);

    tokio::spawn(async move {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut done = false;
        let mut full_answer = String::new();
        let mut resp_backend_uuid = String::new();
        let mut data_lines: Vec<String> = Vec::new();

        // Emit initial role chunk
        let role_chunk = serde_json::json!({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "system_fingerprint": null,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant"},
                "finish_reason": null,
                "logprobs": null,
            }],
        });
        let _ = tx
            .send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk))))
            .await;

        fn flush_data_lines(
            data_lines: &mut Vec<String>,
        ) -> Option<serde_json::Value> {
            if data_lines.is_empty() {
                return None;
            }
            let payload = data_lines.join("\n");
            data_lines.clear();
            let trimmed = payload.trim();
            if trimmed.is_empty() || trimmed == "[DONE]" {
                return None;
            }
            serde_json::from_str(trimmed).ok()
        }

        while !done {
            // Process complete lines from buffer
            while let Some(nl) = buffer.find('\n') {
                let line = buffer[..nl].to_string();
                buffer = buffer[nl + 1..].to_string();
                let line = line.trim_end_matches('\r').to_string();

                if line.is_empty() {
                    // Flush accumulated data lines
                    if let Some(parsed) = flush_data_lines(&mut data_lines) {
                        // Check for error
                        if let Some(err_code) = parsed.get("error_code").and_then(|v| v.as_u64()) {
                            let err_msg = parsed
                                .get("error_message")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&format!("Perplexity error: {}", err_code))
                                .to_string();
                            let chunk = serde_json::json!({
                                "id": cid,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model,
                                "choices": [{
                                    "index": 0,
                                    "delta": {"content": format!("[Error: {}]", err_msg)},
                                    "finish_reason": null,
                                    "logprobs": null,
                                }],
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", chunk)))).await;
                            done = true;
                            break;
                        }

                        if let Some(buuid) = parsed.get("backend_uuid").and_then(|v| v.as_str()) {
                            resp_backend_uuid = buuid.to_string();
                        }

                        // Process blocks
                        if let Some(blocks) = parsed.get("blocks").and_then(|v| v.as_array()) {
                            for block in blocks {
                                let usage = block
                                    .get("intended_usage")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                // Thinking steps
                                if usage == "pro_search_steps" {
                                    if let Some(plan) = block.get("plan_block") {
                                        if let Some(steps) = plan.get("steps").and_then(|v| v.as_array()) {
                                            for step in steps {
                                                let stype = step.get("step_type").and_then(|v| v.as_str()).unwrap_or("");
                                                if stype == "SEARCH_WEB" {
                                                    if let Some(queries) = step
                                                        .get("search_web_content")
                                                        .and_then(|v| v.get("queries"))
                                                        .and_then(|v| v.as_array())
                                                    {
                                                        for q in queries {
                                                            let qr = q.get("query").and_then(|v| v.as_str()).unwrap_or("");
                                                            if !qr.is_empty() {
                                                                let chunk = serde_json::json!({
                                                                    "id": cid,
                                                                    "object": "chat.completion.chunk",
                                                                    "created": created,
                                                                    "model": model,
                                                                    "choices": [{
                                                                        "index": 0,
                                                                        "delta": {"reasoning_content": format!("Searching: {}\n", qr)},
                                                                        "finish_reason": null,
                                                                        "logprobs": null,
                                                                    }],
                                                                });
                                                                let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", chunk)))).await;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                // Markdown content
                                if !usage.contains("markdown") {
                                    continue;
                                }
                                let mb = match block.get("markdown_block") {
                                    Some(mb) => mb,
                                    None => continue,
                                };
                                let empty_chunks = Vec::new();
                                let chunks = mb.get("chunks").and_then(|v| v.as_array()).unwrap_or(&empty_chunks);
                                if chunks.is_empty() {
                                    continue;
                                }
                                let progress = mb.get("progress").and_then(|v| v.as_str()).unwrap_or("");
                                let chunk_text = chunks
                                    .iter()
                                    .filter_map(|c| c.as_str())
                                    .collect::<Vec<_>>()
                                    .join("");
                                if progress == "DONE" {
                                    full_answer = chunk_text.clone();
                                } else {
                                    let delta = format!("{}{}", full_answer, chunk_text);
                                    if !delta.is_empty() {
                                        full_answer = delta.clone();
                                        let chunk = serde_json::json!({
                                            "id": cid,
                                            "object": "chat.completion.chunk",
                                            "created": created,
                                            "model": model,
                                            "choices": [{
                                                "index": 0,
                                                "delta": {"content": delta},
                                                "finish_reason": null,
                                                "logprobs": null,
                                            }],
                                        });
                                        let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", chunk)))).await;
                                    }
                                }
                            }
                        }

                        // Top-level text
                        if parsed.get("blocks").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
                            if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
                                let t = text.trim();
                                if !t.is_empty() {
                                    full_answer = t.to_string();
                                    let chunk = serde_json::json!({
                                        "id": cid,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": model,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {"content": t},
                                            "finish_reason": null,
                                            "logprobs": null,
                                        }],
                                    });
                                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", chunk)))).await;
                                }
                            }
                        }

                        if parsed.get("final").and_then(|v| v.as_bool()) == Some(true)
                            || parsed.get("status").and_then(|v| v.as_str()) == Some("COMPLETED")
                        {
                            done = true;
                            break;
                        }
                    }
                    continue;
                }

                if line.starts_with("data:") {
                    data_lines.push(line[5..].trim_start().to_string());
                }
                if line == "event: end_of_stream" {
                    done = true;
                    break;
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
                None => break,
            }
        }

        // Emit finish chunk
        let finish_chunk = serde_json::json!({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "system_fingerprint": null,
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

        // Store session
        session_store(&history, &current_msg, &clean_response(&full_answer), &resp_backend_uuid).await;
    });

    Box::new(ReceiverStream::new(rx))
}

#[async_trait::async_trait]
impl ProviderExecutor for PerplexityWebExecutor {
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
        // Perplexity web is stream-only; route complete through stream
        self.execute(conn, body, true).await
    }
}

impl PerplexityWebExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let messages = body.get("messages").and_then(|v| v.as_array());
        let messages = match messages {
            Some(m) if !m.is_empty() => m,
            _ => {
                return Ok(UpstreamResponse::Error {
                    status: StatusCode::BAD_REQUEST,
                    message: r#"{"error":{"message":"Missing or empty messages array","type":"invalid_request"}}"#
                        .to_string(),
                });
            }
        };

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("pplx-auto")
            .to_string();

        let thinking = body.get("thinking").and_then(|v| v.as_bool()) == Some(true)
            || body
                .get("reasoning_effort")
                .and_then(|v| v.as_str())
                .map(|s| s != "none")
                .unwrap_or(false);

        // Resolve mode and model preference
        let thinking_map = thinking_map();
        let model_map = model_map();
        let (pplx_mode, model_pref) = if thinking {
            if let Some(&pref) = thinking_map.get(model.as_str()) {
                ("copilot".to_string(), pref.to_string())
            } else if let Some(&(mode, pref)) = model_map.get(model.as_str()) {
                (mode.to_string(), pref.to_string())
            } else {
                ("copilot".to_string(), model.clone())
            }
        } else if let Some(&(mode, pref)) = model_map.get(model.as_str()) {
            (mode.to_string(), pref.to_string())
        } else {
            ("copilot".to_string(), model.clone())
        };

        // Parse OpenAI messages
        let parsed = parse_openai_messages(&serde_json::Value::Array(messages.clone()));
        let follow_up_uuid = session_lookup(&parsed.history).await;

        let query = build_query(&parsed, follow_up_uuid.as_deref(), body.get("tools").unwrap_or(&serde_json::Value::Null));
        if query.trim().is_empty() {
            return Ok(UpstreamResponse::Error {
                status: StatusCode::BAD_REQUEST,
                message: r#"{"error":{"message":"Empty query after processing","type":"invalid_request"}}"#
                    .to_string(),
            });
        }

        let pplx_body = build_pplx_request_body(&query, &pplx_mode, &model_pref, follow_up_uuid.as_deref());

        // Build headers
        let cookie = get_connection_auth(&conn.data);
        let access_token = conn
            .data
            .get("accessToken")
            .or_else(|| conn.data.get("access_token"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let client = build_client();
        let mut req = client
            .post(PPLX_SSE_ENDPOINT)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("Origin", "https://www.perplexity.ai")
            .header("Referer", "https://www.perplexity.ai/")
            .header("User-Agent", PPLX_USER_AGENT)
            .header("X-App-ApiClient", "default")
            .header("X-App-ApiVersion", PPLX_API_VERSION);

        if let Some(ref token) = access_token {
            req = req.header("Authorization", format!("Bearer {}", token));
        } else if let Some(ref ck) = cookie {
            req = req.header(
                "Cookie",
                format!("__Secure-next-auth.session-token={}", ck),
            );
        } else {
            return Ok(UpstreamResponse::Error {
                status: StatusCode::UNAUTHORIZED,
                message: r#"{"error":{"message":"Perplexity Web connection missing apiKey (session cookie) or accessToken","type":"auth_error"}}"#
                    .to_string(),
            });
        }

        let resp = req.json(&pplx_body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let _text = resp.text().await.unwrap_or_default();
            let msg = match status.as_u16() {
                401 | 403 => "Perplexity auth failed — session cookie may be expired. Re-paste your __Secure-next-auth.session-token.".to_string(),
                429 => "Perplexity rate limited. Wait a moment and retry.".to_string(),
                _ => format!("Perplexity returned HTTP {}", status.as_u16()),
            };
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: serde_json::json!({"error":{"message":msg,"type":"upstream_error","code":format!("HTTP_{}",status.as_u16())}}).to_string(),
            });
        }

        let cid = format!("chatcmpl-pplx-{}", &uuid::Uuid::new_v4().to_string()[..12]);
        let created = now_secs();

        if stream {
            let upstream = resp.bytes_stream();
            let boxed = extract_content_from_events(
                upstream,
                model,
                cid,
                created,
                parsed.history,
                parsed.current_msg,
            );
            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: boxed,
            })
        } else {
            // Aggressive non-streaming: collect all events and assemble a single JSON response
            // Perplexity web is stream-only, so we aggregate
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: bytes,
            })
        }
    }
}
