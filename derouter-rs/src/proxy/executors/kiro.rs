//! Kiro executor — port of open-sse/executors/kiro.js.
//!
//! Sends requests to the AWS CodeWhisperer / Kiro AI streaming API using AWS EventStream
//! binary format. Translates OpenAI requests via the translator layer
//! (`openai_to_kiro_request`), handles token refresh, and transforms the binary
//! EventStream response into OpenAI-shaped SSE chunks.
//!
//! Auth modes supported:
//! - API key (`authMethod: "api_key"`) — Bearer + `TokenType: API_KEY`, uses amazonaws.com surface
//! - External IdP (`authMethod: "external_idp"`) — Bearer + `TokenType: EXTERNAL_IDP`
//! - AWS SSO / IDC (`authMethod: "idc"`) — Bearer, uses amazonaws.com surface
//! - Social (builder-id, google, github) — Bearer, uses kiro.dev surface
//! - AWS SSO OIDC (clientId + clientSecret) — refreshed via kiro_token module
//!
//! The executor resolves the Kiro model (stripping `-agentic` / `-thinking` suffixes),
//! selects an endpoint based on auth method, sends the JSON body, and parses the
//! EventStream binary response into OpenAI SSE chunks.
//!
//! The integrity gate / repair retry logic from Node is NOT ported — it is a
//! multi-attempt buffer-and-retry system that requires complex streaming state.
//! This executor does a single attempt and returns the result. The integrity gate
//! can be added in a future phase if needed.

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::StreamExt;
use serde_json::Value;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use super::kiro_token;
use crate::db::repos::connections::ProviderConnection;
use crate::proxy::translator::openai_kiro::openai_to_kiro_request;

pub struct KiroExecutor;

const KIRO_BASE_URLS: &[&str] = &[
    "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
];

const KIRO_CODEWHISPERER_TARGET: &str =
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const KIRO_DEFAULT_PROFILE_ARNS: &[(&str, &str)] = &[
    ("builder-id", "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"),
    ("social", "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK"),
];

/// Max EventStream message bytes (24 MiB) — matches the JS constant.
const EVENTSTREAM_MAX_MESSAGE_BYTES: usize = 24 * 1024 * 1024;
/// Max EventStream headers bytes (128 KiB) — matches the JS constant.
const EVENTSTREAM_MAX_HEADERS_BYTES: usize = 128 * 1024;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Mask a token for safe inclusion in error/log messages.
fn mask_token(token: &str) -> String {
    if token.len() <= 4 {
        "****".to_string()
    } else {
        format!("****{}****", &token[token.len() / 2 - 2..token.len() / 2 + 2])
    }
}

/// Resolve a Kiro model id, stripping `-agentic` and `-thinking` suffixes.
/// Returns (upstream_model, is_agentic, is_thinking).
///
/// Handles `-thinking-agentic` suffix: agentic is checked first (matches the JS
/// `resolveKiroModel` which checks agentic before thinking).
fn resolve_kiro_model(model: &str) -> (String, bool, bool) {
    let mut upstream = model.to_string();
    let mut agentic = false;
    let mut thinking = false;

    if upstream.ends_with("-agentic") {
        agentic = true;
        upstream = upstream[..upstream.len() - "-agentic".len()].to_string();
    }
    if upstream.ends_with("-thinking") {
        thinking = true;
        upstream = upstream[..upstream.len() - "-thinking".len()].to_string();
    }

    (upstream, agentic, thinking)
}

/// Resolve the profileArn for a given auth method (falls back to defaults).
/// For api_key/idc/external_idp, only send an explicit profileArn (no default fallback).
fn resolve_profile_arn(psd: &Value) -> Option<String> {
    let auth_method = psd.get("authMethod").and_then(|v| v.as_str()).unwrap_or("");
    let account_bound = auth_method == "api_key" || auth_method == "idc" || auth_method == "external_idp";

    // Explicit profileArn takes priority
    if let Some(p) = psd.get("profileArn").and_then(|v| v.as_str()) {
        if !p.is_empty() {
            return Some(p.to_string());
        }
    }

    // For account-bound auth, don't fall back to default ARN (causes 403)
    if account_bound {
        return None;
    }

    // For social (google/github) and builder-id, use the shared default
    let is_social = auth_method == "google" || auth_method == "github";
    KIRO_DEFAULT_PROFILE_ARNS
        .iter()
        .find(|(key, _)| {
            if is_social {
                *key == "social"
            } else {
                *key == "builder-id"
            }
        })
        .map(|(_, arn)| arn.to_string())
}

/// Get ordered base URLs based on auth method.
/// API key / external_idp / idc connections prefer amazonaws.com surfaces.
fn get_ordered_base_urls(psd: &Value) -> Vec<String> {
    let auth_method = psd.get("authMethod").and_then(|v| v.as_str()).unwrap_or("");
    let is_cw_surface = auth_method == "api_key" || auth_method == "external_idp" || auth_method == "idc";

    if !is_cw_surface {
        return KIRO_BASE_URLS.iter().map(|s| s.to_string()).collect();
    }

    let region = psd
        .get("region")
        .and_then(|v| v.as_str())
        .unwrap_or("us-east-1")
        .trim()
        .to_string();

    // Regionalize URLs: replace the region in amazonaws.com hosts.
    // e.g. "https://codewhisperer.us-east-1.amazonaws.com/..." -> "...codewhisperer.{region}.amazonaws.com/..."
    let regionalize = |u: &str| -> String {
        if region != "us-east-1" && u.contains("amazonaws.com") {
            // Replace the first region segment (between '.' and '.amazonaws.com')
            // Pattern: <service>.<region>.amazonaws.com
            if let Some(start) = u.find("://") {
                let host_start = start + 3;
                if let Some(aws_pos) = u[host_start..].find(".amazonaws.com") {
                    let abs_aws_pos = host_start + aws_pos;
                    let host_region = &u[host_start..abs_aws_pos];
                    // Find the last '.' in the host before amazonaws.com — that's the region
                    if let Some(dot) = host_region.rfind('.') {
                        let service = &host_region[..dot];
                        let old_region = &host_region[dot + 1..];
                        if !old_region.is_empty() && old_region != region {
                            return format!(
                                "{}://{}.{}.amazonaws.com{}",
                                &u[..start].trim_end_matches("://"),
                                service,
                                region,
                                &u[abs_aws_pos + ".amazonaws.com".len()..]
                            );
                        }
                    }
                }
            }
            u.to_string()
        } else {
            u.to_string()
        }
    };

    let amazon: Vec<String> = KIRO_BASE_URLS
        .iter()
        .filter(|u| u.contains("amazonaws.com"))
        .map(|u| regionalize(u))
        .collect();
    let others: Vec<String> = KIRO_BASE_URLS
        .iter()
        .filter(|u| !u.contains("amazonaws.com"))
        .map(|s| s.to_string())
        .collect();

    if auth_method == "api_key" {
        let q: Vec<String> = amazon.iter().filter(|u| u.contains("://q.")).cloned().collect();
        let remaining: Vec<String> = amazon.iter().filter(|u| !u.contains("://q.")).cloned().collect();
        if !q.is_empty() {
            return [q, remaining, others].concat();
        }
    }

    if !amazon.is_empty() {
        return [amazon, others].concat();
    }

    KIRO_BASE_URLS.iter().map(|s| s.to_string()).collect()
}

/// Build the request headers for a Kiro upstream request.
fn build_kiro_headers(
    access_token: &str,
    psd: &Value,
    url: &str,
) -> reqwest::header::HeaderMap {
    let auth_method = psd.get("authMethod").and_then(|v| v.as_str()).unwrap_or("");
    let is_api_key = auth_method == "api_key";
    let is_external_idp = auth_method == "external_idp";

    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    headers.insert("Accept", "application/vnd.amazon.eventstream".parse().unwrap());
    headers.insert(
        "User-Agent",
        "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0".parse().unwrap(),
    );
    headers.insert(
        "X-Amz-User-Agent",
        "aws-sdk-js/3.0.0 kiro-ide/1.0.0".parse().unwrap(),
    );
    headers.insert("Amz-Sdk-Request", "attempt=1; max=3".parse().unwrap());
    headers.insert(
        "Amz-Sdk-Invocation-Id",
        uuid::Uuid::new_v4().to_string().parse().unwrap(),
    );

    // Kiro-specific fingerprint headers (from kiroModels.js buildKiroFingerprintHeaders)
    headers.insert("x-amzn-kiro-agent-mode", "vibe".parse().unwrap());
    headers.insert("x-amzn-codewhisperer-optout", "true".parse().unwrap());

    // X-Amz-Target header for CodeWhisperer surface
    if url.contains("://codewhisperer.") || url.contains("://q.") {
        headers.insert("X-Amz-Target", KIRO_CODEWHISPERER_TARGET.parse().unwrap());
    }

    headers.insert(
        "Authorization",
        format!("Bearer {}", access_token).parse().unwrap(),
    );

    if is_api_key {
        headers.insert("TokenType", "API_KEY".parse().unwrap());
    } else if is_external_idp {
        headers.insert("TokenType", "EXTERNAL_IDP".parse().unwrap());
    }

    headers
}

/// Inject profileArn into the translated Kiro request body.
fn inject_profile_arn(kiro_body: &mut Value, psd: &Value) {
    if let Some(arn) = resolve_profile_arn(psd) {
        if !arn.is_empty() {
            if let Some(obj) = kiro_body.as_object_mut() {
                obj.insert("profileArn".to_string(), Value::String(arn));
            }
        }
    }
}

/// Parse an AWS EventStream frame.
/// Returns (headers_map, payload_json) or an error.
///
/// The frame format is:
///   [4 bytes total_length] [4 bytes headers_length] [4 bytes prelude_crc]
///   [headers_length bytes headers]
///   [payload bytes]
///   [4 bytes message_crc]
fn parse_event_frame(data: &[u8]) -> Result<(HashMap<String, Value>, Option<Value>), String> {
    if data.len() < 16 {
        return Err("AWS EventStream frame is shorter than 16 bytes".to_string());
    }

    let total_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let headers_length = u32::from_be_bytes([data[4], data[5], data[6], data[7]]) as usize;

    if total_length != data.len() {
        return Err("AWS EventStream frame length does not match its prelude".to_string());
    }
    if total_length > EVENTSTREAM_MAX_MESSAGE_BYTES
        || headers_length > EVENTSTREAM_MAX_HEADERS_BYTES
        || headers_length > total_length - 16
    {
        return Err("AWS EventStream frame bounds are invalid".to_string());
    }

    // CRC32 of prelude (first 8 bytes) — uses the same polynomial as JS (0xedb88320)
    let prelude_crc = crc32fast::hash(&data[0..8]);
    let stored_prelude_crc = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    if prelude_crc != stored_prelude_crc {
        return Err("AWS EventStream prelude CRC mismatch".to_string());
    }

    // CRC32 of everything except the last 4 bytes
    let msg_crc = crc32fast::hash(&data[0..total_length - 4]);
    let stored_msg_crc = u32::from_be_bytes([
        data[total_length - 4],
        data[total_length - 3],
        data[total_length - 2],
        data[total_length - 1],
    ]);
    if msg_crc != stored_msg_crc {
        return Err("AWS EventStream message CRC mismatch".to_string());
    }

    let mut headers = HashMap::new();
    let mut offset = 12;
    let header_end = 12 + headers_length;

    while offset < header_end {
        if offset + 1 > header_end {
            return Err("AWS EventStream header exceeds its declared bounds".to_string());
        }
        let name_length = data[offset] as usize;
        offset += 1;
        if offset + name_length + 1 > header_end {
            return Err("AWS EventStream header exceeds its declared bounds".to_string());
        }
        let name = String::from_utf8_lossy(&data[offset..offset + name_length]).to_string();
        offset += name_length;
        let type_byte = data[offset];
        offset += 1;

        match type_byte {
            0 | 1 => {
                headers.insert(name, Value::Bool(type_byte == 1));
            }
            2 => {
                if offset + 1 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                headers.insert(name, Value::Number((data[offset] as i8).into()));
                offset += 1;
            }
            3 => {
                if offset + 2 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                let val = i16::from_be_bytes([data[offset], data[offset + 1]]);
                headers.insert(name, Value::Number(val.into()));
                offset += 2;
            }
            4 => {
                if offset + 4 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                let val = i32::from_be_bytes([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3],
                ]);
                headers.insert(name, Value::Number(val.into()));
                offset += 4;
            }
            5 | 8 => {
                if offset + 8 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                // Skip 64-bit values (we don't use these types)
                offset += 8;
            }
            6 | 7 => {
                if offset + 2 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                let value_length =
                    u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
                offset += 2;
                if offset + value_length > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                let bytes = &data[offset..offset + value_length];
                if type_byte == 7 {
                    let s = String::from_utf8_lossy(bytes).to_string();
                    headers.insert(name, Value::String(s));
                }
                // type 6: raw bytes — we only care about string headers
                offset += value_length;
            }
            9 => {
                if offset + 16 > header_end {
                    return Err("AWS EventStream header exceeds its declared bounds".to_string());
                }
                offset += 16;
            }
            _ => {
                return Err(format!(
                    "AWS EventStream header {} has unknown type {}",
                    name, type_byte
                ));
            }
        }
    }

    let payload_bytes = &data[header_end..total_length - 4];
    if payload_bytes.is_empty() {
        return Ok((headers, None));
    }
    let payload_text = String::from_utf8_lossy(payload_bytes);
    if payload_text.trim().is_empty() {
        return Ok((headers, None));
    }
    let payload: Value = serde_json::from_str(&payload_text)
        .map_err(|e| format!("AWS EventStream payload is not valid JSON: {}", e))?;
    Ok((headers, Some(payload)))
}

/// Build an OpenAI SSE chunk string.
fn sse_chunk(
    response_id: &str,
    created: u64,
    model: &str,
    delta: Value,
    finish_reason: Option<&str>,
    usage: Option<&Value>,
) -> String {
    let mut chunk = serde_json::json!({
        "id": response_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }]
    });

    if let Some(u) = usage {
        chunk["usage"] = u.clone();
    }

    format!(
        "data: {}\n\n",
        serde_json::to_string(&chunk).unwrap_or_default()
    )
}

/// Encode an SSE error event.
fn encode_sse_error(code: &str, message: &str) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({
            "error": {
                "message": message,
                "type": "upstream_error",
                "code": code,
            }
        })
    )
}

/// Normalize a stop reason string (camelCase -> snake_case, normalize variants).
fn normalize_stop_reason(value: &str) -> String {
    // Convert camelCase to snake_case, replace spaces/dashes with underscores
    let mut result = String::new();
    for (i, c) in value.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                result.push('_');
            }
            result.push(c.to_ascii_lowercase());
        } else if c == ' ' || c == '-' {
            result.push('_');
        } else {
            result.push(c);
        }
    }

    let reason = result.trim_start_matches('_').to_string();

    match reason.as_str() {
        "endturn" | "end_turn" | "stop" | "stop_sequence" => "end_turn".to_string(),
        "tooluse" | "tool_use" | "tool_calls" => "tool_use".to_string(),
        "maxtokens" | "max_tokens" | "max_output_tokens" | "length" => "max_tokens".to_string(),
        _ => reason,
    }
}

/// Determine the disposition of a stop reason.
/// Ports the JS `stopDisposition` function for the core cases.
fn stop_disposition(stop_reason: &str, has_tool_calls: bool) -> &'static str {
    match stop_reason {
        "malformed_model_output" | "invalid_model_output" => "retryable_protocol_failure",
        "cancelled" | "pause_turn" | "model_context_window_exceeded" => "terminal_incomplete",
        "refusal" => "terminal_refusal",
        "max_tokens" => {
            if has_tool_calls {
                "terminal_incomplete"
            } else {
                "length"
            }
        }
        "end_turn" | "tool_use" => {
            if has_tool_calls || stop_reason == "tool_use" {
                "tool_use"
            } else {
                "complete"
            }
        }
        "" => "complete",
        _ => {
            // Check for content filter / guardrail / safety / policy / blocked
            let lower = stop_reason.to_lowercase();
            if lower.contains("content")
                && lower.contains("filter")
                || lower.contains("guardrail")
                || lower.contains("safety")
                || lower.contains("policy")
                || lower.contains("blocked")
            {
                "terminal_refusal"
            } else {
                "unknown_failure"
            }
        }
    }
}

// ── EventStream processing state ─────────────────────────────────────────────

struct ToolEntry {
    id: String,
    name: String,
    input_chunks: Vec<String>,
}

struct EventStreamState {
    buffer: Vec<u8>,
    chunk_index: u64,
    tool_counter: u64,
    tools: HashMap<String, ToolEntry>,
    has_text: bool,
    has_reasoning: bool,
    has_tool_calls: bool,
    saw_tool_use: bool,
    explicit_stop: bool,
    stop_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
    in_thinking: bool,
    total_content_length: usize,
    context_usage_percentage: f64,
    has_context_usage: bool,
    has_metering: bool,
}

impl EventStreamState {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            chunk_index: 0,
            tool_counter: 0,
            tools: HashMap::new(),
            has_text: false,
            has_reasoning: false,
            has_tool_calls: false,
            saw_tool_use: false,
            explicit_stop: false,
            stop_reason: None,
            usage: None,
            finished: false,
            in_thinking: false,
            total_content_length: 0,
            context_usage_percentage: 0.0,
            has_context_usage: false,
            has_metering: false,
        }
    }
}

/// Process a single EventStream event, emitting SSE chunks to `output`.
fn process_event(
    headers: &HashMap<String, Value>,
    payload: &Option<Value>,
    state: &mut EventStreamState,
    response_id: &str,
    created: u64,
    model: &str,
    output: &mut String,
) {
    if state.finished {
        return;
    }

    let message_type = headers
        .get(":message-type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if message_type == "error" || message_type == "exception" {
        let msg = payload
            .as_ref()
            .and_then(|p| p.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Kiro upstream error");
        output.push_str(&encode_sse_error("kiro_upstream_eventstream_error", msg));
        state.finished = true;
        return;
    }

    let event_type = headers
        .get(":event-type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if event_type == "assistantResponseEvent" {
        if let Some(p) = payload {
            let mut content = p
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Handle <thinking> blocks — strip them from the content stream
            if state.in_thinking {
                if let Some(end) = content.find("</thinking>") {
                    state.in_thinking = false;
                    content = content[end + 11..].trim_start_matches('\n').to_string();
                } else {
                    content = String::new();
                }
            } else if let Some(start) = content.find("<thinking>") {
                if let Some(end) = content.find("</thinking>") {
                    content = format!(
                        "{}{}",
                        &content[..start],
                        &content[end + 11..].trim_start_matches('\n')
                    );
                } else {
                    state.in_thinking = true;
                    content = content[..start].to_string();
                }
            }

            if !content.is_empty() || !state.has_reasoning {
                if !content.is_empty() {
                    state.has_text = true;
                }
                state.total_content_length += content.len();
                let delta = if state.chunk_index == 0 {
                    serde_json::json!({ "role": "assistant", "content": content })
                } else {
                    serde_json::json!({ "content": content })
                };
                output.push_str(&sse_chunk(response_id, created, model, delta, None, None));
                state.chunk_index += 1;
            }
        }
    } else if event_type == "reasoningContentEvent" {
        if let Some(p) = payload {
            let content = if let Some(s) = p.as_str() {
                s.to_string()
            } else {
                p.get("text")
                    .or_else(|| p.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            if !content.is_empty() {
                state.has_reasoning = true;
                state.total_content_length += content.len();
                let delta = if state.chunk_index == 0 {
                    serde_json::json!({ "role": "assistant", "reasoning_content": content })
                } else {
                    serde_json::json!({ "reasoning_content": content })
                };
                output.push_str(&sse_chunk(response_id, created, model, delta, None, None));
                state.chunk_index += 1;
            }
        }
    } else if event_type == "codeEvent" {
        if let Some(p) = payload {
            if let Some(content) = p.get("content").and_then(|v| v.as_str()) {
                state.total_content_length += content.len();
                let delta = if state.chunk_index == 0 {
                    serde_json::json!({ "role": "assistant", "content": content })
                } else {
                    serde_json::json!({ "content": content })
                };
                output.push_str(&sse_chunk(response_id, created, model, delta, None, None));
                state.chunk_index += 1;
            }
        }
    } else if event_type == "toolUseEvent" {
        state.saw_tool_use = true;
        if let Some(p) = payload {
            let values: Vec<&Value> = if let Some(arr) = p.as_array() {
                arr.iter().collect()
            } else {
                vec![p]
            };

            for value in &values {
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() {
                    continue;
                }

                let id = value
                    .get("toolUseId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("call_{}_{}", created, state.tools.len() + 1));

                let tool =
                    state
                        .tools
                        .entry(id.clone())
                        .or_insert_with(|| ToolEntry {
                            id: id.clone(),
                            name: name.clone(),
                            input_chunks: Vec::new(),
                        });

                if let Some(input) = value.get("input") {
                    if let Some(s) = input.as_str() {
                        tool.input_chunks.push(s.to_string());
                    } else if input.is_object() {
                        tool.input_chunks
                            .push(serde_json::to_string(input).unwrap_or_default());
                    }
                }
            }
        }
    } else if event_type == "messageStopEvent" {
        state.explicit_stop = true;
        let reason = payload
            .as_ref()
            .and_then(|p| {
                p.get("stopReason")
                    .or_else(|| p.get("stop_reason"))
                    .and_then(|v| v.as_str())
            })
            .map(|s| normalize_stop_reason(s))
            .unwrap_or_else(|| {
                if state.saw_tool_use {
                    "tool_use".to_string()
                } else {
                    "end_turn".to_string()
                }
            });
        state.stop_reason = Some(reason);
    } else if event_type == "metadataEvent" || event_type == "MetadataEvent" {
        if let Some(p) = payload {
            let metadata = p
                .get("metadataEvent")
                .or_else(|| p.get("metadata"))
                .unwrap_or(p);
            let reason = metadata
                .get("stopReason")
                .or_else(|| metadata.get("stop_reason"))
                .and_then(|v| v.as_str())
                .map(|s| normalize_stop_reason(s));
            if let Some(r) = reason {
                state.explicit_stop = true;
                state.stop_reason = Some(r);
            }
        }
    } else if event_type == "contextUsageEvent" {
        if let Some(p) = payload {
            if let Some(pct) = p.get("contextUsagePercentage").and_then(|v| v.as_f64()) {
                state.context_usage_percentage = pct;
                state.has_context_usage = true;
            }
        }
    } else if event_type == "metricsEvent" {
        if let Some(p) = payload {
            let metrics = p.get("metricsEvent").or_else(|| p.get("metrics")).unwrap_or(p);
            let prompt = metrics.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let completion = metrics.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            if prompt > 0 || completion > 0 {
                let mut usage = serde_json::json!({
                    "prompt_tokens": prompt,
                    "completion_tokens": completion,
                    "total_tokens": prompt + completion,
                });
                let cache_read = metrics
                    .get("cacheReadInputTokens")
                    .or_else(|| metrics.get("cache_read_input_tokens"))
                    .and_then(|v| v.as_u64());
                let cache_create = metrics
                    .get("cacheCreationInputTokens")
                    .or_else(|| metrics.get("cache_creation_input_tokens"))
                    .and_then(|v| v.as_u64());
                if let Some(cr) = cache_read {
                    usage["cache_read_input_tokens"] = serde_json::json!(cr);
                }
                if let Some(cc) = cache_create {
                    usage["cache_creation_input_tokens"] = serde_json::json!(cc);
                }
                state.usage = Some(usage);
            }
        }
    } else if event_type == "meteringEvent" {
        state.has_metering = true;
        if let Some(p) = payload {
            let metering = p.get("meteringEvent").or_else(|| p.get("metering")).unwrap_or(p);
            if let Some(credits) = metering.get("usage").and_then(|v| v.as_f64()) {
                let mut usage = if let Some(ref existing) = state.usage {
                    existing.clone()
                } else {
                    serde_json::json!({})
                };
                usage["kiro_credits"] = serde_json::json!(credits);
                usage["kiro_credit_unit"] = serde_json::json!(
                    metering
                        .get("unit")
                        .and_then(|v| v.as_str())
                        .unwrap_or("credit")
                );
                state.usage = Some(usage);
            }
        }
    }
}

/// Emit the final SSE chunks (tool calls, finish reason, usage, [DONE]).
fn emit_final(
    state: &mut EventStreamState,
    response_id: &str,
    created: u64,
    model: &str,
    output: &mut String,
) {
    if state.finished {
        return;
    }

    // Emit buffered tool calls
    for tool in state.tools.values() {
        let input: Value = if tool.input_chunks.is_empty() {
            serde_json::json!({})
        } else {
            let joined = tool.input_chunks.join("");
            serde_json::from_str(&joined).unwrap_or(serde_json::json!({}))
        };

        let index = state.tool_counter;
        state.tool_counter += 1;

        // Emit tool call start
        let delta_start = if state.chunk_index == 0 {
            state.chunk_index += 1;
            serde_json::json!({
                "role": "assistant",
                "tool_calls": [{
                    "index": index,
                    "id": tool.id,
                    "type": "function",
                    "function": { "name": tool.name, "arguments": "" }
                }]
            })
        } else {
            serde_json::json!({
                "tool_calls": [{
                    "index": index,
                    "id": tool.id,
                    "type": "function",
                    "function": { "name": tool.name, "arguments": "" }
                }]
            })
        };
        output.push_str(&sse_chunk(response_id, created, model, delta_start, None, None));

        // Emit arguments
        let args = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
        let delta_args = serde_json::json!({
            "tool_calls": [{ "index": index, "function": { "arguments": args } }]
        });
        output.push_str(&sse_chunk(response_id, created, model, delta_args, None, None));
        state.has_tool_calls = true;
        state.total_content_length += tool.name.len() + args.len();
    }

    let has_output = state.has_text || state.has_reasoning || state.has_tool_calls;

    if !has_output && !state.explicit_stop {
        output.push_str(&encode_sse_error(
            "kiro_missing_terminal",
            "Kiro EventStream ended without model output",
        ));
        state.finished = true;
        return;
    }

    // Determine finish reason based on stop disposition
    let stop_reason = state.stop_reason.as_deref().unwrap_or("");
    let disposition = stop_disposition(stop_reason, state.has_tool_calls);

    // For truncation after output (model_context_window_exceeded / max_tokens after content):
    // keep the partial output and finish as "length"
    let is_truncation = matches!(stop_reason, "model_context_window_exceeded" | "max_tokens");
    let truncated_after_output =
        disposition == "terminal_incomplete" && is_truncation && state.chunk_index > 0;

    if !truncated_after_output
        && matches!(
            disposition,
            "retryable_protocol_failure" | "terminal_incomplete" | "terminal_refusal"
                | "unknown_failure"
        )
    {
        let code = match disposition {
            "retryable_protocol_failure" => "kiro_retryable_protocol_failure",
            "terminal_refusal" => "kiro_terminal_refusal",
            "terminal_incomplete" => "kiro_terminal_incomplete",
            _ => "kiro_unknown_stop_reason",
        };
        output.push_str(&encode_sse_error(
            code,
            &format!(
                "Kiro ended with non-success stop reason: {}",
                stop_reason
            ),
        ));
        state.finished = true;
        return;
    }

    // Compute usage: if we have metering + context usage but no total_tokens, estimate
    if state.has_metering && state.has_context_usage {
        if let Some(ref mut usage) = state.usage {
            if usage.get("total_tokens").is_none() {
                let completion = if state.total_content_length > 0 {
                    std::cmp::max(1, state.total_content_length / 4) as u64
                } else {
                    0
                };
                let context_window: f64 = 200_000.0;
                let prompt = (state.context_usage_percentage * context_window / 100.0) as u64;
                usage["prompt_tokens"] = serde_json::json!(prompt);
                usage["completion_tokens"] = serde_json::json!(completion);
                usage["total_tokens"] = serde_json::json!(prompt + completion);
            }
        }
    }

    let finish_reason = if truncated_after_output {
        "length"
    } else if state.has_tool_calls {
        "tool_calls"
    } else if disposition == "length" {
        "length"
    } else {
        "stop"
    };

    let usage_ref = state.usage.as_ref();
    output.push_str(&sse_chunk(
        response_id,
        created,
        model,
        serde_json::json!({}),
        Some(finish_reason),
        usage_ref.map(|u| u),
    ));
    output.push_str("data: [DONE]\n\n");
    state.finished = true;
}

/// Process raw bytes from the EventStream, parsing frames and emitting SSE.
/// Returns false if a parse error occurred (caller should stop).
fn process_bytes(
    chunk: &[u8],
    state: &mut EventStreamState,
    response_id: &str,
    created: u64,
    model: &str,
    output: &mut String,
) -> bool {
    // Append to buffer
    state.buffer.extend_from_slice(chunk);

    if state.buffer.len() > EVENTSTREAM_MAX_MESSAGE_BYTES {
        output.push_str(&encode_sse_error(
            "kiro_missing_terminal",
            "Kiro EventStream buffered bytes exceed the protocol bound",
        ));
        return false;
    }

    while state.buffer.len() >= 12 && !state.finished {
        // Check prelude CRC
        let prelude = &state.buffer[0..8];
        let prelude_crc = crc32fast::hash(prelude);
        let stored_prelude_crc = u32::from_be_bytes([
            state.buffer[8],
            state.buffer[9],
            state.buffer[10],
            state.buffer[11],
        ]);
        if prelude_crc != stored_prelude_crc {
            output.push_str(&encode_sse_error(
                "kiro_missing_terminal",
                "Kiro EventStream prelude CRC mismatch",
            ));
            return false;
        }

        let total_length = u32::from_be_bytes([
            state.buffer[0],
            state.buffer[1],
            state.buffer[2],
            state.buffer[3],
        ]) as usize;
        let headers_length = u32::from_be_bytes([
            state.buffer[4],
            state.buffer[5],
            state.buffer[6],
            state.buffer[7],
        ]) as usize;

        if total_length < 16
            || total_length > EVENTSTREAM_MAX_MESSAGE_BYTES
            || headers_length > EVENTSTREAM_MAX_HEADERS_BYTES
            || headers_length > total_length - 16
        {
            output.push_str(&encode_sse_error(
                "kiro_missing_terminal",
                "Kiro EventStream frame bounds are invalid",
            ));
            return false;
        }

        if state.buffer.len() < total_length {
            break; // Incomplete frame, wait for more data
        }

        let frame: Vec<u8> = state.buffer[0..total_length].to_vec();
        state.buffer = state.buffer[total_length..].to_vec();

        match parse_event_frame(&frame) {
            Ok((headers, payload)) => {
                process_event(
                    &headers,
                    &payload,
                    state,
                    response_id,
                    created,
                    model,
                    output,
                );
            }
            Err(e) => {
                output.push_str(&encode_sse_error("kiro_missing_terminal", &e));
                return false;
            }
        }
    }

    true
}

/// Transform a complete EventStream binary body into OpenAI SSE text.
/// Used for non-streaming responses (collect everything, then produce SSE).
fn transform_eventstream_to_sse(body: &[u8], model: &str) -> Bytes {
    let response_id = format!("chatcmpl-kiro-{}", now_ms());
    let created = now_secs();

    let mut state = EventStreamState::new();
    let mut output = String::new();

    if !process_bytes(body, &mut state, &response_id, created, model, &mut output) {
        return Bytes::from(output);
    }

    // Check for leftover buffer (truncated frame)
    if !state.buffer.is_empty() && !state.finished {
        output.push_str(&encode_sse_error(
            "kiro_missing_terminal",
            "Kiro EventStream ended with a truncated frame",
        ));
        return Bytes::from(output);
    }

    emit_final(&mut state, &response_id, created, model, &mut output);
    Bytes::from(output)
}

// ── Executor implementation ──────────────────────────────────────────────────

#[async_trait::async_trait]
impl ProviderExecutor for KiroExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, true).await
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, false).await
    }
}

impl KiroExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        // Extract model from request body
        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("claude-sonnet-4.5")
            .to_string();

        let (upstream_model, _is_agentic, _is_thinking) = resolve_kiro_model(&model);

        // Get provider-specific data
        let psd = kiro_token::get_provider_specific_data(conn);
        let auth_method = psd.get("authMethod").and_then(|v| v.as_str()).unwrap_or("");
        let is_api_key = auth_method == "api_key";

        // Resolve access token — check if refresh is needed
        let mut access_token = kiro_token::get_access_token(conn);

        if access_token.is_some() && kiro_token::needs_refresh(conn) {
            tracing::debug!("Kiro token needs refresh for connection {}", conn.id);
            match kiro_token::refresh_kiro_token(conn).await {
                Ok(refreshed) => {
                    access_token = Some(refreshed.access_token);
                    tracing::info!("Kiro token refreshed successfully for connection {}", conn.id);
                }
                Err(e) => {
                    tracing::warn!(
                        "Kiro token refresh failed for connection {}: {}",
                        conn.id,
                        e
                    );
                    // Fall through — try with the existing token, it might still work
                }
            }
        }

        // For API key auth, the key may be in apiKey field instead of accessToken
        if access_token.is_none() && is_api_key {
            access_token = get_connection_auth(&conn.data);
        }

        let access_token = match access_token {
            Some(t) => t,
            None => {
                return Ok(UpstreamResponse::Error {
                    status: StatusCode::UNAUTHORIZED,
                    message: "Kiro connection missing access token".to_string(),
                });
            }
        };

        // Translate request via the translator (OpenAI → Kiro format)
        let mut kiro_body = openai_to_kiro_request(&upstream_model, &body, stream);

        // Inject profileArn into the request body (executor-level concern)
        inject_profile_arn(&mut kiro_body, &psd);

        // Build URL from ordered base URLs
        let base_urls = get_ordered_base_urls(&psd);
        let url = base_urls
            .first()
            .cloned()
            .unwrap_or_else(|| KIRO_BASE_URLS[0].to_string());

        // Build headers
        let req_headers = build_kiro_headers(&access_token, &psd, &url);

        // Send upstream request
        let client = build_client();
        let resp = client
            .post(&url)
            .headers(req_headers)
            .json(&kiro_body)
            .send()
            .await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Kiro upstream request failed: {}", e);
                return Ok(UpstreamResponse::Error {
                    status: StatusCode::BAD_GATEWAY,
                    message: format!("Kiro upstream request failed: {}", e),
                });
            }
        };

        let status = resp.status();

        // Handle 401: attempt a single token refresh, then retry once.
        // After that, return 401 — do NOT loop.
        if status.as_u16() == 401 {
            tracing::warn!(
                "Kiro upstream returned 401 for connection {}; attempting token refresh",
                conn.id
            );
            match kiro_token::refresh_kiro_token(conn).await {
                Ok(refreshed) => {
                    let new_token = refreshed.access_token;
                    let retry_headers = build_kiro_headers(&new_token, &psd, &url);
                    let retry_resp = client
                        .post(&url)
                        .headers(retry_headers)
                        .json(&kiro_body)
                        .send()
                        .await;

                    if let Ok(retry_resp) = retry_resp {
                        let retry_status = retry_resp.status();
                        if retry_status.is_success() {
                            return self.handle_success_response(
                                retry_resp,
                                &model,
                                stream,
                            )
                            .await;
                        }
                        // Retry also failed — fall through to error
                        let text = retry_resp.text().await.unwrap_or_default();
                        return Ok(UpstreamResponse::Error {
                            status: StatusCode::UNAUTHORIZED,
                            message: format!(
                                "Kiro upstream error after token refresh: {}",
                                text
                            ),
                        });
                    }
                    return Ok(UpstreamResponse::Error {
                        status: StatusCode::BAD_GATEWAY,
                        message: "Kiro retry request failed after token refresh".to_string(),
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        "Kiro token refresh failed on 401 for connection {}: {}",
                        conn.id,
                        e
                    );
                    // Fall through to return 401
                }
            }

            // Refresh failed or not possible — return 401
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::UNAUTHORIZED,
                message: format!(
                    "Kiro upstream returned 401 (token: {}): {}",
                    mask_token(&access_token),
                    text
                ),
            });
        }

        // Handle other error statuses
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let err_status = match status.as_u16() {
                403 => StatusCode::UNAUTHORIZED,
                429 => StatusCode::TOO_MANY_REQUESTS,
                _ => StatusCode::from_u16(status.as_u16())
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            };
            tracing::warn!(
                "Kiro upstream returned {}: {}",
                status.as_u16(),
                &text[..text.len().min(200)]
            );
            return Ok(UpstreamResponse::Error {
                status: err_status,
                message: format!("Kiro upstream error: {}", text),
            });
        }

        // Success — handle based on stream flag
        self.handle_success_response(resp, &model, stream).await
    }

    /// Handle a successful upstream response.
    /// For streaming: return an SSE stream that decodes EventStream frames on-the-fly.
    /// For non-streaming: collect all content and return as a single JSON response.
    async fn handle_success_response(
        &self,
        resp: reqwest::Response,
        model: &str,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        if stream {
            // Return a real streaming response: decode EventStream frames on-the-fly.
            // Uses a tokio channel to bridge the async upstream byte stream with the
            // EventStream decoder, yielding SSE chunks as they are parsed.
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);

            let response_id = format!("chatcmpl-kiro-{}", now_ms());
            let created = now_secs();
            let model_clone = model.to_string();

            tokio::spawn(async move {
                let mut state = EventStreamState::new();
                let response_id = response_id;
                let created_v = created;
                let model_v = model_clone;

                // Emit heartbeat (mirrors JS ': kiro-validation\n\n')
                let _ = tx
                    .send(Ok(Bytes::from(": kiro-validation\n\n")))
                    .await;

                let mut upstream = resp.bytes_stream();
                let mut had_error = false;

                while !had_error {
                    match upstream.next().await {
                        Some(Ok(chunk)) => {
                            let mut output = String::new();
                            let ok = process_bytes(
                                &chunk,
                                &mut state,
                                &response_id,
                                created_v,
                                &model_v,
                                &mut output,
                            );
                            if !output.is_empty() {
                                if tx.send(Ok(Bytes::from(output))).await.is_err() {
                                    break; // Client disconnected
                                }
                            }
                            if !ok {
                                had_error = true;
                            }
                        }
                        Some(Err(e)) => {
                            let err_msg = format!("Kiro EventStream read failed: {}", e);
                            let sse_err = encode_sse_error("kiro_missing_terminal", &err_msg);
                            let _ = tx.send(Ok(Bytes::from(sse_err))).await;
                            had_error = true;
                        }
                        None => break, // Stream ended normally
                    }
                }

                // Emit final chunks
                if !had_error {
                    let mut final_output = String::new();
                    // Check for truncated frame
                    if !state.buffer.is_empty() && !state.finished {
                        final_output.push_str(&encode_sse_error(
                            "kiro_missing_terminal",
                            "Kiro EventStream ended with a truncated frame",
                        ));
                    } else {
                        emit_final(
                            &mut state,
                            &response_id,
                            created_v,
                            &model_v,
                            &mut final_output,
                        );
                    }
                    if !final_output.is_empty() {
                        let _ = tx.send(Ok(Bytes::from(final_output))).await;
                    }
                }
            });

            // Convert the mpsc receiver into a Stream
            let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
            let stream = stream.boxed();

            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: Box::new(stream),
            })
        } else {
            // Non-streaming: read the full response body, transform EventStream to
            // OpenAI SSE, then parse the SSE to extract a single chat.completion JSON.
            let body_bytes = resp.bytes().await?;

            let sse_bytes = transform_eventstream_to_sse(&body_bytes, model);
            let sse_text = String::from_utf8_lossy(&sse_bytes);

            // Parse SSE chunks to extract final content
            let mut full_content = String::new();
            let mut full_reasoning = String::new();
            let mut tool_calls: Vec<Value> = Vec::new();
            let mut finish_reason = "stop".to_string();
            let mut usage: Option<Value> = None;

            for line in sse_text.lines() {
                if !line.starts_with("data: ") {
                    continue;
                }
                let data = line[6..].trim();
                if data == "[DONE]" || data.is_empty() {
                    continue;
                }
                if let Ok(chunk) = serde_json::from_str::<Value>(data) {
                    // Check for error events
                    if chunk.get("error").is_some() {
                        let err_msg = chunk
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Kiro upstream error");
                        let err_code = chunk
                            .get("error")
                            .and_then(|e| e.get("code"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("upstream_error");
                        return Ok(UpstreamResponse::Error {
                            status: StatusCode::from_u16(
                                if err_code.contains("401") || err_code.contains("auth") {
                                    401
                                } else if err_code.contains("429") {
                                    429
                                } else {
                                    502
                                },
                            )
                            .unwrap_or(StatusCode::BAD_GATEWAY),
                            message: err_msg.to_string(),
                        });
                    }

                    if let Some(choices) = chunk.get("choices").and_then(|v| v.as_array()) {
                        if let Some(choice) = choices.first() {
                            if let Some(content) = choice
                                .get("delta")
                                .and_then(|d| d.get("content"))
                                .and_then(|v| v.as_str())
                            {
                                full_content.push_str(content);
                            }
                            if let Some(reasoning) = choice
                                .get("delta")
                                .and_then(|d| d.get("reasoning_content"))
                                .and_then(|v| v.as_str())
                            {
                                full_reasoning.push_str(reasoning);
                            }
                            if let Some(tcs) = choice
                                .get("delta")
                                .and_then(|d| d.get("tool_calls"))
                                .and_then(|v| v.as_array())
                            {
                                tool_calls.extend(tcs.iter().cloned());
                            }
                            if let Some(fr) =
                                choice.get("finish_reason").and_then(|v| v.as_str())
                            {
                                if !fr.is_empty() && fr != "null" {
                                    finish_reason = fr.to_string();
                                }
                            }
                        }
                    }
                    if let Some(u) = chunk.get("usage") {
                        usage = Some(u.clone());
                    }
                }
            }

            let response_id = format!("chatcmpl-kiro-{}", now_ms());
            let created = now_secs();

            let mut message = serde_json::json!({
                "role": "assistant",
                "content": if full_content.is_empty() { Value::Null } else { Value::String(full_content.clone()) },
            });

            if !full_reasoning.is_empty() {
                message["reasoning_content"] = Value::String(full_reasoning);
            }

            if !tool_calls.is_empty() {
                // Merge tool call arguments from consecutive chunks with the same index
                let mut merged: Vec<Value> = Vec::new();
                let mut arg_buffers: HashMap<u64, String> = HashMap::new();

                for tc in &tool_calls {
                    let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    if let Some(args) = tc
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                    {
                        let buf = arg_buffers.entry(idx).or_default();
                        buf.push_str(args);
                    }
                    // If this tc has an id, it's the start of a new tool call
                    if tc.get("id").is_some() {
                        merged.push(tc.clone());
                    }
                }

                // Apply buffered arguments
                for tc in merged.iter_mut() {
                    let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    if let Some(buf) = arg_buffers.get(&idx) {
                        tc["function"]["arguments"] = Value::String(buf.clone());
                    }
                }

                message["tool_calls"] = Value::Array(merged);
            }

            let mut completion = serde_json::json!({
                "id": response_id,
                "object": "chat.completion",
                "created": created,
                "model": &model,
                "choices": [{
                    "index": 0,
                    "message": message,
                    "finish_reason": &finish_reason,
                }]
            });

            if let Some(u) = usage {
                completion["usage"] = u;
            }

            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from(serde_json::to_vec(&completion).unwrap_or_default()),
            })
        }
    }
}
