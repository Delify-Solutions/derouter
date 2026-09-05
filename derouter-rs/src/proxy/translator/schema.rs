//! Shared translator schema — role enums, block types, finish reasons, and helper functions.
//!
//! Ported from open-sse/translator/schema/*.js and concerns/*.js.
//! Pure data + small helpers used by all adapter files.

use serde_json::{json, Value};

// ── Role enums ───────────────────────────────────────────────────────────────

pub const ROLE_USER: &str = "user";
pub const ROLE_ASSISTANT: &str = "assistant";
pub const ROLE_TOOL: &str = "tool";
pub const ROLE_SYSTEM: &str = "system";
pub const ROLE_DEVELOPER: &str = "developer";

pub const GEMINI_ROLE_USER: &str = "user";
pub const GEMINI_ROLE_MODEL: &str = "model";

// ── OpenAI block types ───────────────────────────────────────────────────────

pub const OPENAI_BLOCK_TEXT: &str = "text";
pub const OPENAI_BLOCK_IMAGE_URL: &str = "image_url";
pub const OPENAI_BLOCK_IMAGE: &str = "image";
pub const OPENAI_BLOCK_FILE: &str = "file";
pub const OPENAI_BLOCK_FUNCTION: &str = "function";

// ── Claude block types ───────────────────────────────────────────────────────

pub const CLAUDE_BLOCK_TEXT: &str = "text";
pub const CLAUDE_BLOCK_IMAGE: &str = "image";
pub const CLAUDE_BLOCK_DOCUMENT: &str = "document";
pub const CLAUDE_BLOCK_TOOL_USE: &str = "tool_use";
pub const CLAUDE_BLOCK_TOOL_RESULT: &str = "tool_result";
pub const CLAUDE_BLOCK_THINKING: &str = "thinking";
pub const CLAUDE_BLOCK_REDACTED_THINKING: &str = "redacted_thinking";
pub const CLAUDE_BLOCK_SERVER_TOOL_USE: &str = "server_tool_use";

// ── Responses API item types ────────────────────────────────────────────────

pub const RESPONSES_ITEM_MESSAGE: &str = "message";
pub const RESPONSES_ITEM_FUNCTION_CALL: &str = "function_call";
pub const RESPONSES_ITEM_FUNCTION_CALL_OUTPUT: &str = "function_call_output";
pub const RESPONSES_ITEM_CUSTOM_TOOL_CALL: &str = "custom_tool_call";
pub const RESPONSES_ITEM_CUSTOM_TOOL_CALL_OUTPUT: &str = "custom_tool_call_output";
pub const RESPONSES_ITEM_ADDITIONAL_TOOLS: &str = "additional_tools";
pub const RESPONSES_ITEM_REASONING: &str = "reasoning";
pub const RESPONSES_ITEM_OUTPUT_TEXT: &str = "output_text";
pub const RESPONSES_ITEM_INPUT_TEXT: &str = "input_text";
pub const RESPONSES_ITEM_INPUT_IMAGE: &str = "input_image";
pub const RESPONSES_ITEM_SUMMARY_TEXT: &str = "summary_text";

// ── Finish reasons ──────────────────────────────────────────────────────────

pub const OPENAI_FINISH_STOP: &str = "stop";
pub const OPENAI_FINISH_LENGTH: &str = "length";
pub const OPENAI_FINISH_TOOL_CALLS: &str = "tool_calls";
pub const OPENAI_FINISH_CONTENT_FILTER: &str = "content_filter";

pub const CLAUDE_STOP_END_TURN: &str = "end_turn";
pub const CLAUDE_STOP_MAX_TOKENS: &str = "max_tokens";
pub const CLAUDE_STOP_TOOL_USE: &str = "tool_use";
pub const CLAUDE_STOP_STOP_SEQUENCE: &str = "stop_sequence";

pub const GEMINI_FINISH_STOP: &str = "STOP";
pub const GEMINI_FINISH_MAX_TOKENS: &str = "MAX_TOKENS";
pub const GEMINI_FINISH_SAFETY: &str = "SAFETY";
pub const GEMINI_FINISH_RECITATION: &str = "RECITATION";
pub const GEMINI_FINISH_BLOCKLIST: &str = "BLOCKLIST";
pub const GEMINI_FINISH_PROHIBITED_CONTENT: &str = "PROHIBITED_CONTENT";

// ── Defaults ────────────────────────────────────────────────────────────────

pub const MODEL_FALLBACK: &str = "unknown";
pub const DEFAULT_IMAGE_MIME: &str = "image/png";
pub const CLAUDE_SYSTEM_PROMPT: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
pub const DEFAULT_MAX_TOKENS: u64 = 64000;
pub const DEFAULT_MIN_TOKENS: u64 = 32000;

// ── Finish reason mapping ───────────────────────────────────────────────────

/// Map upstream finish/stop reason → OpenAI finish_reason.
/// Ported from concerns/finishReason.js `toOpenAIFinish`.
pub fn to_openai_finish(reason: &str, format: &str) -> String {
    match format {
        "claude" => match reason {
            CLAUDE_STOP_END_TURN => OPENAI_FINISH_STOP.to_string(),
            CLAUDE_STOP_MAX_TOKENS => OPENAI_FINISH_LENGTH.to_string(),
            CLAUDE_STOP_TOOL_USE => OPENAI_FINISH_TOOL_CALLS.to_string(),
            CLAUDE_STOP_STOP_SEQUENCE => OPENAI_FINISH_STOP.to_string(),
            _ => OPENAI_FINISH_STOP.to_string(),
        },
        "commandcode" => match reason {
            "stop" => OPENAI_FINISH_STOP.to_string(),
            "length" => OPENAI_FINISH_LENGTH.to_string(),
            "tool-calls" | "tool_use" => OPENAI_FINISH_TOOL_CALLS.to_string(),
            "content-filter" => OPENAI_FINISH_CONTENT_FILTER.to_string(),
            "error" => OPENAI_FINISH_STOP.to_string(),
            _ => {
                if reason.is_empty() {
                    OPENAI_FINISH_STOP.to_string()
                } else {
                    reason.to_string()
                }
            }
        },
        "gemini" => match reason.to_uppercase().as_str() {
            GEMINI_FINISH_STOP => OPENAI_FINISH_STOP.to_string(),
            GEMINI_FINISH_MAX_TOKENS => OPENAI_FINISH_LENGTH.to_string(),
            GEMINI_FINISH_SAFETY | GEMINI_FINISH_RECITATION | GEMINI_FINISH_BLOCKLIST
            | GEMINI_FINISH_PROHIBITED_CONTENT => OPENAI_FINISH_CONTENT_FILTER.to_string(),
            _ => OPENAI_FINISH_STOP.to_string(),
        },
        "kiro" | "ollama" => match reason {
            "tool_calls" | "tool_use" => OPENAI_FINISH_TOOL_CALLS.to_string(),
            "length" | "max_tokens" => OPENAI_FINISH_LENGTH.to_string(),
            _ => OPENAI_FINISH_STOP.to_string(),
        },
        _ => {
            if reason.is_empty() {
                OPENAI_FINISH_STOP.to_string()
            } else {
                reason.to_string()
            }
        }
    }
}

/// Map OpenAI finish_reason → upstream stop reason.
/// Ported from concerns/finishReason.js `fromOpenAIFinish`.
pub fn from_openai_finish(reason: &str, format: &str) -> String {
    match format {
        "claude" => match reason {
            OPENAI_FINISH_STOP => CLAUDE_STOP_END_TURN.to_string(),
            OPENAI_FINISH_LENGTH => CLAUDE_STOP_MAX_TOKENS.to_string(),
            OPENAI_FINISH_TOOL_CALLS => CLAUDE_STOP_TOOL_USE.to_string(),
            _ => CLAUDE_STOP_END_TURN.to_string(),
        },
        _ => reason.to_string(),
    }
}

// ── Chunk builder ──────────────────────────────────────────────────────────

/// Build an OpenAI chat.completion.chunk. Ported from concerns/chunk.js `buildChunk`.
pub fn build_chunk(id: &str, created: u64, model: &str, delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason
        }]
    })
}

// ── Reasoning helpers ───────────────────────────────────────────────────────

/// Build OpenAI delta carrying reasoning_content (optional leading assistant role).
/// Ported from concerns/reasoning.js `reasoningDelta`.
pub fn reasoning_delta(text: &str, with_role: bool) -> Value {
    if with_role {
        json!({ "role": ROLE_ASSISTANT, "reasoning_content": text })
    } else {
        json!({ "reasoning_content": text })
    }
}

/// Extract reasoning text from a streamed OpenAI-compatible delta.
/// Ported from concerns/reasoning.js `extractReasoningText`.
pub fn extract_reasoning_text(delta: &Value) -> String {
    if let Some(s) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Some(s) = delta.get("reasoning").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Some(details) = delta.get("reasoning_details").and_then(|v| v.as_array()) {
        let parts: Vec<String> = details
            .iter()
            .map(|d| {
                if let Some(s) = d.as_str() {
                    s.to_string()
                } else if let Some(s) = d.get("text").and_then(|v| v.as_str()) {
                    s.to_string()
                } else if let Some(s) = d.get("content").and_then(|v| v.as_str()) {
                    s.to_string()
                } else {
                    String::new()
                }
            })
            .collect();
        return parts.join("");
    }
    String::new()
}

// ── Image helpers ───────────────────────────────────────────────────────────

/// Build a base64 data URI from mime + base64 payload.
pub fn encode_data_uri(mime_type: &str, base64: &str) -> String {
    format!("data:{};base64,{}", mime_type, base64)
}

/// Parse a base64 data URI → (mimeType, base64), or None if not a data URI.
pub fn parse_data_uri(url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.strip_prefix("data:") {
        if let Some(semi) = rest.find(";base64,") {
            let mime_type = &rest[..semi];
            let base64 = &rest[semi + 8..];
            if !mime_type.is_empty() && !base64.is_empty() {
                return Some((mime_type.to_string(), base64.to_string()));
            }
        }
    }
    None
}

// ── JSON helpers ────────────────────────────────────────────────────────────

/// Safe JSON parse: non-string passthrough; on parse error return fallback.
pub fn safe_parse_json(val: &Value, fallback: Value) -> Value {
    if let Some(s) = val.as_str() {
        serde_json::from_str(s).unwrap_or(fallback)
    } else {
        val.clone()
    }
}

// ── Usage helpers ───────────────────────────────────────────────────────────

/// Build OpenAI usage object. Ported from concerns/usage.js `buildUsage`.
pub fn build_usage(
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    cached_tokens: u64,
    cache_creation_tokens: u64,
    reasoning_tokens: u64,
) -> Value {
    let mut usage = json!({
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    });

    if cached_tokens > 0 || cache_creation_tokens > 0 {
        let mut details = serde_json::Map::new();
        if cached_tokens > 0 {
            details.insert("cached_tokens".to_string(), json!(cached_tokens));
        }
        if cache_creation_tokens > 0 {
            details.insert(
                "cache_creation_tokens".to_string(),
                json!(cache_creation_tokens),
            );
        }
        usage["prompt_tokens_details"] = Value::Object(details);
    }

    if reasoning_tokens > 0 {
        usage["completion_tokens_details"] = json!({ "reasoning_tokens": reasoning_tokens });
    }

    usage
}

fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Convert provider-native usage object → OpenAI usage.
/// Ported from concerns/usage.js `toOpenAIUsage`.
pub fn to_openai_usage(raw: &Value, kind: &str) -> Option<Value> {
    if raw.is_null() {
        return None;
    }
    match kind {
        "claude" => {
            let input = n(&raw["input_tokens"]);
            let output = n(&raw["output_tokens"]);
            let cache_read = n(&raw["cache_read_input_tokens"]);
            let cache_create = n(&raw["cache_creation_input_tokens"]);
            let prompt = input + cache_read + cache_create;
            Some(build_usage(
                prompt,
                output,
                prompt + output,
                cache_read,
                cache_create,
                0,
            ))
        }
        "gemini" => {
            let cached = n(&raw["cachedContentTokenCount"]);
            let prompt = n(&raw["promptTokenCount"]);
            let thoughts = n(&raw["thoughtsTokenCount"]);
            let total = n(&raw["totalTokenCount"]);
            let mut candidates = n(&raw["candidatesTokenCount"]);
            if candidates == 0 && total > 0 {
                candidates = total.saturating_sub(prompt + thoughts);
            }
            Some(build_usage(
                prompt,
                candidates + thoughts,
                total,
                cached,
                0,
                thoughts,
            ))
        }
        "kiro" => {
            let input = n(&raw["inputTokens"]);
            let output = n(&raw["outputTokens"]);
            let cached =
                n(&raw["cache_read_input_tokens"]).max(n(&raw["cachedTokens"])).max(n(&raw["cached_tokens"]));
            let cache_creation = n(&raw["cache_creation_input_tokens"]);
            Some(build_usage(
                input,
                output,
                input + output,
                cached,
                cache_creation,
                0,
            ))
        }
        "ollama" => {
            let input = n(&raw["prompt_eval_count"]);
            let output = n(&raw["eval_count"]);
            Some(build_usage(input, output, input + output, 0, 0, 0))
        }
        "commandcode" => {
            let input = n(&raw["inputTokens"]);
            let output = n(&raw["outputTokens"]);
            let total = if let Some(t) = raw.get("totalTokens").and_then(|v| v.as_u64()) {
                t
            } else {
                input + output
            };
            Some(build_usage(input, output, total, 0, 0, 0))
        }
        _ => None,
    }
}

// ── Message helpers ────────────────────────────────────────────────────────

/// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
/// otherwise the array is returned as-is. Ported from concerns/message.js `collapseTextParts`.
pub fn collapse_text_parts(parts: &[Value]) -> Value {
    if parts.len() == 1 {
        if let Some(part) = parts.first() {
            if part.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_TEXT) {
                if let Some(text) = part.get("text").cloned() {
                    return text;
                }
            }
        }
    }
    Value::Array(parts.to_vec())
}

// ── Tool call helpers ───────────────────────────────────────────────────────

/// Fallback streaming tool_call id when provider omits one.
pub fn fallback_tool_call_id(index: Option<usize>) -> String {
    match index {
        Some(i) => format!("call_{}_{}", i, chrono::Utc::now().timestamp_millis()),
        None => format!("call_{}", chrono::Utc::now().timestamp_millis()),
    }
}

// ── Max tokens helper ───────────────────────────────────────────────────────

/// Adjust max_tokens based on request context.
/// Ported from formats/maxTokens.js `adjustMaxTokens`.
pub fn adjust_max_tokens(body: &Value, ceiling: u64) -> u64 {
    let mut max_tokens = body
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_MAX_TOKENS);

    // Auto-increase for tool calling
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        if !tools.is_empty() && max_tokens < DEFAULT_MIN_TOKENS {
            max_tokens = DEFAULT_MIN_TOKENS;
        }
    }

    // Ensure max_tokens > thinking.budget_tokens
    if let Some(budget) = body
        .get("thinking")
        .and_then(|v| v.get("budget_tokens"))
        .and_then(|v| v.as_u64())
    {
        if max_tokens <= budget {
            max_tokens = budget + 1024;
        }
    }

    // Never exceed ceiling
    max_tokens.min(ceiling)
}

// ── Budget to effort (Antigravity) ──────────────────────────────────────────

/// Gemini thinkingBudget → OpenAI reasoning_effort. Ported from concerns/thinking.js.
pub fn budget_to_effort(budget: u64) -> Option<&'static str> {
    if budget == 0 {
        return None;
    }
    if budget <= 2048 {
        Some("low")
    } else if budget <= 16384 {
        Some("medium")
    } else {
        Some("high")
    }
}

// ── Gemini function name sanitizer ──────────────────────────────────────────

/// Sanitize function names for Gemini API:
/// starts with [a-zA-Z_], followed by [a-zA-Z0-9_.:\-], max 64 chars.
pub fn sanitize_gemini_function_name(name: &str) -> String {
    if name.is_empty() {
        return "_unknown".to_string();
    }
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut result = if sanitized
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic() || c == '_')
        .unwrap_or(false)
    {
        sanitized
    } else {
        format!("_{}", sanitized)
    };
    result.truncate(64);
    result
}

/// Recursively convert Antigravity schema types to lowercase, strip enumDescriptions.
pub fn normalize_schema_types(schema: &Value) -> Value {
    if schema.is_null() {
        return schema.clone();
    }
    if let Some(arr) = schema.as_array() {
        return Value::Array(arr.iter().map(normalize_schema_types).collect());
    }
    if !schema.is_object() {
        return schema.clone();
    }
    let mut result = schema.clone().as_object().unwrap().clone();
    // Strip enumDescriptions
    result.remove("enumDescriptions");
    // Lowercase type
    if let Some(t) = result.get("type").and_then(|v| v.as_str()).map(|s| s.to_lowercase()) {
        result.insert("type".to_string(), Value::String(t));
    }
    // Recurse properties
    if let Some(props) = result.get("properties").cloned() {
        if let Some(props_obj) = props.as_object() {
            let normalized: serde_json::Map<String, Value> = props_obj
                .iter()
                .map(|(k, v)| (k.clone(), normalize_schema_types(v)))
                .collect();
            result.insert("properties".to_string(), Value::Object(normalized));
        }
    }
    // Recurse items
    if let Some(items) = result.get("items").cloned() {
        result.insert("items".to_string(), normalize_schema_types(&items));
    }
    Value::Object(result)
}

/// Clean JSON schema for Antigravity (alias for normalize_schema_types — same behavior).
pub fn clean_json_schema_for_antigravity(schema: &Value) -> Value {
    normalize_schema_types(schema)
}

// ── Extract text from Gemini content ────────────────────────────────────────

/// Extract text from Gemini content (systemInstruction or parts).
pub fn extract_gemini_text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(parts) = content.get("parts").and_then(|v| v.as_array()) {
        return parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

/// Convert OpenAI content to Gemini parts.
pub fn convert_openai_content_to_parts(content: &Value) -> Vec<Value> {
    let mut parts = Vec::new();
    if let Some(s) = content.as_str() {
        if !s.is_empty() {
            parts.push(json!({ "text": s }));
        }
        return parts;
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if let Some(t) = part.get("type").and_then(|v| v.as_str()) {
                match t {
                    OPENAI_BLOCK_TEXT => {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                parts.push(json!({ "text": text }));
                            }
                        }
                    }
                    OPENAI_BLOCK_IMAGE_URL => {
                        if let Some(url) = part
                            .get("image_url")
                            .and_then(|v| v.get("url"))
                            .and_then(|v| v.as_str())
                        {
                            if let Some((mime, base64)) = parse_data_uri(url) {
                                parts.push(json!({
                                    "inlineData": { "mimeType": mime, "data": base64 }
                                }));
                            }
                        }
                    }
                    OPENAI_BLOCK_IMAGE => {
                        if let Some(source) = part.get("source") {
                            if let Some(st) = source.get("type").and_then(|v| v.as_str()) {
                                if st == "base64" {
                                    if let (Some(mime), Some(data)) = (
                                        source.get("media_type").and_then(|v| v.as_str()),
                                        source.get("data").and_then(|v| v.as_str()),
                                    ) {
                                        parts.push(json!({
                                            "inlineData": { "mimeType": mime, "data": data }
                                        }));
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    parts
}

/// Try parse JSON string, returning Value::Null on failure.
pub fn try_parse_json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}

/// Normalize Gemini contents: merge consecutive same-role turns.
pub fn normalize_gemini_contents(contents: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for c in contents {
        let role = match c.get("role").and_then(|v| v.as_str()) {
            Some(r) => r.to_string(),
            None => continue,
        };
        let parts = match c.get("parts").and_then(|v| v.as_array()) {
            Some(p) if !p.is_empty() => p.clone(),
            _ => continue,
        };
        // Merge with previous if same role
        if let Some(last) = out.last_mut() {
            if last.get("role").and_then(|v| v.as_str()) == Some(&role) {
                if let Some(last_parts) = last.get_mut("parts").and_then(|v| v.as_array_mut()) {
                    last_parts.extend(parts);
                    continue;
                }
            }
        }
        out.push(json!({ "role": role, "parts": parts }));
    }
    out
}

/// Generate a random project ID for Gemini/Antigravity envelopes.
pub fn generate_project_id() -> String {
    format!(
        "{:016x}",
        rand::random::<u128>() & 0xFFFFFFFFFFFFFFFF
    )
}

/// Generate a random request ID for Gemini/Antigravity envelopes.
pub fn generate_request_id() -> String {
    format!("req-{}", uuid::Uuid::new_v4())
}

/// Generate a random session ID for Gemini/Antigravity envelopes.
pub fn generate_session_id() -> String {
    format!("{:020}", rand::random::<u64>() % 1_000_000_000_000_000_000)
}

/// Derive a session id from a string (used for Antigravity sessions).
pub fn derive_session_id(seed: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    let h = hasher.finish();
    format!("{:020}", h % 1_000_000_000_000_000_000)
}

/// Convert a session id string to a numeric session id.
pub fn to_numeric_session_id(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    // Try direct parse
    if let Ok(n) = s.parse::<u64>() {
        return format!("{:020}", n);
    }
    // Hash to numeric
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:020}", hasher.finish() % 1_000_000_000_000_000_000)
}

/// Default safety settings for Gemini requests.
pub fn default_safety_settings() -> Vec<Value> {
    vec![
        json!({ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" }),
        json!({ "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" }),
        json!({ "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" }),
        json!({ "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }),
        json!({ "category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE" }),
    ]
}

// ── Default thinking signatures ─────────────────────────────────────────────


// The thinking signature constants are opaque base64 blobs from
// open-sse/config/defaultThinkingSignature.js. They are used only by the
// antigravity/gemini-cli envelope wrappers which are not part of this port.
pub const DEFAULT_THINKING_AG_SIGNATURE: &str = "";
pub const DEFAULT_THINKING_GEMINI_CLI_SIGNATURE: &str = "";
pub const DEFAULT_THINKING_VERTEX_SIGNATURE: &str = "";
