//! OpenAI <-> Ollama translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-to-ollama.js (openaiToOllamaRequest)
//! - open-sse/translator/response/ollama-to-openai.js (ollamaToOpenAIResponse)
//!
//! Ollama accepts OpenAI-like format with string content (not arrays),
//! raw base64 images in message.images[], and num_predict for max_tokens.

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI -> Ollama
// ═══════════════════════════════════════════════════════════════════════════════

/// Normalize content to string (Ollama only accepts string content).
fn normalize_ollama_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let text_parts: Vec<String> = arr.iter()
            .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_TEXT))
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        return text_parts.join("\n");
    }
    String::new()
}

/// Extract base64 images from OpenAI multimodal content blocks.
/// Returns raw base64 strings (no data: prefix) for Ollama's message.images[].
fn extract_ollama_images(content: &Value) -> Vec<String> {
    let arr = match content.as_array() {
        Some(a) => a,
        None => return vec![],
    };

    let mut images = Vec::new();
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some(OPENAI_BLOCK_IMAGE_URL) {
            continue;
        }
        let url = block.get("image_url").and_then(|v| v.as_str())
            .or_else(|| block.get("image_url").and_then(|v| v.get("url")).and_then(|v| v.as_str()));
        if url.is_none() {
            continue;
        }
        if let Some((_, base64)) = parse_data_uri(url.unwrap()) {
            images.push(base64);
        }
    }
    images
}

/// Convert OpenAI Chat Completions request to Ollama format.
/// Ported from openai-to-ollama.js `openaiToOllamaRequest`.
pub fn openai_to_ollama_request(model: &str, body: &Value, stream: bool) -> Value {
    let empty: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty);

    // Build tool_call_id -> tool_name map from assistant messages
    let mut tool_call_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for msg in messages {
        if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_ASSISTANT) {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tool_calls {
                    if let (Some(id), Some(name)) = (
                        tc.get("id").and_then(|v| v.as_str()),
                        tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()),
                    ) {
                        tool_call_map.insert(id.to_string(), name.to_string());
                    }
                }
            }
        }
    }

    let mut ollama_messages = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

        // Tool result messages -> Ollama format with tool_name
        if role == ROLE_TOOL {
            let tool_result = normalize_ollama_content(msg.get("content").unwrap_or(&Value::Null));
            if tool_result.is_empty() {
                continue;
            }
            let tool_call_id = msg.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
            let tool_name = tool_call_map.get(tool_call_id)
                .map(|s| s.clone())
                .or_else(|| msg.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown_tool".to_string());
            ollama_messages.push(json!({
                "role": ROLE_TOOL,
                "tool_name": tool_name,
                "content": tool_result
            }));
            continue;
        }

        // Assistant messages with tool_calls
        if role == ROLE_ASSISTANT {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                if !tool_calls.is_empty() {
                    let content = normalize_ollama_content(msg.get("content").unwrap_or(&Value::Null));
                    let ollama_tool_calls: Vec<Value> = tool_calls.iter().map(|tc| {
                        let args_val = tc.get("function").and_then(|v| v.get("arguments")).cloned().unwrap_or(json!({}));
                        let parsed = safe_parse_json(&args_val, args_val.clone());
                        json!({
                            "type": OPENAI_BLOCK_FUNCTION,
                            "function": {
                                "index": tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0),
                                "name": tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                                "arguments": if args_val.is_string() { parsed } else { args_val }
                            }
                        })
                    }).collect();
                    ollama_messages.push(json!({
                        "role": ROLE_ASSISTANT,
                        "content": content,
                        "tool_calls": ollama_tool_calls
                    }));
                    continue;
                }
            }
        }

        // Normal messages
        let content = normalize_ollama_content(msg.get("content").unwrap_or(&Value::Null));
        let images = extract_ollama_images(msg.get("content").unwrap_or(&Value::Null));

        // Skip empty messages (except assistant)
        if content.is_empty() && role != ROLE_ASSISTANT {
            continue;
        }

        let mut out = json!({ "role": role, "content": content });
        if !images.is_empty() {
            out["images"] = Value::Array(images.into_iter().map(|img| json!(img)).collect());
        }
        ollama_messages.push(out);
    }

    let mut result = json!({
        "model": model,
        "messages": Value::Array(ollama_messages),
        "stream": stream
    });

    // Temperature
    if let Some(temp) = body.get("temperature") {
        result["options"]["temperature"] = temp.clone();
    }

    // Max tokens (Ollama uses num_predict)
    if let Some(max_tokens) = body.get("max_tokens") {
        result["options"]["num_predict"] = max_tokens.clone();
    }

    // Top_p
    if let Some(top_p) = body.get("top_p") {
        result["options"]["top_p"] = top_p.clone();
    }

    // Tools (Ollama supports tools in OpenAI format)
    if let Some(tools) = body.get("tools") {
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            result["tools"] = tools.clone();
        }
    }

    // Tool choice
    if let Some(tc) = body.get("tool_choice") {
        result["tool_choice"] = tc.clone();
    }

    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Ollama -> OpenAI
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Ollama NDJSON response to OpenAI SSE format.
/// Ported from ollama-to-openai.js `ollamaToOpenAIResponse`.
pub fn ollama_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() || !chunk.is_object() {
        return vec![];
    }

    // Initialize state on first chunk
    if !state.has("ollama") {
        let model = chunk.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let model = if model.is_empty() {
            state.get("model").and_then(|v| v.as_str()).unwrap_or("ollama").to_string()
        } else {
            model
        };
        state.set("ollama", json!({
            "id": format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis()),
            "created": chrono::Utc::now().timestamp() as u64,
            "model": model
        }));
    }

    let ollama_state = state.get("ollama").unwrap();
    let id = ollama_state.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created = ollama_state.get("created").and_then(|v| v.as_u64()).unwrap_or(0);
    let model = ollama_state.get("model").and_then(|v| v.as_str()).unwrap_or("ollama").to_string();

    // Final chunk with done=true
    if chunk.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
        // Extract usage
        let usage = to_openai_usage(chunk, "ollama");

        // Determine finish_reason
        let done_reason = chunk.get("done_reason").and_then(|v| v.as_str()).unwrap_or("");
        let mut finish_reason = to_openai_finish(done_reason, "ollama");
        let had_tool_calls = state.get("hadToolCalls").and_then(|v| v.as_bool()).unwrap_or(false);
        if done_reason == OPENAI_FINISH_TOOL_CALLS || had_tool_calls {
            finish_reason = OPENAI_FINISH_TOOL_CALLS.to_string();
        }

        let mut done_chunk = build_chunk(&id, created, &model, json!({}), Some(&finish_reason));
        if let Some(usage) = usage {
            done_chunk["usage"] = usage;
        }
        return vec![done_chunk];
    }

    // Content chunk
    let message = match chunk.get("message") {
        Some(m) => m,
        None => return vec![],
    };

    let content = message.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let thinking = message.get("thinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tool_calls = message.get("tool_calls").and_then(|v| v.as_array());

    // Skip empty chunks
    if content.is_empty() && thinking.is_empty() && tool_calls.is_none() {
        return vec![];
    }

    // Accumulate
    if !content.is_empty() {
        let acc = state.get("accumulatedContent").and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.set("accumulatedContent", json!(format!("{}{}", acc, content)));
    }
    if !thinking.is_empty() {
        let acc = state.get("accumulatedThinking").and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.set("accumulatedThinking", json!(format!("{}{}", acc, thinking)));
    }

    let mut delta = serde_json::Map::new();
    if !content.is_empty() {
        delta.insert("content".to_string(), json!(content));
    }
    if !thinking.is_empty() {
        delta.insert("reasoning_content".to_string(), json!(thinking));
    }

    // Convert tool_calls
    if let Some(tool_calls) = tool_calls {
        state.set("hadToolCalls", json!(true));
        let converted: Vec<Value> = tool_calls.iter().enumerate().map(|(i, tc)| {
            let idx = tc.get("function").and_then(|v| v.get("index")).and_then(|v| v.as_u64()).unwrap_or(i as u64);
            let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let id = if tc_id.is_empty() {
                fallback_tool_call_id(Some(idx as usize))
            } else {
                tc_id
            };
            let fn_obj = tc.get("function").unwrap_or(&Value::Null);
            let name = fn_obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args = fn_obj.get("arguments").cloned().unwrap_or(json!({}));
            let args_str = if args.is_string() {
                args.as_str().unwrap_or("").to_string()
            } else {
                serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string())
            };
            json!({
                "index": idx,
                "id": id,
                "type": OPENAI_BLOCK_FUNCTION,
                "function": { "name": name, "arguments": args_str }
            })
        }).collect();
        delta.insert("tool_calls".to_string(), Value::Array(converted));
    }

    vec![build_chunk(&id, created, &model, Value::Object(delta), None)]
}
