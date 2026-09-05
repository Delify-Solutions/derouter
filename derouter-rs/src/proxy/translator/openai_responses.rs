//! OpenAI Responses API <-> OpenAI Chat Completions translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-responses.js (openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest)
//! - open-sse/translator/response/openai-responses.js (openaiResponsesToOpenAIResponse, openaiToOpenAIResponsesResponse)

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Get the next sequence number from state, incrementing it.
fn get_next_seq(state: &mut ResponseState) -> u64 {
    let s = state.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
    state.set("seq", json!(s));
    s
}

/// Responses API enforces max 64 chars on call_id.
fn clamp_call_id(id: &str) -> String {
    if id.len() > 64 {
        id[..64].to_string()
    } else {
        id.to_string()
    }
}

/// Ensure object schema always has properties field.
fn normalize_tool_parameters(params: &Value) -> Value {
    if params.is_null() {
        return json!({ "type": "object", "properties": {} });
    }
    if params.get("type").and_then(|v| v.as_str()) == Some("object") && params.get("properties").is_none() {
        let mut result = params.clone();
        result["properties"] = json!({});
        return result;
    }
    params.clone()
}

/// Normalize Responses API input to array format (string or array -> array).
fn normalize_responses_input(input: &Value) -> Option<Vec<Value>> {
    if let Some(s) = input.as_str() {
        let text = if s.trim().is_empty() { "..." } else { s };
        return Some(vec![json!({
            "type": RESPONSES_ITEM_MESSAGE,
            "role": ROLE_USER,
            "content": [{ "type": RESPONSES_ITEM_INPUT_TEXT, "text": text }]
        })]);
    }
    if let Some(arr) = input.as_array() {
        if arr.is_empty() {
            return Some(vec![json!({
                "type": RESPONSES_ITEM_MESSAGE,
                "role": ROLE_USER,
                "content": [{ "type": RESPONSES_ITEM_INPUT_TEXT, "text": "..." }]
            })]);
        }
        return Some(arr.clone());
    }
    None
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: Responses -> OpenAI Chat Completions
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert OpenAI Responses API request to Chat Completions format.
/// Ported from openai-responses.js `openaiResponsesToOpenAIRequest`.
pub fn openai_responses_to_openai_request(model: &str, body: &Value, stream: bool) -> Value {
    if body.get("input").is_none() {
        return body.clone();
    }

    let mut result = body.clone();
    result["model"] = json!(model);
    result["messages"] = json!([]);
    let mut messages: Vec<Value> = Vec::new();

    // Convert instructions to system message
    if let Some(instructions) = body.get("instructions") {
        messages.push(json!({ "role": ROLE_SYSTEM, "content": instructions }));
    }

    // Group items by conversation turn
    let mut current_assistant_msg: Option<Value> = None;
    let mut pending_tool_results: Vec<Value> = Vec::new();
    let mut pending_reasoning = String::new();
    let mut pending_reasoning_encrypted = String::new();
    let mut additional_tools: Vec<Value> = Vec::new();
    let mut custom_tool_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    let input_items = match normalize_responses_input(body.get("input").unwrap_or(&Value::Null)) {
        Some(items) => items,
        None => return body.clone(),
    };

    for item in &input_items {
        let item_type = item.get("type").and_then(|v| v.as_str()).map(|s| s.to_string())
            .or_else(|| {
                if item.get("role").is_some() {
                    Some(RESPONSES_ITEM_MESSAGE.to_string())
                } else {
                    None
                }
            });

        match item_type.as_deref() {
            Some(RESPONSES_ITEM_MESSAGE) => {
                // Flush pending assistant message
                if let Some(msg) = current_assistant_msg.take() {
                    messages.push(msg);
                }
                // Flush pending tool results
                for tr in pending_tool_results.drain(..) {
                    messages.push(tr);
                }

                // Convert content
                let content = if let Some(arr) = item.get("content").and_then(|v| v.as_array()) {
                    let mapped: Vec<Value> = arr.iter().map(|c| {
                        let ct = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match ct {
                            RESPONSES_ITEM_INPUT_TEXT | RESPONSES_ITEM_OUTPUT_TEXT => {
                                json!({ "type": OPENAI_BLOCK_TEXT, "text": c.get("text").cloned().unwrap_or(Value::Null) })
                            }
                            RESPONSES_ITEM_INPUT_IMAGE => {
                                let url = c.get("image_url").and_then(|v| v.as_str())
                                    .or_else(|| c.get("file_id").and_then(|v| v.as_str()))
                                    .unwrap_or("");
                                json!({ "type": OPENAI_BLOCK_IMAGE_URL, "image_url": { "url": url, "detail": c.get("detail").and_then(|v| v.as_str()).unwrap_or("auto") } })
                            }
                            _ => c.clone(),
                        }
                    }).collect();
                    Value::Array(mapped)
                } else {
                    item.get("content").cloned().unwrap_or(Value::Null)
                };

                let role = item.get("role").and_then(|v| v.as_str()).unwrap_or(ROLE_USER);
                let mut msg = json!({ "role": role, "content": content });

                // Attach buffered reasoning to assistant turn
                if role == ROLE_ASSISTANT {
                    if !pending_reasoning.is_empty() {
                        msg["reasoning_content"] = json!(pending_reasoning.clone());
                        pending_reasoning.clear();
                    }
                    if !pending_reasoning_encrypted.is_empty() {
                        msg["encrypted_content"] = json!(pending_reasoning_encrypted.clone());
                        pending_reasoning_encrypted.clear();
                    }
                } else {
                    pending_reasoning.clear();
                    pending_reasoning_encrypted.clear();
                }
                messages.push(msg);
            }
            Some(RESPONSES_ITEM_FUNCTION_CALL) | Some(RESPONSES_ITEM_CUSTOM_TOOL_CALL) => {
                let is_custom = item_type.as_deref() == Some(RESPONSES_ITEM_CUSTOM_TOOL_CALL);

                if current_assistant_msg.is_none() {
                    let mut msg = json!({
                        "role": ROLE_ASSISTANT,
                        "content": Value::Null,
                        "tool_calls": []
                    });
                    if !pending_reasoning.is_empty() {
                        msg["reasoning_content"] = json!(pending_reasoning.clone());
                        pending_reasoning.clear();
                    }
                    if !pending_reasoning_encrypted.is_empty() {
                        msg["encrypted_content"] = json!(pending_reasoning_encrypted.clone());
                        pending_reasoning_encrypted.clear();
                    }
                    current_assistant_msg = Some(msg);
                }

                // Skip items with empty/missing name
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.trim().is_empty() {
                    continue;
                }
                if is_custom {
                    custom_tool_names.insert(name.to_string());
                }

                let tool_input = if is_custom {
                    let input = item.get("input").cloned().unwrap_or(Value::Null);
                    if input.is_string() {
                        input
                    } else {
                        json!(serde_json::to_string(&input).unwrap_or_default())
                    }
                } else {
                    item.get("arguments").cloned().unwrap_or(Value::Null)
                };

                let arguments = if tool_input.is_string() {
                    tool_input
                } else {
                    json!(serde_json::to_string(&tool_input).unwrap_or_else(|_| "{}".to_string()))
                };

                let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(msg) = current_assistant_msg.as_mut() {
                    if let Some(tool_calls) = msg.get_mut("tool_calls").and_then(|v| v.as_array_mut()) {
                        tool_calls.push(json!({
                            "id": call_id,
                            "type": OPENAI_BLOCK_FUNCTION,
                            "function": { "name": name, "arguments": arguments }
                        }));
                    }
                }
            }
            Some(RESPONSES_ITEM_FUNCTION_CALL_OUTPUT) | Some(RESPONSES_ITEM_CUSTOM_TOOL_CALL_OUTPUT) => {
                // Flush assistant message first
                if let Some(msg) = current_assistant_msg.take() {
                    messages.push(msg);
                }
                // Flush pending tool results
                for tr in pending_tool_results.drain(..) {
                    messages.push(tr);
                }
                // Add tool result immediately
                let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                let output = item.get("output").cloned().unwrap_or(Value::Null);
                let output_str = if output.is_string() {
                    output
                } else {
                    json!(serde_json::to_string(&output).unwrap_or_default())
                };
                messages.push(json!({
                    "role": ROLE_TOOL,
                    "tool_call_id": call_id,
                    "content": output_str
                }));
            }
            Some(RESPONSES_ITEM_ADDITIONAL_TOOLS) => {
                if let Some(tools) = item.get("tools").and_then(|v| v.as_array()) {
                    additional_tools.extend(tools.iter().cloned());
                }
            }
            Some(RESPONSES_ITEM_REASONING) => {
                // Extract reasoning text from summary[].text or content[].text
                let txt = if let Some(summary) = item.get("summary").and_then(|v| v.as_array()) {
                    let parts: Vec<String> = summary.iter()
                        .filter_map(|s| s.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !parts.is_empty() { parts.join("\n") } else { String::new() }
                } else if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                    let parts: Vec<String> = content.iter()
                        .filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !parts.is_empty() { parts.join("\n") } else { String::new() }
                } else { String::new() };

                if !txt.is_empty() {
                    if !pending_reasoning.is_empty() {
                        pending_reasoning = format!("{}\n{}", pending_reasoning, txt);
                    } else {
                        pending_reasoning = txt;
                    }
                }
                if let Some(encrypted) = item.get("encrypted_content").and_then(|v| v.as_str()) {
                    if !encrypted.is_empty() {
                        pending_reasoning_encrypted = encrypted.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    // Flush remaining
    if let Some(msg) = current_assistant_msg {
        messages.push(msg);
    }
    for tr in pending_tool_results {
        messages.push(tr);
    }

    result["messages"] = Value::Array(messages);

    // Convert tools format
    let mut response_tools: Vec<Value> = Vec::new();
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        response_tools.extend(tools.iter().cloned());
    }
    response_tools.extend(additional_tools);

    if !response_tools.is_empty() {
        let openai_tools: Vec<Value> = response_tools.iter().filter_map(|tool| {
            // Already in Chat Completions format
            if tool.get("function").is_some() {
                return Some(tool.clone());
            }
            let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.trim().is_empty() {
                return None;
            }
            let tt = tool.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if tt == "custom" {
                custom_tool_names.insert(name.to_string());
                let format_hint = [tool.get("format").and_then(|v| v.get("syntax")).cloned(),
                                   tool.get("format").and_then(|v| v.get("definition")).cloned()]
                    .into_iter().flatten()
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let desc = tool.get("description").and_then(|v| v.as_str()).unwrap_or("");
                let full_desc = [desc.to_string(), format_hint].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
                Some(json!({
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": {
                        "name": name,
                        "description": full_desc,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "input": { "type": "string", "description": "Raw freeform input for this custom tool" }
                            },
                            "required": ["input"],
                            "additionalProperties": false
                        }
                    }
                }))
            } else {
                Some(json!({
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": {
                        "name": name,
                        "description": tool.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                        "parameters": normalize_tool_parameters(&tool.get("parameters").cloned().unwrap_or(Value::Null)),
                        "strict": tool.get("strict").cloned()
                    }
                }))
            }
        }).collect();
        if !openai_tools.is_empty() {
            result["tools"] = Value::Array(openai_tools);
        }
    }

    if !custom_tool_names.is_empty() {
        result["_customToolNames"] = json!(custom_tool_names.into_iter().collect::<Vec<_>>());
    }

    // Cleanup Responses API specific fields
    if result.get("max_output_tokens").is_some() && result.get("max_tokens").is_none() {
        result["max_tokens"] = result["max_output_tokens"].clone();
    }
    if let Some(obj) = result.as_object_mut() {
        obj.remove("max_output_tokens");
        obj.remove("input");
        obj.remove("instructions");
        obj.remove("include");
        obj.remove("prompt_cache_key");
        obj.remove("store");
        obj.remove("client_metadata");
    }
    if let Some(reasoning) = result.get("reasoning").and_then(|v| v.as_object()) {
        if let Some(effort) = reasoning.get("effort").and_then(|v| v.as_str()) {
            result["reasoning_effort"] = json!(effort);
        }
    }
    if let Some(obj) = result.as_object_mut() {
        obj.remove("reasoning");
    }

    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI Chat Completions -> Responses API
// ═══════════════════════════════════════════════════════════════════════════════

/// Build a Responses `reasoning` input item from Chat Completions assistant fields.
fn build_reasoning_input_item(msg: &Value) -> Option<Value> {
    let encrypted = msg.get("encrypted_content").and_then(|v| v.as_str())
        .or_else(|| msg.get("reasoning_encrypted_content").and_then(|v| v.as_str()))
        .or_else(|| msg.get("reasoning").and_then(|v| v.get("encrypted_content")).and_then(|v| v.as_str()))
        .unwrap_or("");

    let summary_text = if let Some(s) = msg.get("reasoning_content").and_then(|v| v.as_str()) {
        if s.trim().is_empty() { String::new() } else { s.to_string() }
    } else if let Some(s) = msg.get("reasoning").and_then(|v| v.as_str()) {
        if s.trim().is_empty() { String::new() } else { s.to_string() }
    } else if let Some(details) = msg.get("reasoning_details").and_then(|v| v.as_array()) {
        let parts: Vec<String> = details.iter().filter_map(|d| {
            d.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                .or_else(|| d.get("content").and_then(|v| v.as_str()).map(|s| s.to_string()))
        }).filter(|s| !s.is_empty()).collect();
        if parts.is_empty() { String::new() } else { parts.join("\n") }
    } else { String::new() };

    if encrypted.is_empty() && summary_text.is_empty() {
        return None;
    }

    let mut item = json!({ "type": RESPONSES_ITEM_REASONING });
    if !summary_text.is_empty() {
        item["summary"] = json!([{ "type": RESPONSES_ITEM_SUMMARY_TEXT, "text": summary_text }]);
    }
    if !encrypted.is_empty() {
        item["encrypted_content"] = json!(encrypted);
    }
    Some(item)
}

/// Convert OpenAI Chat Completions to OpenAI Responses API format.
/// Ported from openai-responses.js `openaiToOpenAIResponsesRequest`.
pub fn openai_to_openai_responses_request(model: &str, body: &Value, stream: bool) -> Value {
    // Body already in Responses API format (e.g. Cursor CLI sending input[])
    if body.get("input").is_some() {
        let mut out = body.clone();
        out["model"] = json!(model);
        out["stream"] = json!(true);
        if out.get("max_output_tokens").is_none() {
            if let Some(max_completion) = out.get("max_completion_tokens").cloned() {
                out["max_output_tokens"] = max_completion;
            } else if let Some(max_tokens) = out.get("max_tokens").cloned() {
                out["max_output_tokens"] = max_tokens;
            }
        }
        if let Some(obj) = out.as_object_mut() {
            obj.remove("max_tokens");
            obj.remove("max_completion_tokens");
        }
        return out;
    }

    let mut result = json!({
        "model": model,
        "input": [],
        "stream": true,
        "store": false
    });

    let mut has_system_message = false;
    let empty_msgs: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty_msgs);

    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

        if role == ROLE_SYSTEM || role == ROLE_DEVELOPER {
            if !has_system_message {
                let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                result["instructions"] = json!(content);
                has_system_message = true;
            }
            continue;
        }

        if role == ROLE_USER || role == ROLE_ASSISTANT {
            // Multi-turn continuity for store=false
            if role == ROLE_ASSISTANT {
                if let Some(reasoning_item) = build_reasoning_input_item(msg) {
                    if let Some(input) = result.get_mut("input").and_then(|v| v.as_array_mut()) {
                        input.push(reasoning_item);
                    }
                }
            }

            let content_type = if role == ROLE_USER { RESPONSES_ITEM_INPUT_TEXT } else { RESPONSES_ITEM_OUTPUT_TEXT };

            let content = if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                vec![json!({ "type": content_type, "text": s })]
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                arr.iter().map(|c| {
                    let ct = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ct {
                        OPENAI_BLOCK_TEXT => json!({ "type": content_type, "text": c.get("text").cloned().unwrap_or(Value::Null) }),
                        OPENAI_BLOCK_IMAGE_URL => {
                            let url = c.get("image_url").and_then(|v| v.as_str())
                                .or_else(|| c.get("image_url").and_then(|v| v.get("url")).and_then(|v| v.as_str()))
                                .unwrap_or("");
                            json!({ "type": RESPONSES_ITEM_INPUT_IMAGE, "image_url": url, "detail": c.get("image_url").and_then(|v| v.get("detail")).and_then(|v| v.as_str()).unwrap_or("auto") })
                        }
                        RESPONSES_ITEM_INPUT_IMAGE => c.clone(),
                        _ => {
                            let text = c.get("text").and_then(|v| v.as_str())
                                .or_else(|| c.get("content").and_then(|v| v.as_str()))
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| serde_json::to_string(c).unwrap_or_default());
                            json!({ "type": content_type, "text": text })
                        }
                    }
                }).collect()
            } else {
                vec![]
            };

            if !content.is_empty() {
                if let Some(input) = result.get_mut("input").and_then(|v| v.as_array_mut()) {
                    input.push(json!({
                        "type": RESPONSES_ITEM_MESSAGE,
                        "role": role,
                        "content": content
                    }));
                }
            }
        }

        // Convert tool calls
        if role == ROLE_ASSISTANT {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tool_calls {
                    let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("_unknown");
                    let arguments = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}");
                    if let Some(input) = result.get_mut("input").and_then(|v| v.as_array_mut()) {
                        input.push(json!({
                            "type": RESPONSES_ITEM_FUNCTION_CALL,
                            "call_id": clamp_call_id(tc_id),
                            "name": name,
                            "arguments": arguments
                        }));
                    }
                }
            }
        }

        // Convert tool results
        if role == ROLE_TOOL {
            let output = if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                s.to_string()
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    .or_else(|| serde_json::to_string(c).ok()))
                    .collect::<Vec<_>>().join("")
            } else {
                serde_json::to_string(msg.get("content").unwrap_or(&Value::Null)).unwrap_or_default()
            };
            let call_id = msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(input) = result.get_mut("input").and_then(|v| v.as_array_mut()) {
                input.push(json!({
                    "type": RESPONSES_ITEM_FUNCTION_CALL_OUTPUT,
                    "call_id": clamp_call_id(call_id),
                    "output": output
                }));
            }
        }
    }

    if !has_system_message {
        result["instructions"] = json!("");
    }

    // Convert tools
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let mut converted_tools = Vec::new();
        for tool in tools {
            if tool.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_FUNCTION) {
                if let Some(func) = tool.get("function") {
                    converted_tools.push(json!({
                        "type": OPENAI_BLOCK_FUNCTION,
                        "name": func.get("name").cloned().unwrap_or(Value::Null),
                        "description": func.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                        "parameters": normalize_tool_parameters(&func.get("parameters").cloned().unwrap_or(Value::Null)),
                        "strict": func.get("strict").cloned()
                    }));
                }
            } else {
                converted_tools.push(tool.clone());
            }
        }
        if !converted_tools.is_empty() {
            result["tools"] = Value::Array(converted_tools);
        }
    }

    // Pass through other fields
    if let Some(temp) = body.get("temperature") {
        result["temperature"] = temp.clone();
    }
    if body.get("max_output_tokens").is_some() {
        result["max_output_tokens"] = body.get("max_output_tokens").cloned().unwrap_or(Value::Null);
    } else if body.get("max_completion_tokens").is_some() {
        result["max_output_tokens"] = body.get("max_completion_tokens").cloned().unwrap_or(Value::Null);
    } else if body.get("max_tokens").is_some() {
        result["max_output_tokens"] = body.get("max_tokens").cloned().unwrap_or(Value::Null);
    }
    if let Some(top_p) = body.get("top_p") {
        result["top_p"] = top_p.clone();
    }
    if let Some(reasoning) = body.get("reasoning") {
        result["reasoning"] = reasoning.clone();
    }
    if let Some(effort) = body.get("reasoning_effort") {
        result["reasoning"] = json!({ "effort": effort, "summary": "auto" });
    }
    if let Some(tier) = body.get("service_tier") {
        result["service_tier"] = tier.clone();
    }
    if let Some(cache_key) = body.get("prompt_cache_key") {
        result["prompt_cache_key"] = cache_key.clone();
    }

    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Responses -> OpenAI Chat Completions
// ═══════════════════════════════════════════════════════════════════════════════

fn compute_finish_reason_responses(state: &ResponseState) -> String {
    let tool_call_index = state.get("toolCallIndex").and_then(|v| v.as_u64()).unwrap_or(0);
    let current_tool_call_id = state.get("currentToolCallId").and_then(|v| v.as_str());
    if tool_call_index > 0 || current_tool_call_id.is_some() {
        OPENAI_FINISH_TOOL_CALLS.to_string()
    } else {
        OPENAI_FINISH_STOP.to_string()
    }
}

/// Convert OpenAI Responses API chunk to OpenAI Chat Completions format.
/// Ported from openai-responses.js `openaiResponsesToOpenAIResponse`.
pub fn openai_responses_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        // Flush: send final chunk with finish_reason
        let finish_sent = state.get("finishReasonSent").and_then(|v| v.as_bool()).unwrap_or(false);
        let started = state.get("started").and_then(|v| v.as_bool()).unwrap_or(false);
        if finish_sent || !started {
            return vec![];
        }

        let finish_reason = compute_finish_reason_responses(state);
        state.set("finishReasonSent", json!(true));
        state.set("finishReason", json!(finish_reason.clone()));

        let chat_id = state.get("chatId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let id = if chat_id.is_empty() { format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis()) } else { chat_id };
        let created = state.get("created").and_then(|v| v.as_u64()).unwrap_or(chrono::Utc::now().timestamp() as u64);
        let model = state.get("model").and_then(|v| v.as_str()).unwrap_or(MODEL_FALLBACK).to_string();

        let mut final_chunk = build_chunk(&id, created, &model, json!({}), Some(&finish_reason));
        if let Some(usage) = state.get("usage").cloned() {
            final_chunk["usage"] = usage;
        }
        return vec![final_chunk];
    }

    let event_type = chunk.get("type").and_then(|v| v.as_str())
        .or_else(|| chunk.get("event").and_then(|v| v.as_str()))
        .unwrap_or("");
    let data = chunk.get("data").unwrap_or(chunk);

    // Initialize state
    if !state.get("started").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set("started", json!(true));
        state.set("chatId", json!(format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis())));
        state.set("created", json!(chrono::Utc::now().timestamp() as u64));
        state.set("toolCallIndex", json!(0));
        state.set("currentToolCallId", Value::Null);
    }

    let chat_id = state.get("chatId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created = state.get("created").and_then(|v| v.as_u64()).unwrap_or(0);
    let model = state.get("model").and_then(|v| v.as_str()).unwrap_or(MODEL_FALLBACK).to_string();

    // Text content delta
    if event_type == "response.output_text.delta" {
        let delta = data.get("delta").and_then(|v| v.as_str()).unwrap_or("");
        if delta.is_empty() {
            return vec![];
        }
        return vec![build_chunk(&chat_id, created, &model, json!({ "content": delta }), None)];
    }

    // Text content done (ignore)
    if event_type == "response.output_text.done" {
        return vec![];
    }

    // Function call started
    if event_type == "response.output_item.added" {
        let item_type = data.get("item").and_then(|v| v.get("type")).and_then(|v| v.as_str()).unwrap_or("");
        if item_type == RESPONSES_ITEM_FUNCTION_CALL || item_type == "custom_tool_call" {
            let item = data.get("item").unwrap_or(&Value::Null);
            let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            state.set("currentToolCallId", json!(call_id));

            let tool_call_index = state.get("toolCallIndex").and_then(|v| v.as_u64()).unwrap_or(0);

            return vec![build_chunk(&chat_id, created, &model, json!({
                "tool_calls": [{
                    "index": tool_call_index,
                    "id": call_id,
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": { "name": item.get("name").and_then(|v| v.as_str()).unwrap_or(""), "arguments": "" }
                }]
            }), None)];
        }
    }

    // Function call arguments delta
    if event_type == "response.function_call_arguments.delta" || event_type == "response.custom_tool_call_input.delta" {
        let args_delta = data.get("delta").and_then(|v| v.as_str()).unwrap_or("");
        if args_delta.is_empty() {
            return vec![];
        }
        let tool_call_index = state.get("toolCallIndex").and_then(|v| v.as_u64()).unwrap_or(0);
        return vec![build_chunk(&chat_id, created, &model, json!({
            "tool_calls": [{ "index": tool_call_index, "function": { "arguments": args_delta } }]
        }), None)];
    }

    // Function call done
    if event_type == "response.output_item.done" {
        let item_type = data.get("item").and_then(|v| v.get("type")).and_then(|v| v.as_str()).unwrap_or("");
        if item_type == RESPONSES_ITEM_FUNCTION_CALL || item_type == "custom_tool_call" {
            let idx = state.get("toolCallIndex").and_then(|v| v.as_u64()).unwrap_or(0);
            state.set("toolCallIndex", json!(idx + 1));
            return vec![];
        }
    }

    // Response completed
    if event_type == "response.completed" || event_type == "response.done" {
        // Extract usage
        if let Some(response_usage) = data.get("response").and_then(|v| v.get("usage")) {
            let input_tokens = response_usage.get("input_tokens").and_then(|v| v.as_u64())
                .or_else(|| response_usage.get("prompt_tokens").and_then(|v| v.as_u64()))
                .unwrap_or(0);
            let output_tokens = response_usage.get("output_tokens").and_then(|v| v.as_u64())
                .or_else(|| response_usage.get("completion_tokens").and_then(|v| v.as_u64()))
                .unwrap_or(0);
            let cached = response_usage.get("input_tokens_details").and_then(|v| v.get("cached_tokens")).and_then(|v| v.as_u64())
                .or_else(|| response_usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()))
                .unwrap_or(0);

            state.set("usage", build_usage(input_tokens, output_tokens, input_tokens + output_tokens, cached, 0, 0));
        }

        let finish_sent = state.get("finishReasonSent").and_then(|v| v.as_bool()).unwrap_or(false);
        if !finish_sent {
            let finish_reason = compute_finish_reason_responses(state);
            state.set("finishReasonSent", json!(true));
            state.set("finishReason", json!(finish_reason.clone()));

            let mut final_chunk = build_chunk(&chat_id, created, &model, json!({}), Some(&finish_reason));
            if let Some(usage) = state.get("usage").cloned() {
                final_chunk["usage"] = usage;
            }
            return vec![final_chunk];
        }
        return vec![];
    }

    // Error events
    if event_type == "error" || event_type == "response.failed" {
        let finish_sent = state.get("finishReasonSent").and_then(|v| v.as_bool()).unwrap_or(false);
        if finish_sent {
            return vec![];
        }
        let error = data.get("error").or_else(|| data.get("response").and_then(|v| v.get("error")));
        if let Some(error) = error {
            state.set("finishReasonSent", json!(true));
            let error_msg = error.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let content = if error_msg.is_empty() {
                serde_json::to_string(error).unwrap_or_default()
            } else {
                error_msg.to_string()
            };
            return vec![build_chunk(&chat_id, created, &model, json!({ "content": format!("[Error] {}", content) }), Some(OPENAI_FINISH_STOP))];
        }
    }

    // Reasoning summary delta
    if event_type == "response.reasoning_summary_text.delta" {
        let delta = data.get("delta").and_then(|v| v.as_str()).unwrap_or("");
        if delta.is_empty() {
            return vec![];
        }
        return vec![build_chunk(&chat_id, created, &model, reasoning_delta(delta, false), None)];
    }

    vec![]
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: OpenAI Chat Completions -> Responses API
// ═══════════════════════════════════════════════════════════════════════════════

/// Translate OpenAI chunk to Responses API events.
/// Ported from openai-responses.js `openaiToOpenAIResponsesResponse`.
pub fn openai_to_openai_responses_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return flush_responses_events(state);
    }

    let choices = match chunk.get("choices").and_then(|v| v.as_array()) {
        Some(c) if !c.is_empty() => c,
        _ => return vec![],
    };

    let mut events = Vec::new();
    let choice = &choices[0];
    let idx = choice.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as i64;
    let delta = choice.get("delta").unwrap_or(&Value::Null);

    // Emit initial events
    if !state.get("started").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set("started", json!(true));
        let response_id = if let Some(chunk_id) = chunk.get("id").and_then(|v| v.as_str()) {
            format!("resp_{}", chunk_id)
        } else {
            format!("resp_{}", chrono::Utc::now().timestamp_millis())
        };
        state.set("responseId", json!(response_id.clone()));
        let created = chrono::Utc::now().timestamp() as u64;
        state.set("created", json!(created));

        events.push(json!({
            "event": "response.created",
            "data": {
                "type": "response.created",
                "sequence_number": get_next_seq(state),
                "response": {
                    "id": response_id,
                    "object": "response",
                    "created_at": created,
                    "status": "in_progress",
                    "background": false,
                    "error": Value::Null,
                    "output": []
                }
            }
        }));

        events.push(json!({
            "event": "response.in_progress",
            "data": {
                "type": "response.in_progress",
                "sequence_number": get_next_seq(state),
                "response": {
                    "id": response_id,
                    "object": "response",
                    "created_at": created,
                    "status": "in_progress"
                }
            }
        }));
    }

    let response_id = state.get("responseId").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Handle reasoning
    let reasoning_text = extract_reasoning_text(delta);
    if !reasoning_text.is_empty() {
        start_responses_reasoning(state, &mut events, idx, &response_id);
        emit_responses_reasoning_delta(state, &mut events, &reasoning_text, idx);
    }

    // Handle text content
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
        let mut content = content.to_string();

        if content.contains("\u{1f914}") {
            state.set("inThinking", json!(true));
            content = content.replace("\u{1f914}", "");
            start_responses_reasoning(state, &mut events, idx, &response_id);
        }

        if content.contains("\u{1f64c}") {
            let parts: Vec<&str> = content.splitn(2, "\u{1f64c}").collect();
            let think_part = parts[0];
            let text_part = if parts.len() > 1 { parts[1] } else { "" };
            if !think_part.is_empty() {
                emit_responses_reasoning_delta(state, &mut events, think_part, idx);
            }
            close_responses_reasoning(state, &mut events, idx, &response_id);
            state.set("inThinking", json!(false));
            content = text_part.to_string();
        }

        let in_thinking = state.get("inThinking").and_then(|v| v.as_bool()).unwrap_or(false);
        if in_thinking && !content.is_empty() {
            emit_responses_reasoning_delta(state, &mut events, &content, idx);
            return events;
        }

        if !content.is_empty() {
            emit_responses_text_content(state, &mut events, &content, idx, &response_id);
        }
    }

    // Handle tool_calls
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        if !tool_calls.is_empty() {
            close_responses_message_by_idx(state, &mut events, idx, &response_id);
            for tc in tool_calls {
                emit_responses_tool_call(state, &mut events, tc);
            }
        }
    }

    // Handle finish_reason
    if let Some(finish_reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
        if !finish_reason.is_empty() && finish_reason != "null" {
            // Close all open messages
            let msg_keys: Vec<String> = state.get("msgItemAdded").and_then(|v| v.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            for k in msg_keys {
                let k_i64 = k.parse::<i64>().unwrap_or(0);
                close_responses_message(state, &mut events, k_i64, &response_id, &k);
            }
            close_responses_reasoning(state, &mut events, idx, &response_id);

            // Close all open tool calls
            let func_keys: Vec<String> = state.get("funcCallIds").and_then(|v| v.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            for k in func_keys {
                close_responses_tool_call(state, &mut events, &k);
            }

            send_responses_completed(state, &mut events, &response_id);
        }
    }

    events
}

// ── Responses response helper functions ──────────────────────────────────────

fn start_responses_reasoning(state: &mut ResponseState, events: &mut Vec<Value>, idx: i64, response_id: &str) {
    if state.get("reasoningId").is_none() {
        let reasoning_id = format!("rs_{}_{}", response_id, idx);
        state.set("reasoningId", json!(reasoning_id.clone()));
        state.set("reasoningIndex", json!(idx));
        state.set("reasoningBuf", json!(""));
        state.set("reasoningDone", json!(false));

        events.push(json!({
            "event": "response.output_item.added",
            "data": {
                "type": "response.output_item.added",
                "sequence_number": get_next_seq(state),
                "output_index": idx,
                "item": { "id": reasoning_id, "type": RESPONSES_ITEM_REASONING, "summary": [] }
            }
        }));

        events.push(json!({
            "event": "response.reasoning_summary_part.added",
            "data": {
                "type": "response.reasoning_summary_part.added",
                "sequence_number": get_next_seq(state),
                "item_id": reasoning_id,
                "output_index": idx,
                "summary_index": 0,
                "part": { "type": RESPONSES_ITEM_SUMMARY_TEXT, "text": "" }
            }
        }));
    }
}

fn emit_responses_reasoning_delta(state: &mut ResponseState, events: &mut Vec<Value>, text: &str, idx: i64) {
    if text.is_empty() {
        return;
    }
    let buf = state.get("reasoningBuf").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let new_buf = format!("{}{}", buf, text);
    state.set("reasoningBuf", json!(new_buf));

    let reasoning_id = state.get("reasoningId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    events.push(json!({
        "event": "response.reasoning_summary_text.delta",
        "data": {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": get_next_seq(state),
            "item_id": reasoning_id,
            "output_index": idx,
            "summary_index": 0,
            "delta": text
        }
    }));
}

fn close_responses_reasoning(state: &mut ResponseState, events: &mut Vec<Value>, idx: i64, response_id: &str) {
    let _ = response_id;
    let reasoning_done = state.get("reasoningDone").and_then(|v| v.as_bool()).unwrap_or(false);
    if !reasoning_done {
        let reasoning_id = state.get("reasoningId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if reasoning_id.is_empty() {
            return;
        }
        state.set("reasoningDone", json!(true));

        let buf = state.get("reasoningBuf").and_then(|v| v.as_str()).unwrap_or("").to_string();

        events.push(json!({
            "event": "response.reasoning_summary_text.done",
            "data": {
                "type": "response.reasoning_summary_text.done",
                "sequence_number": get_next_seq(state),
                "item_id": reasoning_id,
                "output_index": idx,
                "summary_index": 0,
                "text": buf
            }
        }));

        events.push(json!({
            "event": "response.reasoning_summary_part.done",
            "data": {
                "type": "response.reasoning_summary_part.done",
                "sequence_number": get_next_seq(state),
                "item_id": reasoning_id,
                "output_index": idx,
                "summary_index": 0,
                "part": { "type": RESPONSES_ITEM_SUMMARY_TEXT, "text": buf }
            }
        }));

        events.push(json!({
            "event": "response.output_item.done",
            "data": {
                "type": "response.output_item.done",
                "sequence_number": get_next_seq(state),
                "output_index": idx,
                "item": {
                    "id": reasoning_id,
                    "type": RESPONSES_ITEM_REASONING,
                    "summary": [{ "type": RESPONSES_ITEM_SUMMARY_TEXT, "text": buf }]
                }
            }
        }));
    }
}

fn emit_responses_text_content(state: &mut ResponseState, events: &mut Vec<Value>, content: &str, idx: i64, response_id: &str) {
    let idx_str = idx.to_string();
    let msg_added_key = format!("msgItemAdded.{}", idx_str);

    if !state.get(&msg_added_key).and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set(&msg_added_key, json!(true));
        let msg_id = format!("msg_{}_{}", response_id, idx);

        events.push(json!({
            "event": "response.output_item.added",
            "data": {
                "type": "response.output_item.added",
                "sequence_number": get_next_seq(state),
                "output_index": idx,
                "item": { "id": msg_id, "type": RESPONSES_ITEM_MESSAGE, "content": [], "role": ROLE_ASSISTANT }
            }
        }));
    }

    let content_added_key = format!("msgContentAdded.{}", idx_str);
    if !state.get(&content_added_key).and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set(&content_added_key, json!(true));
        let msg_id = format!("msg_{}_{}", response_id, idx);

        events.push(json!({
            "event": "response.content_part.added",
            "data": {
                "type": "response.content_part.added",
                "sequence_number": get_next_seq(state),
                "item_id": msg_id,
                "output_index": idx,
                "content_index": 0,
                "part": { "type": RESPONSES_ITEM_OUTPUT_TEXT, "annotations": [], "logprobs": [], "text": "" }
            }
        }));
    }

    let msg_id = format!("msg_{}_{}", response_id, idx);
    events.push(json!({
        "event": "response.output_text.delta",
        "data": {
            "type": "response.output_text.delta",
            "sequence_number": get_next_seq(state),
            "item_id": msg_id,
            "output_index": idx,
            "content_index": 0,
            "delta": content,
            "logprobs": []
        }
    }));

    // Append to text buffer
    let buf_key = format!("msgTextBuf.{}", idx_str);
    let current = state.get(&buf_key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    state.set(&buf_key, json!(format!("{}{}", current, content)));
}

fn close_responses_message(state: &mut ResponseState, events: &mut Vec<Value>, idx: i64, response_id: &str, key: &str) {
    let _ = key;
    let idx_str = idx.to_string();
    let msg_added_key = format!("msgItemAdded.{}", idx_str);
    let msg_done_key = format!("msgItemDone.{}", idx_str);

    if state.get(&msg_added_key).and_then(|v| v.as_bool()).unwrap_or(false)
        && !state.get(&msg_done_key).and_then(|v| v.as_bool()).unwrap_or(false)
    {
        state.set(&msg_done_key, json!(true));
        let msg_id = format!("msg_{}_{}", response_id, idx);
        let buf_key = format!("msgTextBuf.{}", idx_str);
        let full_text = state.get(&buf_key).and_then(|v| v.as_str()).unwrap_or("").to_string();

        events.push(json!({
            "event": "response.output_text.done",
            "data": {
                "type": "response.output_text.done",
                "sequence_number": get_next_seq(state),
                "item_id": msg_id,
                "output_index": idx,
                "content_index": 0,
                "text": full_text,
                "logprobs": []
            }
        }));

        events.push(json!({
            "event": "response.content_part.done",
            "data": {
                "type": "response.content_part.done",
                "sequence_number": get_next_seq(state),
                "item_id": msg_id,
                "output_index": idx,
                "content_index": 0,
                "part": { "type": RESPONSES_ITEM_OUTPUT_TEXT, "annotations": [], "logprobs": [], "text": full_text }
            }
        }));

        events.push(json!({
            "event": "response.output_item.done",
            "data": {
                "type": "response.output_item.done",
                "sequence_number": get_next_seq(state),
                "output_index": idx,
                "item": {
                    "id": msg_id,
                    "type": RESPONSES_ITEM_MESSAGE,
                    "content": [{ "type": RESPONSES_ITEM_OUTPUT_TEXT, "annotations": [], "logprobs": [], "text": full_text }],
                    "role": ROLE_ASSISTANT
                }
            }
        }));
    }
}

fn close_responses_message_by_idx(state: &mut ResponseState, events: &mut Vec<Value>, idx: i64, response_id: &str) {
    let idx_str = idx.to_string();
    let key = idx_str.clone();
    close_responses_message(state, events, idx, response_id, &key);
}

fn emit_responses_tool_call(state: &mut ResponseState, events: &mut Vec<Value>, tc: &Value) {
    let tc_idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
    let new_call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let func_name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("");
    let idx_str = tc_idx.to_string();

    if !func_name.is_empty() {
        let name_key = format!("funcNames.{}", idx_str);
        state.set(&name_key, json!(func_name));
    }
    if !new_call_id.is_empty() {
        let id_key = format!("funcCallIds.{}", idx_str);
        state.set(&id_key, json!(new_call_id));
    }

    let call_id = state.get(&format!("funcCallIds.{}", idx_str)).and_then(|v| v.as_str()).map(|s| s.to_string());
    let name = state.get(&format!("funcNames.{}", idx_str)).and_then(|v| v.as_str()).map(|s| s.to_string());
    let added_key = format!("funcItemAdded.{}", idx_str);

    if call_id.is_some() && name.is_some() && !state.get(&added_key).and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set(&added_key, json!(true));
        let cid = call_id.unwrap();
        let nm = name.unwrap();

        events.push(json!({
            "event": "response.output_item.added",
            "data": {
                "type": "response.output_item.added",
                "sequence_number": get_next_seq(state),
                "output_index": tc_idx,
                "item": {
                    "id": format!("fc_{}", cid),
                    "type": RESPONSES_ITEM_FUNCTION_CALL,
                    "arguments": "",
                    "call_id": cid,
                    "name": nm
                }
            }
        }));
    }

    let buf_key = format!("funcArgsBuf.{}", idx_str);
    if state.get(&buf_key).is_none() {
        state.set(&buf_key, json!(""));
    }

    if let Some(args) = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()) {
        let current = state.get(&buf_key).and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.set(&buf_key, json!(format!("{}{}", current, args)));
    }
}

fn close_responses_tool_call(state: &mut ResponseState, events: &mut Vec<Value>, idx_str: &str) {
    let done_key = format!("funcItemDone.{}", idx_str);
    if state.get(&done_key).and_then(|v| v.as_bool()).unwrap_or(false) {
        return;
    }

    let call_id = state.get(&format!("funcCallIds.{}", idx_str)).and_then(|v| v.as_str()).map(|s| s.to_string());
    if let Some(call_id) = call_id {
        let buf_key = format!("funcArgsBuf.{}", idx_str);
        let args = state.get(&buf_key).and_then(|v| v.as_str()).unwrap_or("{}").to_string();
        let name = state.get(&format!("funcNames.{}", idx_str)).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let tc_idx: i64 = idx_str.parse().unwrap_or(0);

        state.set(&done_key, json!(true));

        events.push(json!({
            "event": "response.function_call_arguments.done",
            "data": {
                "type": "response.function_call_arguments.done",
                "sequence_number": get_next_seq(state),
                "item_id": format!("fc_{}", call_id),
                "output_index": tc_idx,
                "arguments": args
            }
        }));

        events.push(json!({
            "event": "response.output_item.done",
            "data": {
                "type": "response.output_item.done",
                "sequence_number": get_next_seq(state),
                "output_index": tc_idx,
                "item": {
                    "id": format!("fc_{}", call_id),
                    "type": RESPONSES_ITEM_FUNCTION_CALL,
                    "arguments": args,
                    "call_id": call_id,
                    "name": name
                }
            }
        }));
    }
}

fn send_responses_completed(state: &mut ResponseState, events: &mut Vec<Value>, response_id: &str) {
    if !state.get("completedSent").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set("completedSent", json!(true));
        let created = state.get("created").and_then(|v| v.as_u64()).unwrap_or(0);

        events.push(json!({
            "event": "response.completed",
            "data": {
                "type": "response.completed",
                "sequence_number": get_next_seq(state),
                "response": {
                    "id": response_id,
                    "object": "response",
                    "created_at": created,
                    "status": "completed",
                    "background": false,
                    "error": Value::Null
                }
            }
        }));
    }
}

fn flush_responses_events(state: &mut ResponseState) -> Vec<Value> {
    if state.get("completedSent").and_then(|v| v.as_bool()).unwrap_or(false) {
        return vec![];
    }

    let mut events = Vec::new();

    let response_id = state.get("responseId").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Close all open messages
    let msg_keys: Vec<String> = state.get("msgItemAdded").and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    for k in msg_keys {
        let k_i64 = k.parse::<i64>().unwrap_or(0);
        close_responses_message(state, &mut events, k_i64, &response_id, &k);
    }

    // Close reasoning
    let reasoning_idx = state.get("reasoningIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    close_responses_reasoning(state, &mut events, reasoning_idx, &response_id);

    // Close all open tool calls
    let func_keys: Vec<String> = state.get("funcCallIds").and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    for k in func_keys {
        close_responses_tool_call(state, &mut events, &k);
    }

    send_responses_completed(state, &mut events, &response_id);

    events
}
