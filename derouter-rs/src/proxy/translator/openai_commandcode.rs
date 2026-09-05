//! OpenAI <-> CommandCode translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-to-commandcode.js  (openaiToCommandCodeRequest)
//! - open-sse/translator/response/commandcode-to-openai.js (commandCodeToOpenAIResponse)
//!
//! CommandCode upstream uses NDJSON-style AI SDK v5 stream events.
//! Request format: threadId, memory, config, params{ model, messages, system, tools }

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI -> CommandCode
// ═══════════════════════════════════════════════════════════════════════════════

/// Flatten text content to string.
fn flatten_text(content: &Value) -> String {
    if content.is_null() {
        return String::new();
    }
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr.iter().filter_map(|p| {
            if let Some(s) = p.as_str() {
                Some(s.to_string())
            } else if let Some(text) = p.get("text").and_then(|v| v.as_str()) {
                Some(text.to_string())
            } else {
                None
            }
        }).collect();
        return parts.join("\n");
    }
    content.to_string()
}

/// Convert content to array of content blocks (never a string).
fn to_content_blocks(content: &Value) -> Vec<Value> {
    if content.is_null() {
        return vec![json!({ "type": OPENAI_BLOCK_TEXT, "text": "" })];
    }
    if let Some(s) = content.as_str() {
        return vec![json!({ "type": OPENAI_BLOCK_TEXT, "text": s })];
    }
    if let Some(arr) = content.as_array() {
        let mut blocks = Vec::new();
        for part in arr {
            if let Some(s) = part.as_str() {
                blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": s }));
            } else if let Some(pt) = part.get("type").and_then(|v| v.as_str()) {
                if pt == OPENAI_BLOCK_TEXT {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
                    }
                } else if pt == OPENAI_BLOCK_IMAGE_URL || pt == OPENAI_BLOCK_IMAGE {
                    blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": "[image omitted]" }));
                } else if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
                }
            }
        }
        if blocks.is_empty() {
            return vec![json!({ "type": OPENAI_BLOCK_TEXT, "text": "" })];
        }
        return blocks;
    }
    vec![json!({ "type": OPENAI_BLOCK_TEXT, "text": content.to_string() })]
}

fn safe_parse_json_cmd(s: &Value) -> Value {
    if s.is_null() {
        return json!({});
    }
    if let Some(string) = s.as_str() {
        return serde_json::from_str(string).unwrap_or(json!({}));
    }
    s.clone()
}

/// Convert OpenAI messages to CommandCode format.
/// Returns (messages, system_text).
fn convert_cmd_messages(messages: &[Value]) -> (Vec<Value>, String) {
    let mut out = Vec::new();
    let mut system_texts = Vec::new();

    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");

        if role == ROLE_SYSTEM {
            let t = flatten_text(m.get("content").unwrap_or(&Value::Null));
            if !t.is_empty() {
                system_texts.push(t);
            }
            continue;
        }

        if role == ROLE_TOOL {
            let value = if let Some(s) = m.get("content").and_then(|v| v.as_str()) {
                s.to_string()
            } else {
                flatten_text(m.get("content").unwrap_or(&Value::Null))
            };
            out.push(json!({
                "role": ROLE_TOOL,
                "content": [{
                    "type": "tool-result",
                    "toolCallId": m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                    "toolName": m.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "output": { "type": "text", "value": value }
                }]
            }));
            continue;
        }

        if role == ROLE_ASSISTANT {
            let mut blocks = Vec::new();
            let text = flatten_text(m.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
            }
            if let Some(tool_calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tool_calls {
                    let func = tc.get("function").unwrap_or(&Value::Null);
                    blocks.push(json!({
                        "type": "tool-call",
                        "toolCallId": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "toolName": func.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "input": safe_parse_json_cmd(&func.get("arguments").cloned().unwrap_or(Value::Null))
                    }));
                }
            }
            if blocks.is_empty() {
                blocks.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": "" }));
            }
            out.push(json!({ "role": ROLE_ASSISTANT, "content": Value::Array(blocks) }));
            continue;
        }

        // User
        out.push(json!({
            "role": ROLE_USER,
            "content": Value::Array(to_content_blocks(m.get("content").unwrap_or(&Value::Null)))
        }));
    }

    (out, system_texts.join("\n\n"))
}

/// Convert OpenAI tools to CommandCode (Anthropic) format.
fn convert_cmd_tools(tools: &[Value]) -> Option<Vec<Value>> {
    if tools.is_empty() {
        return None;
    }
    let mut result = Vec::new();
    for t in tools {
        if t.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_FUNCTION) {
            if let Some(func) = t.get("function") {
                result.push(json!({
                    "name": func.get("name").cloned().unwrap_or(Value::Null),
                    "description": func.get("description").cloned().unwrap_or(Value::Null),
                    "input_schema": func.get("parameters").cloned().unwrap_or(json!({"type": "object"}))
                }));
            }
        } else if t.get("name").is_some() && (t.get("input_schema").is_some() || t.get("parameters").is_some()) {
            result.push(json!({
                "name": t.get("name").cloned().unwrap_or(Value::Null),
                "description": t.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": t.get("input_schema").cloned().or_else(|| t.get("parameters").cloned()).unwrap_or(json!({"type": "object"}))
            }));
        }
    }
    if result.is_empty() { None } else { Some(result) }
}

/// Convert OpenAI Chat Completions request to CommandCode format.
/// Ported from openai-to-commandcode.js `openaiToCommandCodeRequest`.
pub fn openai_to_commandcode_request(model: &str, body: &Value, stream: bool) -> Value {
    let empty: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty);
    let (converted_messages, system) = convert_cmd_messages(messages);

    let max_tokens = body.get("max_tokens").and_then(|v| v.as_u64())
        .or_else(|| body.get("max_output_tokens").and_then(|v| v.as_u64()))
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let temperature = body.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.3);

    let mut params = json!({
        "model": model,
        "messages": Value::Array(converted_messages),
        "stream": stream,
        "max_tokens": max_tokens,
        "temperature": temperature
    });

    if !system.is_empty() {
        params["system"] = json!(system);
    }

    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        if let Some(converted) = convert_cmd_tools(tools) {
            params["tools"] = Value::Array(converted);
        }
    }

    if let Some(top_p) = body.get("top_p") {
        if !top_p.is_null() {
            params["top_p"] = top_p.clone();
        }
    }

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    json!({
        "threadId": uuid::Uuid::new_v4().to_string(),
        "memory": "",
        "config": {
            "workingDir": std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            "date": today,
            "environment": std::env::consts::OS,
            "structure": [],
            "isGitRepo": false,
            "currentBranch": "",
            "mainBranch": "",
            "gitStatus": "",
            "recentCommits": []
        },
        "params": params
    })
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: CommandCode -> OpenAI
// ═══════════════════════════════════════════════════════════════════════════════

/// Ensure state is initialized.
fn ensure_cmd_state(state: &mut ResponseState, model: &str) {
    if !state.has("responseId") {
        state.set("responseId", json!(format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis())));
        state.set("created", json!(chrono::Utc::now().timestamp() as u64));
        let m = state.get("model").and_then(|v| v.as_str()).unwrap_or(model).to_string();
        state.set("model", json!(if m.is_empty() { "commandcode" } else { &m }));
        state.set("chunkIndex", json!(0));
        state.set("toolIndex", json!(0));
        state.set("finishReason", Value::Null);
        state.set("usage", Value::Null);
    }
}

/// Convert CommandCode NDJSON stream events to OpenAI SSE format.
/// Ported from commandcode-to-openai.js `commandCodeToOpenAIResponse`.
pub fn commandcode_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    // Already OpenAI chunk: pass through
    if chunk.get("object").and_then(|v| v.as_str()) == Some("chat.completion.chunk") {
        return vec![chunk.clone()];
    }

    // The event may come as a parsed object or a string
    let event = if let Some(s) = chunk.as_str() {
        let line = s.trim();
        if line.is_empty() {
            return vec![];
        }
        let json_str = if line.starts_with("data:") { line[5..].trim() } else { line };
        if json_str.is_empty() || json_str == "[DONE]" {
            return vec![];
        }
        match serde_json::from_str::<Value>(json_str) {
            Ok(v) => v,
            Err(_) => return vec![],
        }
    } else {
        chunk.clone()
    };

    let event_type = match event.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    let model = event.get("model").and_then(|v| v.as_str()).unwrap_or("commandcode");
    ensure_cmd_state(state, model);

    let id = state.get("responseId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created = state.get("created").and_then(|v| v.as_u64()).unwrap_or(0);
    let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("commandcode").to_string();
    let chunk_index = state.get("chunkIndex").and_then(|v| v.as_u64()).unwrap_or(0);

    let mut out = Vec::new();

    match event_type {
        "text-delta" => {
            let text = event.get("text").and_then(|v| v.as_str())
                .or_else(|| event.get("delta").and_then(|v| v.as_str()))
                .unwrap_or("");
            if !text.is_empty() {
                let mut delta = json!({ "content": text });
                if chunk_index == 0 {
                    delta["role"] = json!(ROLE_ASSISTANT);
                }
                state.set("chunkIndex", json!(chunk_index + 1));
                state.set("openText", json!(true));
                out.push(build_chunk(&id, created, &model_str, delta, None));
            }
        }
        "reasoning-delta" => {
            let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !text.is_empty() {
                let delta = reasoning_delta(text, chunk_index == 0);
                state.set("chunkIndex", json!(chunk_index + 1));
                out.push(build_chunk(&id, created, &model_str, delta, None));
            }
        }
        "tool-input-start" => {
            let tool_id = event.get("id").and_then(|v| v.as_str())
                .or_else(|| event.get("toolCallId").and_then(|v| v.as_str()))
                .unwrap_or("").to_string();
            let id_for_fallback = if tool_id.is_empty() {
                fallback_tool_call_id(Some(state.get("toolIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize))
            } else {
                tool_id.clone()
            };

            let key = format!("cmdToolIdx.{}", id_for_fallback);
            let idx = if state.has(&key) {
                state.get(&key).and_then(|v| v.as_u64()).unwrap_or(0)
            } else {
                let new_idx = state.get("toolIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("toolIndex", json!(new_idx + 1));
                state.set(&key, json!(new_idx));
                new_idx
            };

            let mut delta = json!({
                "tool_calls": [{
                    "index": idx,
                    "id": id_for_fallback,
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": { "name": event.get("toolName").and_then(|v| v.as_str()).unwrap_or(""), "arguments": "" }
                }]
            });
            if chunk_index == 0 {
                delta["role"] = json!(ROLE_ASSISTANT);
            }
            state.set("chunkIndex", json!(chunk_index + 1));
            out.push(build_chunk(&id, created, &model_str, delta, None));
        }
        "tool-input-delta" => {
            let tool_id = event.get("id").and_then(|v| v.as_str())
                .or_else(|| event.get("toolCallId").and_then(|v| v.as_str()))
                .unwrap_or("");
            let key = format!("cmdToolIdx.{}", tool_id);
            if let Some(&idx) = state.get(&key).and_then(|v| v.as_u64()).as_ref() {
                let delta_text = event.get("delta").and_then(|v| v.as_str())
                    .or_else(|| event.get("inputTextDelta").and_then(|v| v.as_str()))
                    .unwrap_or("");
                out.push(build_chunk(&id, created, &model_str, json!({
                    "tool_calls": [{ "index": idx, "function": { "arguments": delta_text } }]
                }), None));
            }
        }
        "tool-call" => {
            // Final consolidated tool call — only emit if we never saw tool-input-* deltas
            let tool_id = event.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let key = format!("cmdToolIdx.{}", tool_id);
            if !state.has(&key) {
                let idx = state.get("toolIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("toolIndex", json!(idx + 1));
                state.set(&key, json!(idx));

                let input_val = event.get("input").cloned().unwrap_or(json!({}));
                let args_str = if input_val.is_string() {
                    input_val.as_str().unwrap_or("").to_string()
                } else {
                    serde_json::to_string(&input_val).unwrap_or_else(|_| "{}".to_string())
                };

                let mut delta = json!({
                    "tool_calls": [{
                        "index": idx,
                        "id": tool_id,
                        "type": OPENAI_BLOCK_FUNCTION,
                        "function": { "name": event.get("toolName").and_then(|v| v.as_str()).unwrap_or(""), "arguments": args_str }
                    }]
                });
                if chunk_index == 0 {
                    delta["role"] = json!(ROLE_ASSISTANT);
                }
                state.set("chunkIndex", json!(chunk_index + 1));
                out.push(build_chunk(&id, created, &model_str, delta, None));
            }
        }
        "finish-step" => {
            let reason = event.get("finishReason").and_then(|v| v.as_str()).unwrap_or("stop");
            state.set("finishReason", json!(to_openai_finish(reason, "commandcode")));
            if let Some(usage) = event.get("usage") {
                state.set("usage", usage.clone());
            }
        }
        "finish" => {
            let fr = state.get("finishReason").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let reason = event.get("finishReason").and_then(|v| v.as_str()).unwrap_or("stop");
                    to_openai_finish(reason, "commandcode")
                });
            let mut final_chunk = build_chunk(&id, created, &model_str, json!({}), Some(&fr));
            let total_usage = event.get("totalUsage").cloned().or_else(|| state.get("usage").cloned());
            if let Some(usage) = total_usage {
                if let Some(openai_usage) = to_openai_usage(&usage, "commandcode") {
                    final_chunk["usage"] = openai_usage;
                }
            }
            out.push(final_chunk);
        }
        "error" => {
            state.set("finishReason", json!(OPENAI_FINISH_STOP));
            let err_val = event.get("error").or_else(|| event.get("message"));
            let err_str = if let Some(s) = err_val.and_then(|v| v.as_str()) {
                s.to_string()
            } else if let Some(obj) = err_val {
                serde_json::to_string(obj).unwrap_or_else(|_| "unknown".to_string())
            } else {
                "unknown".to_string()
            };
            out.push(build_chunk(&id, created, &model_str, json!({ "content": format!("\n\n[CommandCode error: {}]", err_str) }), None));
            out.push(build_chunk(&id, created, &model_str, json!({}), Some(OPENAI_FINISH_STOP)));
        }
        _ => {}
    }

    out
}
