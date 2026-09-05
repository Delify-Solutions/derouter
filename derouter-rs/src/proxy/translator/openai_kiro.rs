//! OpenAI ↔ Kiro / Claude → Kiro translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-to-kiro.js   (openaiToKiroRequest)
//! - open-sse/translator/request/claude-to-kiro.js   (claudeToKiroRequest)
//! - open-sse/translator/response/kiro-to-openai.js  (kiroToOpenAIResponse)
//! - open-sse/translator/response/kiro-to-claude.js  (kiroToClaudeResponse)
//!
//! The Node adapters include complex session replay, canonicalization, thinking
//! override, and profile ARN resolution that are executor-level concerns.
//! The Rust port focuses on the message-format conversion (the core translator
//! responsibility). Session/credential/thinking concerns are handled by the
//! executor layer.

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI -> Kiro
// ═══════════════════════════════════════════════════════════════════════════════

/// Safely parse JSON string, returning Value::Null on failure.
fn safe_json_parse(val: &Value) -> Value {
    if let Some(s) = val.as_str() {
        serde_json::from_str(s).unwrap_or(Value::Null)
    } else {
        val.clone()
    }
}

struct KiroHistory {
    history: Vec<Value>,
    current_message: Option<Value>,
}

/// Convert OpenAI messages to Kiro format.
/// Rules: system/tool/user -> user role, merge consecutive same roles.
fn convert_openai_messages_to_kiro(messages: &[Value], model: &str) -> KiroHistory {
    let mut history = Vec::new();
    let mut current_message: Option<Value> = None;

    let mut pending_user_content: Vec<String> = Vec::new();
    let mut pending_assistant_content: Vec<String> = Vec::new();
    let mut pending_tool_results: Vec<Value> = Vec::new();
    let mut pending_images: Vec<Value> = Vec::new();
    let mut current_role: Option<&str> = None;

    for msg in messages {
        let original_role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let was_system = original_role == ROLE_SYSTEM;
        let role = if original_role == ROLE_SYSTEM || original_role == ROLE_TOOL {
            ROLE_USER
        } else {
            original_role
        };

        // If role changes, flush pending
        if current_role.is_some() && current_role != Some(role) {
            flush_pending(
                &mut history,
                &mut current_message,
                &mut pending_user_content,
                &mut pending_assistant_content,
                &mut pending_tool_results,
                &mut pending_images,
                &mut current_role,
            );
        }
        current_role = Some(role);

        if role == ROLE_USER {
            let mut content = String::new();

            if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                content = s.to_string();
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                let mut text_parts = Vec::new();
                for c in arr {
                    let ct = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if ct == OPENAI_BLOCK_TEXT || c.get("text").is_some() {
                        if let Some(text) = c.get("text").and_then(|v| v.as_str()) {
                            text_parts.push(text.to_string());
                        }
                    } else if ct == OPENAI_BLOCK_IMAGE_URL {
                        if let Some(url) = c.get("image_url").and_then(|v| v.get("url")).and_then(|v| v.as_str()) {
                            if let Some((mime, base64)) = parse_data_uri(url) {
                                let format = mime.split('/').nth(1).unwrap_or(&mime).to_string();
                                pending_images.push(json!({ "format": format, "source": { "bytes": base64 } }));
                            } else if url.starts_with("http://") || url.starts_with("https://") {
                                text_parts.push(format!("[Image: {}]", url));
                            }
                        }
                    } else if ct == CLAUDE_BLOCK_IMAGE {
                        if let Some(source) = c.get("source") {
                            if source.get("type").and_then(|v| v.as_str()) == Some("base64") {
                                if let (Some(media_type), Some(data)) = (
                                    source.get("media_type").and_then(|v| v.as_str()),
                                    source.get("data").and_then(|v| v.as_str()),
                                ) {
                                    let format = media_type.split('/').nth(1).unwrap_or(media_type).to_string();
                                    pending_images.push(json!({ "format": format, "source": { "bytes": data } }));
                                }
                            }
                        }
                    }
                }
                content = text_parts.join("\n");

                // Check for tool_result blocks
                let tool_result_blocks: Vec<&Value> = arr.iter()
                    .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_RESULT))
                    .collect();
                for block in &tool_result_blocks {
                    let text = if let Some(arr) = block.get("content").and_then(|v| v.as_array()) {
                        arr.iter().filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect::<Vec<_>>().join("\n")
                    } else if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
                        s.to_string()
                    } else {
                        String::new()
                    };
                    pending_tool_results.push(json!({
                        "toolUseId": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                        "status": if block.get("is_error").and_then(|v| v.as_bool()) == Some(true) { "error" } else { "success" },
                        "content": [{ "text": text }]
                    }));
                }
            }

            // Handle tool role
            if original_role == ROLE_TOOL {
                let tool_content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");
                pending_tool_results.push(json!({
                    "toolUseId": msg.get("tool_call_id").cloned().unwrap_or(Value::Null),
                    "status": "success",
                    "content": [{ "text": tool_content }]
                }));
            } else if !content.is_empty() {
                let wrapped = if was_system {
                    format!("<instructions>\n{}\n</instructions>", content)
                } else {
                    content
                };
                pending_user_content.push(wrapped);
            }
        } else if role == ROLE_ASSISTANT {
            let mut text_content = String::new();
            let mut tool_uses: Vec<Value> = Vec::new();

            if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                let text_parts: Vec<String> = arr.iter()
                    .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_TEXT))
                    .filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect();
                text_content = text_parts.join("\n");
                text_content = text_content.trim().to_string();

                let tool_use_blocks: Vec<&Value> = arr.iter()
                    .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_USE))
                    .collect();
                tool_uses = tool_use_blocks.iter().map(|b| (*b).clone()).collect();
            } else if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                text_content = s.trim().to_string();
            }

            if let Some(tcs) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                if !tcs.is_empty() {
                    tool_uses = tcs.clone();
                }
            }

            if !text_content.is_empty() {
                pending_assistant_content.push(text_content);
            }

            if !tool_uses.is_empty() {
                // Flush to create assistant message with toolUses
                flush_pending(
                    &mut history, &mut current_message,
                    &mut pending_user_content, &mut pending_assistant_content,
                    &mut pending_tool_results, &mut pending_images,
                    &mut current_role,
                );

                let mapped_tool_uses: Vec<Value> = tool_uses.iter().map(|tc| {
                    if tc.get("function").is_some() {
                        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let input = safe_json_parse(&tc.get("function").and_then(|v| v.get("arguments")).cloned().unwrap_or(json!({})));
                        json!({ "toolUseId": id, "name": name, "input": input })
                    } else {
                        json!({
                            "toolUseId": tc.get("id").cloned().unwrap_or(Value::Null),
                            "name": tc.get("name").cloned().unwrap_or(Value::Null),
                            "input": tc.get("input").cloned().unwrap_or(json!({}))
                        })
                    }
                }).collect();

                if let Some(last) = history.last_mut() {
                    if let Some(assistant_msg) = last.get_mut("assistantResponseMessage") {
                        assistant_msg["toolUses"] = Value::Array(mapped_tool_uses);
                    }
                }
                current_role = None;
            }
        }
    }

    // Flush remaining
    if current_role.is_some() {
        flush_pending(
            &mut history, &mut current_message,
            &mut pending_user_content, &mut pending_assistant_content,
            &mut pending_tool_results, &mut pending_images,
            &mut current_role,
        );
    }

    // Pop last userInputMessage as currentMessage
    for i in (0..history.len()).rev() {
        if history[i].get("userInputMessage").is_some() {
            current_message = Some(history.remove(i));
            break;
        }
    }

    // Clean up history: set modelId if missing
    for item in &mut history {
        if let Some(user_msg) = item.get_mut("userInputMessage") {
            if user_msg.get("modelId").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                user_msg["modelId"] = json!(model);
            }
            // Remove empty userInputMessageContext
            if let Some(ctx) = user_msg.get("userInputMessageContext") {
                if ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                    if let Some(obj) = user_msg.as_object_mut() {
                        obj.remove("userInputMessageContext");
                    }
                }
            }
        }
    }

    // Merge consecutive user messages
    let mut merged: Vec<Value> = Vec::new();
    for item in history {
        if item.get("userInputMessage").is_some() {
            if let Some(last) = merged.last_mut() {
                if last.get("userInputMessage").is_some() {
                    // Merge content
                    let prev_content = last["userInputMessage"]["content"].as_str().unwrap_or("").to_string();
                    let cur_content = item["userInputMessage"]["content"].as_str().unwrap_or("").to_string();
                    last["userInputMessage"]["content"] = json!(format!("{}\n\n{}", prev_content, cur_content));

                    // Merge context
                    let has_prev_ctx = last["userInputMessage"].get("userInputMessageContext").is_some();
                    let has_cur_ctx = item["userInputMessage"].get("userInputMessageContext").is_some();

                    if has_cur_ctx {
                        if !has_prev_ctx {
                            last["userInputMessage"]["userInputMessageContext"] = item["userInputMessage"]["userInputMessageContext"].clone();
                        } else {
                            // Merge toolResults
                            if let Some(cur_tool_results) = item["userInputMessage"]["userInputMessageContext"].get("toolResults").and_then(|v| v.as_array()) {
                                if let Some(prev_ctx) = last["userInputMessage"]["userInputMessageContext"].as_object_mut() {
                                    let prev_tr = prev_ctx.entry("toolResults").or_insert(json!([]));
                                    if let Some(prev_arr) = prev_tr.as_array_mut() {
                                        prev_arr.extend(cur_tool_results.iter().cloned());
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }
            }
        }
        merged.push(item);
    }

    // Ensure currentMessage exists
    if current_message.is_none() {
        current_message = Some(json!({
            "userInputMessage": { "content": "", "modelId": model }
        }));
    }

    KiroHistory {
        history: merged,
        current_message,
    }
}

#[allow(clippy::too_many_arguments)]
fn flush_pending(
    history: &mut Vec<Value>,
    current_message: &mut Option<Value>,
    pending_user_content: &mut Vec<String>,
    pending_assistant_content: &mut Vec<String>,
    pending_tool_results: &mut Vec<Value>,
    pending_images: &mut Vec<Value>,
    current_role: &mut Option<&str>,
) {
    let role = current_role.take();
    match role {
        Some("user") => {
            let content = if pending_user_content.is_empty() {
                "continue".to_string()
            } else {
                let joined = pending_user_content.join("\n\n");
                if joined.trim().is_empty() { "continue".to_string() } else { joined }
            };
            let mut user_msg = json!({
                "userInputMessage": { "content": content, "modelId": "" }
            });

            if !pending_images.is_empty() {
                user_msg["userInputMessage"]["images"] = Value::Array(pending_images.drain(..).collect());
            }

            if !pending_tool_results.is_empty() {
                user_msg["userInputMessage"]["userInputMessageContext"] = json!({
                    "toolResults": pending_tool_results.drain(..).collect::<Vec<_>>()
                });
            }

            history.push(user_msg.clone());
            *current_message = Some(user_msg);
            pending_user_content.clear();
        }
        Some("assistant") => {
            let content = if pending_assistant_content.is_empty() {
                "...".to_string()
            } else {
                let joined = pending_assistant_content.join("\n\n");
                if joined.trim().is_empty() { "...".to_string() } else { joined }
            };
            history.push(json!({ "assistantResponseMessage": { "content": content } }));
            pending_assistant_content.clear();
        }
        None => {}
        _ => {}
    }
}

/// Convert OpenAI Chat Completions request to Kiro/AWS CodeWhisperer format.
/// Ported from openai-to-kiro.js `openaiToKiroRequest`.
pub fn openai_to_kiro_request(model: &str, body: &Value, stream: bool) -> Value {
    let empty_msgs: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty_msgs);
    let empty_tools: Vec<Value> = Vec::new();
    let _tools = body.get("tools").and_then(|v| v.as_array()).unwrap_or(&empty_tools);
    let max_tokens: u64 = 32000;
    let temperature = body.get("temperature").cloned();
    let top_p = body.get("top_p").cloned();

    // Strip -agentic suffix if present (handled by executor in full Node)
    let upstream_model = model;

    let kiro = convert_openai_messages_to_kiro(messages, upstream_model);

    let current_msg = kiro.current_message.unwrap_or(json!({
        "userInputMessage": { "content": "", "modelId": upstream_model }
    }));

    let current_user_msg = current_msg.get("userInputMessage").unwrap_or(&Value::Null);
    let content = current_user_msg.get("content").and_then(|v| v.as_str()).unwrap_or("");

    let mut current_message = json!({
        "userInputMessage": {
            "content": content,
            "modelId": upstream_model,
            "origin": "AI_EDITOR"
        }
    });

    // Attach images if present
    if let Some(images) = current_user_msg.get("images") {
        if images.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            current_message["userInputMessage"]["images"] = images.clone();
        }
    }

    // Attach context if present
    if let Some(ctx) = current_user_msg.get("userInputMessageContext") {
        if !ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            current_message["userInputMessage"]["userInputMessageContext"] = ctx.clone();
        }
    }

    let mut payload = json!({
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": format!("conv_{}", chrono::Utc::now().timestamp_millis()),
            "agentContinuationId": format!("cont_{}", chrono::Utc::now().timestamp_millis()),
            "agentTaskType": "vibe",
            "currentMessage": current_message,
            "history": Value::Array(kiro.history)
        },
        "agentMode": "vibe"
    });

    if max_tokens > 0 || temperature.is_some() || top_p.is_some() {
        let mut inference_config = serde_json::Map::new();
        if max_tokens > 0 {
            inference_config.insert("maxTokens".to_string(), json!(max_tokens));
        }
        if let Some(temp) = temperature {
            inference_config.insert("temperature".to_string(), temp);
        }
        if let Some(tp) = top_p {
            inference_config.insert("topP".to_string(), tp);
        }
        payload["inferenceConfig"] = Value::Object(inference_config);
    }

    payload
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: Claude -> Kiro (direct route)
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Claude messages to Kiro history + currentMessage.
fn convert_claude_messages_to_kiro(messages: &[Value], model: &str) -> KiroHistory {
    let mut history = Vec::new();
    let mut current_message: Option<Value> = None;

    let mut pending_user_content: Vec<String> = Vec::new();
    let mut pending_assistant_content: Vec<String> = Vec::new();
    let mut pending_tool_results: Vec<Value> = Vec::new();
    let mut pending_images: Vec<Value> = Vec::new();
    let mut current_role: Option<&str> = None;

    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

        if current_role.is_some() && current_role != Some(role) {
            flush_claude_pending(
                &mut history, &mut current_message,
                &mut pending_user_content, &mut pending_assistant_content,
                &mut pending_tool_results, &mut pending_images,
                &mut current_role,
            );
        }
        current_role = Some(role);

        if role == ROLE_USER {
            if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                pending_user_content.push(s.to_string());
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                for block in arr {
                    let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match bt {
                        CLAUDE_BLOCK_TEXT => {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                pending_user_content.push(text.to_string());
                            }
                        }
                        CLAUDE_BLOCK_IMAGE => {
                            if let Some(source) = block.get("source") {
                                if source.get("type").and_then(|v| v.as_str()) == Some("base64") {
                                    if let (Some(media_type), Some(data)) = (
                                        source.get("media_type").and_then(|v| v.as_str()),
                                        source.get("data").and_then(|v| v.as_str()),
                                    ) {
                                        let format = media_type.split('/').nth(1).unwrap_or(media_type).to_string();
                                        pending_images.push(json!({ "format": format, "source": { "bytes": data } }));
                                    }
                                }
                            }
                        }
                        CLAUDE_BLOCK_TOOL_RESULT => {
                            let result_content = if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
                                s.to_string()
                            } else if let Some(arr) = block.get("content").and_then(|v| v.as_array()) {
                                let texts: Vec<String> = arr.iter()
                                    .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TEXT))
                                    .filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                                    .collect();
                                if texts.is_empty() {
                                    serde_json::to_string(block.get("content").unwrap_or(&Value::Null)).unwrap_or_default()
                                } else {
                                    texts.join("\n")
                                }
                            } else if !block.get("content").unwrap_or(&Value::Null).is_null() {
                                serde_json::to_string(block.get("content").unwrap_or(&Value::Null)).unwrap_or_default()
                            } else {
                                String::new()
                            };
                            pending_tool_results.push(json!({
                                "toolUseId": block.get("tool_use_id").cloned().unwrap_or(Value::Null),
                                "status": if block.get("is_error").and_then(|v| v.as_bool()) == Some(true) { "error" } else { "success" },
                                "content": [{ "text": result_content }]
                            }));
                        }
                        _ => {}
                    }
                }
            }
        } else if role == ROLE_ASSISTANT {
            let mut text_content = String::new();
            let mut tool_uses: Vec<Value> = Vec::new();

            if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
                text_content = s.to_string();
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                for block in arr {
                    let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match bt {
                        CLAUDE_BLOCK_TEXT => {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                text_content.push_str(text);
                            }
                        }
                        CLAUDE_BLOCK_TOOL_USE => {
                            tool_uses.push(json!({
                                "toolUseId": block.get("id").cloned().unwrap_or(Value::Null),
                                "name": block.get("name").cloned().unwrap_or(Value::Null),
                                "input": block.get("input").cloned().unwrap_or(json!({}))
                            }));
                        }
                        _ => {}
                    }
                }
            }

            if !text_content.trim().is_empty() {
                pending_assistant_content.push(text_content);
            }

            if !tool_uses.is_empty() {
                flush_claude_pending(
                    &mut history, &mut current_message,
                    &mut pending_user_content, &mut pending_assistant_content,
                    &mut pending_tool_results, &mut pending_images,
                    &mut current_role,
                );
                if let Some(last) = history.last_mut() {
                    if let Some(assistant_msg) = last.get_mut("assistantResponseMessage") {
                        assistant_msg["toolUses"] = Value::Array(tool_uses);
                    }
                }
                current_role = None;
            }
        }
    }

    if current_role.is_some() {
        flush_claude_pending(
            &mut history, &mut current_message,
            &mut pending_user_content, &mut pending_assistant_content,
            &mut pending_tool_results, &mut pending_images,
            &mut current_role,
        );
    }

    // Pop last userInputMessage as currentMessage
    for i in (0..history.len()).rev() {
        if history[i].get("userInputMessage").is_some() {
            current_message = Some(history.remove(i));
            break;
        }
    }

    // Clean up and merge consecutive user turns
    for item in &mut history {
        if let Some(user_msg) = item.get_mut("userInputMessage") {
            if user_msg.get("modelId").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                user_msg["modelId"] = json!(model);
            }
        }
    }

    let mut merged: Vec<Value> = Vec::new();
    for item in history {
        if item.get("userInputMessage").is_some() {
            if let Some(last) = merged.last_mut() {
                if last.get("userInputMessage").is_some() {
                    let prev_content = last["userInputMessage"]["content"].as_str().unwrap_or("").to_string();
                    let cur_content = item["userInputMessage"]["content"].as_str().unwrap_or("").to_string();
                    last["userInputMessage"]["content"] = json!(format!("{}\n\n{}", prev_content, cur_content));
                    continue;
                }
            }
        }
        merged.push(item);
    }

    if current_message.is_none() {
        current_message = Some(json!({ "userInputMessage": { "content": "", "modelId": model } }));
    }

    KiroHistory {
        history: merged,
        current_message,
    }
}

#[allow(clippy::too_many_arguments)]
fn flush_claude_pending(
    history: &mut Vec<Value>,
    current_message: &mut Option<Value>,
    pending_user_content: &mut Vec<String>,
    pending_assistant_content: &mut Vec<String>,
    pending_tool_results: &mut Vec<Value>,
    pending_images: &mut Vec<Value>,
    current_role: &mut Option<&str>,
) {
    let role = current_role.take();
    match role {
        Some(ROLE_USER) => {
            let content = if pending_user_content.is_empty() {
                "continue".to_string()
            } else {
                let joined = pending_user_content.join("\n\n");
                if joined.trim().is_empty() { "continue".to_string() } else { joined }
            };
            let mut user_msg = json!({
                "userInputMessage": { "content": content, "modelId": "" }
            });
            if !pending_images.is_empty() {
                user_msg["userInputMessage"]["images"] = Value::Array(pending_images.drain(..).collect());
            }
            if !pending_tool_results.is_empty() {
                user_msg["userInputMessage"]["userInputMessageContext"] = json!({
                    "toolResults": pending_tool_results.drain(..).collect::<Vec<_>>()
                });
            }
            history.push(user_msg.clone());
            *current_message = Some(user_msg);
            pending_user_content.clear();
        }
        Some(ROLE_ASSISTANT) => {
            let content = if pending_assistant_content.is_empty() {
                "...".to_string()
            } else {
                let joined = pending_assistant_content.join("\n\n");
                if joined.trim().is_empty() { "...".to_string() } else { joined }
            };
            history.push(json!({ "assistantResponseMessage": { "content": content } }));
            pending_assistant_content.clear();
        }
        _ => {}
    }
}

/// Convert Claude Messages API request to Kiro/AWS CodeWhisperer format (direct route).
/// Ported from claude-to-kiro.js `claudeToKiroRequest`.
pub fn claude_to_kiro_request(model: &str, body: &Value, stream: bool) -> Value {
    let empty_msgs: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(|v| v.as_array()).unwrap_or(&empty_msgs);
    let max_tokens = body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(32000);
    let temperature = body.get("temperature").cloned();
    let top_p = body.get("top_p").cloned();

    let kiro = convert_claude_messages_to_kiro(messages, model);

    let current_msg = kiro.current_message.unwrap_or(json!({
        "userInputMessage": { "content": "", "modelId": model }
    }));

    let current_user_msg = current_msg.get("userInputMessage").unwrap_or(&Value::Null);
    let content = current_user_msg.get("content").and_then(|v| v.as_str()).unwrap_or("");

    let mut current_message = json!({
        "userInputMessage": {
            "content": content,
            "modelId": model,
            "origin": "AI_EDITOR"
        }
    });

    if let Some(ctx) = current_user_msg.get("userInputMessageContext") {
        if !ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            current_message["userInputMessage"]["userInputMessageContext"] = ctx.clone();
        }
    }
    if let Some(images) = current_user_msg.get("images") {
        if images.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            current_message["userInputMessage"]["images"] = images.clone();
        }
    }

    let mut payload = json!({
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": format!("conv_{}", chrono::Utc::now().timestamp_millis()),
            "agentContinuationId": format!("cont_{}", chrono::Utc::now().timestamp_millis()),
            "agentTaskType": "vibe",
            "currentMessage": current_message,
            "history": Value::Array(kiro.history)
        },
        "agentMode": "vibe"
    });

    if max_tokens > 0 || temperature.is_some() || top_p.is_some() {
        let mut inference_config = serde_json::Map::new();
        if max_tokens > 0 {
            inference_config.insert("maxTokens".to_string(), json!(max_tokens));
        }
        if let Some(temp) = temperature {
            inference_config.insert("temperature".to_string(), temp);
        }
        if let Some(tp) = top_p {
            inference_config.insert("topP".to_string(), tp);
        }
        payload["inferenceConfig"] = Value::Object(inference_config);
    }

    payload
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Kiro -> OpenAI
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Kiro streaming event to OpenAI SSE format.
/// Ported from kiro-to-openai.js `kiroToOpenAIResponse`.
pub fn kiro_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    // If chunk is already in OpenAI format, return as-is
    if chunk.get("object").and_then(|v| v.as_str()) == Some("chat.completion.chunk")
        && chunk.get("choices").is_some()
    {
        return vec![chunk.clone()];
    }

    // Initialize state
    if !state.has("responseId") {
        state.set("responseId", json!(format!("chatcmpl-{}", chrono::Utc::now().timestamp_millis())));
        state.set("created", json!(chrono::Utc::now().timestamp() as u64));
        state.set("chunkIndex", json!(0));
    }

    let response_id = state.get("responseId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let created = state.get("created").and_then(|v| v.as_u64()).unwrap_or(0);
    let model = state.get("model").and_then(|v| v.as_str()).unwrap_or("kiro").to_string();

    let event_type = chunk.get("_eventType").and_then(|v| v.as_str())
        .or_else(|| chunk.get("event").and_then(|v| v.as_str()))
        .unwrap_or("");

    let chunk_index = state.get("chunkIndex").and_then(|v| v.as_u64()).unwrap_or(0);

    // Handle assistantResponseEvent
    if event_type == "assistantResponseEvent" || chunk.get("assistantResponseEvent").is_some() {
        let content = chunk.get("assistantResponseEvent")
            .and_then(|v| v.get("content"))
            .or_else(|| chunk.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if content.is_empty() {
            return vec![];
        }

        let mut delta = json!({ "content": content });
        if chunk_index == 0 {
            delta["role"] = json!(ROLE_ASSISTANT);
        }

        state.set("chunkIndex", json!(chunk_index + 1));
        return vec![build_chunk(&response_id, created, &model, delta, None)];
    }

    // Handle reasoningContentEvent
    if event_type == "reasoningContentEvent" || chunk.get("reasoningContentEvent").is_some() {
        let reasoning = chunk.get("reasoningContentEvent").unwrap_or(chunk);
        let content = if let Some(s) = reasoning.as_str() {
            s.to_string()
        } else {
            reasoning.get("text").and_then(|v| v.as_str())
                .or_else(|| reasoning.get("content").and_then(|v| v.as_str()))
                .or_else(|| chunk.get("content").and_then(|v| v.as_str()))
                .unwrap_or("").to_string()
        };
        if content.is_empty() {
            return vec![];
        }

        let delta = reasoning_delta(&content, chunk_index == 0);
        state.set("chunkIndex", json!(chunk_index + 1));
        return vec![build_chunk(&response_id, created, &model, delta, None)];
    }

    // Handle toolUseEvent
    if event_type == "toolUseEvent" || chunk.get("toolUseEvent").is_some() {
        state.set("hadToolUse", json!(true));
        let tool_use = chunk.get("toolUseEvent").unwrap_or(chunk);
        let tool_call_id = tool_use.get("toolUseId").and_then(|v| v.as_str()).unwrap_or("");
        let tool_name = tool_use.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let tool_input = tool_use.get("input").cloned().unwrap_or(json!({}));

        let id = if tool_call_id.is_empty() {
            fallback_tool_call_id(Some(0))
        } else {
            tool_call_id.to_string()
        };

        let mut delta = json!({
            "tool_calls": [{
                "index": 0,
                "id": id,
                "type": OPENAI_BLOCK_FUNCTION,
                "function": {
                    "name": tool_name,
                    "arguments": serde_json::to_string(&tool_input).unwrap_or_else(|_| "{}".to_string())
                }
            }]
        });
        if chunk_index == 0 {
            delta["role"] = json!(ROLE_ASSISTANT);
        }

        state.set("chunkIndex", json!(chunk_index + 1));
        return vec![build_chunk(&response_id, created, &model, delta, None)];
    }

    // Handle completion/done events
    if event_type == "messageStopEvent" || event_type == "done" || chunk.get("messageStopEvent").is_some() {
        let had_tool_use = state.get("hadToolUse").and_then(|v| v.as_bool()).unwrap_or(false);
        let finish_reason = to_openai_finish(if had_tool_use { "tool_use" } else { "stop" }, "kiro");
        state.set("finishReason", json!(finish_reason.clone()));

        let mut final_chunk = build_chunk(&response_id, created, &model, json!({}), Some(&finish_reason));
        if let Some(usage) = state.get("usage").cloned() {
            final_chunk["usage"] = usage;
        }
        return vec![final_chunk];
    }

    // Handle usage events
    if event_type == "usageEvent" || chunk.get("usageEvent").is_some() {
        let usage_data = chunk.get("usageEvent").unwrap_or(chunk);
        if let Some(usage) = to_openai_usage(usage_data, "kiro") {
            state.set("usage", usage);
        }
        return vec![];
    }

    vec![]
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Kiro -> Claude (direct route)
// ═══════════════════════════════════════════════════════════════════════════════

fn stop_kiro_thinking_block(state: &mut ResponseState, results: &mut Vec<Value>) {
    let started = state.get("thinkingBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
    if started {
        let idx = state.get("thinkingBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
        results.push(json!({ "type": "content_block_stop", "index": idx }));
        state.set("thinkingBlockStarted", json!(false));
    }
}

fn stop_kiro_text_block(state: &mut ResponseState, results: &mut Vec<Value>) {
    let started = state.get("textBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
    let closed = state.get("textBlockClosed").and_then(|v| v.as_bool()).unwrap_or(false);
    if started && !closed {
        state.set("textBlockClosed", json!(true));
        let idx = state.get("textBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
        results.push(json!({ "type": "content_block_stop", "index": idx }));
        state.set("textBlockStarted", json!(false));
    }
}

fn convert_kiro_finish_reason(reason: &str) -> &str {
    match reason {
        "stop" => CLAUDE_STOP_END_TURN,
        "length" => CLAUDE_STOP_MAX_TOKENS,
        "tool_calls" => CLAUDE_STOP_TOOL_USE,
        _ => CLAUDE_STOP_END_TURN,
    }
}

/// Convert one OpenAI-format chunk (from KiroExecutor) into Claude SSE events.
/// Ported from kiro-to-claude.js `kiroToClaudeResponse`.
pub fn kiro_to_claude_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    let choices = match chunk.get("choices").and_then(|v| v.as_array()) {
        Some(c) if !c.is_empty() => c,
        _ => return vec![],
    };

    let choice = &choices[0];
    let delta = choice.get("delta").unwrap_or(&Value::Null);
    let mut results = Vec::new();

    // Track usage
    if let Some(usage) = chunk.get("usage") {
        let prompt_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let mut usage_obj = json!({ "input_tokens": prompt_tokens, "output_tokens": output_tokens });
        let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64())
            .or_else(|| usage.get("prompt_tokens_details").and_then(|v| v.get("cached_tokens")).and_then(|v| v.as_u64()));
        let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64())
            .or_else(|| usage.get("prompt_tokens_details").and_then(|v| v.get("cache_creation_tokens")).and_then(|v| v.as_u64()));
        if let Some(cr) = cache_read {
            usage_obj["cache_read_input_tokens"] = json!(cr);
        }
        if let Some(cc) = cache_creation {
            usage_obj["cache_creation_input_tokens"] = json!(cc);
        }
        state.set("usage", usage_obj);
    }

    // First chunk: emit message_start
    if !state.get("messageStartSent").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.set("messageStartSent", json!(true));
        let msg_id = chunk.get("id").and_then(|v| v.as_str())
            .map(|s| s.replace("chatcmpl-", ""))
            .filter(|s| s.len() >= 8 && s != "chat")
            .unwrap_or_else(|| format!("msg_{}", chrono::Utc::now().timestamp_millis()));
        state.set("messageId", json!(msg_id.clone()));
        state.set("model", chunk.get("model").cloned().unwrap_or(json!("kiro")));
        state.set("nextBlockIndex", json!(0));

        results.push(json!({
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": ROLE_ASSISTANT,
                "model": chunk.get("model").cloned().unwrap_or(json!("kiro")),
                "content": [],
                "stop_reason": Value::Null,
                "stop_sequence": Value::Null,
                "usage": { "input_tokens": 0, "output_tokens": 0 }
            }
        }));
    }

    // Reasoning/thinking content
    let reasoning_content = delta.get("reasoning_content").and_then(|v| v.as_str())
        .or_else(|| delta.get("reasoning").and_then(|v| v.as_str()));
    if let Some(reasoning) = reasoning_content {
    if !reasoning.is_empty() {
            stop_kiro_text_block(state, &mut results);

            let started = state.get("thinkingBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
            if !started {
                let next_block = state.get("nextBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("thinkingBlockIndex", json!(next_block));
                state.set("thinkingBlockStarted", json!(true));
                state.set("nextBlockIndex", json!(next_block + 1));

                results.push(json!({
                    "type": "content_block_start",
                    "index": next_block,
                    "content_block": { "type": CLAUDE_BLOCK_THINKING, "thinking": "" }
                }));
            }

            let thinking_idx = state.get("thinkingBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
            results.push(json!({
                "type": "content_block_delta",
                "index": thinking_idx,
                "delta": { "type": "thinking_delta", "thinking": reasoning }
            }));
        }
    }

    // Regular text content
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
    if !content.is_empty() {
            stop_kiro_thinking_block(state, &mut results);

            let started = state.get("textBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
            if !started {
                let next_block = state.get("nextBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("textBlockIndex", json!(next_block));
                state.set("textBlockStarted", json!(true));
                state.set("textBlockClosed", json!(false));
                state.set("nextBlockIndex", json!(next_block + 1));

                results.push(json!({
                    "type": "content_block_start",
                    "index": next_block,
                    "content_block": { "type": CLAUDE_BLOCK_TEXT, "text": "" }
                }));
            }

            let text_idx = state.get("textBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
            results.push(json!({
                "type": "content_block_delta",
                "index": text_idx,
                "delta": { "type": "text_delta", "text": content }
            }));
        }
    }

    // Tool calls
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
    if !tool_calls.is_empty() {
            for tc in tool_calls {
                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if !tc_id.is_empty() && !state.has(&format!("kiroToolCall.{}", idx)) {
                    stop_kiro_thinking_block(state, &mut results);
                    stop_kiro_text_block(state, &mut results);

                    let next_block = state.get("nextBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                    state.set("nextBlockIndex", json!(next_block + 1));

                    let tool_name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                    state.set(&format!("kiroToolCall.{}", idx), json!({
                        "id": tc_id,
                        "name": tool_name,
                        "blockIndex": next_block
                    }));

                    results.push(json!({
                        "type": "content_block_start",
                        "index": next_block,
                        "content_block": {
                            "type": CLAUDE_BLOCK_TOOL_USE,
                            "id": tc_id,
                            "name": tool_name,
                            "input": {}
                        }
                    }));
                }

                // Buffer arguments
                if let Some(args) = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()) {
                if !args.is_empty() {
                    let key = format!("kiroToolArgBuf.{}", idx);
                    let current = state.get(&key).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    state.set(&key, json!(format!("{}{}", current, args)));
                }
                }
            }
        }
    }

    // Finish
    if let Some(finish_reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
    if !finish_reason.is_empty() && finish_reason != "null" {
            stop_kiro_thinking_block(state, &mut results);
            stop_kiro_text_block(state, &mut results);

        // Emit buffered tool args and stop blocks
        // Find all tool calls in state
        let mut i = 0;
        loop {
            let key = format!("kiroToolCall.{}", i);
            match state.get(&key) {
                Some(tool_info) => {
                    let block_index = tool_info.get("blockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                    let buf_key = format!("kiroToolArgBuf.{}", i);
                    if let Some(buffered) = state.get(&buf_key).and_then(|v| v.as_str()) {
                    if !buffered.is_empty() {
                        results.push(json!({
                            "type": "content_block_delta",
                            "index": block_index,
                            "delta": { "type": "input_json_delta", "partial_json": buffered }
                        }));
                    }
                    }
                    results.push(json!({
                        "type": "content_block_stop",
                        "index": block_index
                    }));
                    i += 1;
                }
                None => break,
            }
        }

            state.set("finishReason", json!(finish_reason));
            let final_usage = state.get("usage").cloned().unwrap_or(json!({ "input_tokens": 0, "output_tokens": 0 }));
            let stop_reason = convert_kiro_finish_reason(finish_reason);
        results.push(json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason },
            "usage": final_usage
        }));
        results.push(json!({ "type": "message_stop" }));
    }
    }

    results
}
