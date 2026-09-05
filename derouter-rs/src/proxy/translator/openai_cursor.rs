//! OpenAI <-> Cursor translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-to-cursor.js (openaiToCursorRequest)
//! - open-sse/translator/response/cursor-to-openai.js (cursorToOpenAIResponse)
//!
//! CursorExecutor already emits OpenAI format, so the response adapter is a passthrough.
//! The request adapter converts tool results to structured text blocks and strips
//! fields irrelevant to Cursor.

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

/// Extract text content from string or content array.
fn extract_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<String> = arr.iter()
            .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_TEXT))
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        return parts.join("");
    }
    String::new()
}

/// Strip non-printable control chars from tool result text.
fn sanitize_tool_result_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            let u = *c as u32;
            !(u <= 0x08 || u == 0x0B || u == 0x0C || (0x0E..=0x1F).contains(&u) || u == 0x7F)
        })
        .collect()
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&")
        .replace('<', "<")
        .replace('>', ">")
}

fn build_tool_result_block(tool_name: &str, tool_call_id: &str, result_text: &str) -> String {
    let clean = sanitize_tool_result_text(result_text);
    let mut s = String::new();
    s.push_str("<tool_result>\n");
    s.push_str(&format!("<tool_name>{}</tool_name>\n", escape_xml(tool_name)));
    s.push_str(&format!("<tool_call_id>{}</tool_call_id>\n", escape_xml(tool_call_id)));
    s.push_str(&format!("<result>{}</result>\n", escape_xml(&clean)));
    s.push_str("</tool_result>");
    s
}

fn normalize_tool_call_id(id: &str) -> String {
    id.split('\n').next().unwrap_or("").to_string()
}

/// Convert OpenAI messages to Cursor ask/agent format.
/// Tool outputs are represented as structured text blocks in user messages
/// to avoid Cursor protobuf loop issues.
fn convert_cursor_messages(messages: &[Value]) -> Vec<Value> {
    let mut result = Vec::new();

    // Build tool_call_id -> tool name map from assistant tool calls
    let mut tool_call_meta: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for msg in messages {
        if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_ASSISTANT) {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tool_calls {
                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                    if !id.is_empty() {
                        tool_call_meta.insert(id.clone(), name.clone());
                        let normalized = normalize_tool_call_id(&id);
                        if normalized != id {
                            tool_call_meta.insert(normalized, name);
                        }
                    }
                }
            }
            // Also check Claude-format tool_use blocks
            if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                for part in arr {
                    if part.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_USE) {
                        let id = part.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = part.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                        if !id.is_empty() {
                            tool_call_meta.insert(id, name);
                        }
                    }
                }
            }
        }
    }

    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

        if role == ROLE_SYSTEM {
            result.push(json!({
                "role": ROLE_USER,
                "content": format!("[System Instructions]\n{}", extract_content(msg.get("content").unwrap_or(&Value::Null)))
            }));
            continue;
        }

        if role == ROLE_TOOL {
            let tool_content = extract_content(msg.get("content").unwrap_or(&Value::Null));
            let tool_call_id = msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tool_name = msg.get("name").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| tool_call_meta.get(&tool_call_id).cloned())
                .unwrap_or_else(|| "tool".to_string());
            result.push(json!({
                "role": ROLE_USER,
                "content": build_tool_result_block(&tool_name, &tool_call_id, &tool_content)
            }));
            continue;
        }

        if role == ROLE_USER || role == ROLE_ASSISTANT {
            // User with content array — handle Claude-format tool_result blocks
            if role == ROLE_USER {
                if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                    let mut parts = Vec::new();
                    for block in arr {
                        let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if bt == CLAUDE_BLOCK_TEXT {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                parts.push(text.to_string());
                            }
                        } else if bt == CLAUDE_BLOCK_TOOL_RESULT {
                            let tool_call_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let tool_name = tool_call_meta.get(&tool_call_id)
                                .or_else(|| tool_call_meta.get(&normalize_tool_call_id(&tool_call_id)))
                                .cloned()
                                .unwrap_or_else(|| "tool".to_string());
                            let tool_content = extract_content(block.get("content").unwrap_or(&Value::Null));
                            parts.push(build_tool_result_block(&tool_name, &tool_call_id, &tool_content));
                        }
                    }
                    let joined = parts.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
                    if !joined.is_empty() {
                        result.push(json!({ "role": ROLE_USER, "content": joined }));
                    }
                    continue;
                }
            }

            let content = extract_content(msg.get("content").unwrap_or(&Value::Null));

            if role == ROLE_ASSISTANT {
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                    if !tool_calls.is_empty() {
                        // Strip "index" field from each tool call
                        let filtered_tcs: Vec<Value> = tool_calls.iter().map(|tc| {
                            let mut cloned = tc.clone();
                            if let Some(obj) = cloned.as_object_mut() {
                                obj.remove("index");
                            }
                            cloned
                        }).collect();
                        result.push(json!({
                            "role": ROLE_ASSISTANT,
                            "content": if content.is_empty() { "" } else { content.as_str() },
                            "tool_calls": filtered_tcs
                        }));
                        continue;
                    }
                }
                // Check Claude-format tool_use blocks in content array
                if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                    let extracted_tcs: Vec<Value> = arr.iter()
                        .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_USE))
                        .map(|b| json!({
                            "id": b.get("id").cloned().unwrap_or(json!("")),
                            "type": OPENAI_BLOCK_FUNCTION,
                            "function": {
                                "name": b.get("name").and_then(|v| v.as_str()).unwrap_or("tool"),
                                "arguments": serde_json::to_string(b.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".to_string())
                            }
                        }))
                        .filter(|tc| tc.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false))
                        .collect();

                    if !extracted_tcs.is_empty() {
                        result.push(json!({
                            "role": ROLE_ASSISTANT,
                            "content": if content.is_empty() { "" } else { content.as_str() },
                            "tool_calls": extracted_tcs
                        }));
                        continue;
                    }
                }
                if !content.is_empty() {
                    result.push(json!({ "role": ROLE_ASSISTANT, "content": content }));
                } else {
                    // Empty assistant with no tool calls — skip
                }
            } else {
                if !content.is_empty() {
                    result.push(json!({ "role": role, "content": content }));
                }
            }
        }
    }

    result
}

/// Convert OpenAI Chat Completions request to Cursor format.
/// Ported from openai-to-cursor.js `openaiToCursorRequest`.
pub fn openai_to_cursor_request(model: &str, body: &Value, stream: bool) -> Value {
    let empty: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty);
    let converted = convert_cursor_messages(messages);

    // Strip fields irrelevant to Cursor, keep rest
    let mut result = body.clone();
    if let Some(obj) = result.as_object_mut() {
        obj.remove("user");
        obj.remove("metadata");
        obj.remove("tool_choice");
        obj.remove("stream_options");
        obj.remove("system");
    }
    result["model"] = json!(model);
    result["stream"] = json!(stream);
    result["messages"] = Value::Array(converted);
    result["max_tokens"] = json!(DEFAULT_MIN_TOKENS);

    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Cursor -> OpenAI (passthrough)
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Cursor response to OpenAI format.
/// CursorExecutor already emits OpenAI format — this is a passthrough.
/// Ported from cursor-to-openai.js `cursorToOpenAIResponse`.
pub fn cursor_to_openai_response(chunk: &Value, _state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    // If chunk is already in OpenAI format, return as-is
    if chunk.get("object").and_then(|v| v.as_str()) == Some("chat.completion.chunk")
        && chunk.get("choices").is_some()
    {
        return vec![chunk.clone()];
    }

    // If chunk is a non-streaming completion, return as-is
    if chunk.get("object").and_then(|v| v.as_str()) == Some("chat.completion")
        && chunk.get("choices").is_some()
    {
        return vec![chunk.clone()];
    }

    // Fallback: return as-is
    vec![chunk.clone()]
}
