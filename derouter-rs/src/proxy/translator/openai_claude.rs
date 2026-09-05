//! OpenAI ↔ Claude translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/claude-to-openai.js
//! - open-sse/translator/request/openai-to-claude.js
//! - open-sse/translator/response/claude-to-openai.js
//! - open-sse/translator/response/openai-to-claude.js
//!
//! Field mappings match the Node adapters exactly: message role mapping, content blocks,
//! tool calls, system prompts, stop reasons, usage fields.

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ── Constants ────────────────────────────────────────────────────────────────

/// Empty prefix matches real Claude Code behavior (no tool name prefix).
const CLAUDE_OAUTH_TOOL_PREFIX: &str = "";

/// Strip "x-anthropic-billing-header:" line from text.
fn strip_anthropic_billing_header(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Match: ^x-anthropic-billing-header:<anything>\n?
    if let Some(rest) = text
        .strip_prefix("x-anthropic-billing-header:")
        .or_else(|| text.strip_prefix("X-Anthropic-Billing-Header:"))
    {
        // Skip to end of line
        if let Some(nl) = rest.find('\n') {
            rest[nl + 1..].to_string()
        } else {
            String::new()
        }
    } else {
        text.to_string()
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: Claude → OpenAI
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Claude request to OpenAI Chat Completions format.
/// Ported from claude-to-openai.js `claudeToOpenAIRequest`.
pub fn claude_to_openai_request(model: &str, body: &Value, stream: bool) -> Value {
    let mut result = json!({
        "model": model,
        "messages": [],
        "stream": stream
    });

    // Max tokens
    if let Some(max_tokens) = body.get("max_tokens").and_then(|v| v.as_u64()) {
        let temp_body = json!({ "max_tokens": max_tokens, "tools": body.get("tools").cloned().unwrap_or(Value::Null) });
        let adjusted = adjust_max_tokens(&temp_body, DEFAULT_MAX_TOKENS);
        result["max_tokens"] = json!(adjusted);
    }

    // Temperature
    if let Some(temp) = body.get("temperature") {
        result["temperature"] = temp.clone();
    }

    // System message
    if let Some(system) = body.get("system") {
        let system_content = if let Some(arr) = system.as_array() {
            arr.iter()
                .filter_map(|s| {
                    let text = s.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let stripped = strip_anthropic_billing_header(text);
                    if stripped.is_empty() {
                        None
                    } else {
                        Some(stripped)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else if let Some(s) = system.as_str() {
            strip_anthropic_billing_header(s)
        } else {
            String::new()
        };

        if !system_content.is_empty() {
            if let Some(messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
                messages.push(json!({ "role": ROLE_SYSTEM, "content": system_content }));
            }
        }
    }

    // Convert messages
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        if let Some(result_messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for msg in messages {
                let converted = convert_claude_message(msg);
                match converted {
                    ConvertedMessage::Single(m) => result_messages.push(m),
                    ConvertedMessage::Multiple(ms) => {
                        for m in ms {
                            result_messages.push(m);
                        }
                    }
                    ConvertedMessage::None => {}
                }
            }

            // Fix missing tool responses — OpenAI requires every tool_call to have a response
            fix_missing_tool_responses_openai(result_messages);
        }
    }

    // Tools
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let openai_tools: Vec<Value> = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": {
                        "name": tool.get("name").cloned().unwrap_or(Value::Null),
                        "description": tool.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                        "parameters": tool.get("input_schema").cloned().unwrap_or(json!({"type": "object", "properties": {}}))
                    }
                })
            })
            .collect();
        result["tools"] = Value::Array(openai_tools);
    }

    // Tool choice
    if let Some(tc) = body.get("tool_choice") {
        result["tool_choice"] = convert_tool_choice(tc);
    }

    // Reasoning effort
    if let Some(effort) = body.get("reasoning_effort") {
        result["reasoning_effort"] = effort.clone();
    } else if let Some(effort) = body.get("reasoning").and_then(|v| v.get("effort")) {
        result["reasoning_effort"] = effort.clone();
    }

    // Reasoning object passthrough
    if let Some(reasoning) = body.get("reasoning") {
        result["reasoning"] = reasoning.clone();
    }

    result
}

enum ConvertedMessage {
    None,
    Single(Value),
    Multiple(Vec<Value>),
}

/// Wrap mid-conversation system text so it ends as a user turn.
fn system_reminder_text(content: &Value) -> String {
    let parts: Vec<String> = if let Some(arr) = content.as_array() {
        arr.iter()
            .filter_map(|c| {
                if c.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TEXT) {
                    c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect()
    } else if let Some(s) = content.as_str() {
        vec![s.to_string()]
    } else {
        vec![]
    };
    let text = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n");
    if text.trim().is_empty() {
        return String::new();
    }
    format!("<instructions>\n{}\n</instructions>", text)
}

/// Convert a single Claude message to OpenAI format. Returns one or more messages.
fn convert_claude_message(msg: &Value) -> ConvertedMessage {
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

    // Mid-conversation system message → user
    if role == ROLE_SYSTEM {
        let text = system_reminder_text(msg.get("content").unwrap_or(&Value::Null));
        if text.is_empty() {
            return ConvertedMessage::None;
        }
        return ConvertedMessage::Single(json!({ "role": ROLE_USER, "content": text }));
    }

    let openai_role = if role == ROLE_USER || role == ROLE_TOOL {
        ROLE_USER
    } else {
        ROLE_ASSISTANT
    };

    // Simple string content
    if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
        return ConvertedMessage::Single(json!({ "role": openai_role, "content": content }));
    }

    // Array content
    if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
        let mut parts = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();

        for block in content {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match block_type {
                CLAUDE_BLOCK_TEXT => {
                    if let Some(text) = block.get("text") {
                        parts.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
                    }
                }
                CLAUDE_BLOCK_IMAGE => {
                    if let Some(source) = block.get("source") {
                        if source.get("type").and_then(|v| v.as_str()) == Some("base64") {
                            if let (Some(mime), Some(data)) = (
                                source.get("media_type").and_then(|v| v.as_str()),
                                source.get("data").and_then(|v| v.as_str()),
                            ) {
                                let url = encode_data_uri(mime, data);
                                parts.push(json!({
                                    "type": OPENAI_BLOCK_IMAGE_URL,
                                    "image_url": { "url": url }
                                }));
                            }
                        }
                    }
                }
                CLAUDE_BLOCK_TOOL_USE => {
                    let id = block.get("id").cloned().unwrap_or(Value::Null);
                    let name = block.get("name").cloned().unwrap_or(Value::Null);
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    let args_str = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
                    tool_calls.push(json!({
                        "id": id,
                        "type": OPENAI_BLOCK_FUNCTION,
                        "function": { "name": name, "arguments": args_str }
                    }));
                }
                CLAUDE_BLOCK_TOOL_RESULT => {
                    let result_content = if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
                        s.to_string()
                    } else if let Some(arr) = block.get("content").and_then(|v| v.as_array()) {
                        let texts: Vec<String> = arr
                            .iter()
                            .filter(|c| c.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TEXT))
                            .filter_map(|c| c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect();
                        let joined = texts.join("\n");
                        if joined.is_empty() {
                            serde_json::to_string(block.get("content").unwrap_or(&Value::Null))
                                .unwrap_or_default()
                        } else {
                            joined
                        }
                    } else if !block.get("content").unwrap_or(&Value::Null).is_null() {
                        serde_json::to_string(block.get("content").unwrap_or(&Value::Null))
                            .unwrap_or_default()
                    } else {
                        String::new()
                    };

                    let tool_use_id = block.get("tool_use_id").cloned().unwrap_or(Value::Null);
                    tool_results.push(json!({
                        "role": ROLE_TOOL,
                        "tool_call_id": tool_use_id,
                        "content": result_content
                    }));
                }
                _ => {}
            }
        }

        // If has tool results, return array of tool messages
        if !tool_results.is_empty() {
            let mut all = tool_results;
            if !parts.is_empty() {
                let collapsed = collapse_text_parts(&parts);
                all.push(json!({ "role": ROLE_USER, "content": collapsed }));
            }
            return ConvertedMessage::Multiple(all);
        }

        // If has tool calls, return assistant message with tool_calls
        if !tool_calls.is_empty() {
            let mut result_msg = serde_json::Map::new();
            result_msg.insert("role".to_string(), json!(ROLE_ASSISTANT));
            if !parts.is_empty() {
                let collapsed = collapse_text_parts(&parts);
                result_msg.insert("content".to_string(), collapsed);
            }
            result_msg.insert("tool_calls".to_string(), Value::Array(tool_calls));
            return ConvertedMessage::Single(Value::Object(result_msg));
        }

        // Return content
        if !parts.is_empty() {
            let collapsed = collapse_text_parts(&parts);
            return ConvertedMessage::Single(json!({ "role": openai_role, "content": collapsed }));
        }

        // Empty content array
        if content.is_empty() {
            return ConvertedMessage::Single(json!({ "role": openai_role, "content": "" }));
        }
    }

    ConvertedMessage::None
}

/// Fix missing tool responses — add empty responses for tool_calls without responses.
fn fix_missing_tool_responses_openai(messages: &mut Vec<Value>) {
    let mut i = 0;
    while i < messages.len() {
        let is_assistant_with_tool_calls = {
            let msg = &messages[i];
            msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_ASSISTANT)
                && msg.get("tool_calls").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false)
        };

        if is_assistant_with_tool_calls {
            let tool_call_ids: Vec<String> = messages[i]
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .unwrap()
                .iter()
                .filter_map(|tc| tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();

            // Collect all tool response IDs that immediately follow
            let mut responded_ids = std::collections::HashSet::new();
            let mut insert_position = i + 1;
            for j in (i + 1)..messages.len() {
                let next_msg = &messages[j];
                if next_msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_TOOL)
                    && next_msg.get("tool_call_id").is_some()
                {
                    if let Some(id) = next_msg.get("tool_call_id").and_then(|v| v.as_str()) {
                        responded_ids.insert(id.to_string());
                    }
                    insert_position = j + 1;
                } else {
                    break;
                }
            }

            // Find missing responses and insert them
            let missing_ids: Vec<String> = tool_call_ids
                .iter()
                .filter(|id| !responded_ids.contains(*id))
                .cloned()
                .collect();

            if !missing_ids.is_empty() {
                let missing_responses: Vec<Value> = missing_ids
                    .iter()
                    .map(|id| json!({ "role": ROLE_TOOL, "tool_call_id": id, "content": "[No response received]" }))
                    .collect();
                let count = missing_responses.len();
                for (offset, resp) in missing_responses.into_iter().enumerate() {
                    messages.insert(insert_position + offset, resp);
                }
                i = insert_position + count - 1;
            }
        }
        i += 1;
    }
}

/// Convert Claude tool_choice to OpenAI format.
fn convert_tool_choice(choice: &Value) -> Value {
    if choice.is_null() {
        return json!("auto");
    }
    if let Some(s) = choice.as_str() {
        return json!(s);
    }
    if let Some(choice_type) = choice.get("type").and_then(|v| v.as_str()) {
        return match choice_type {
            "auto" => json!("auto"),
            "any" => json!("required"),
            "tool" => json!({ "type": OPENAI_BLOCK_FUNCTION, "function": { "name": choice.get("name").cloned().unwrap_or(Value::Null) } }),
            _ => json!("auto"),
        };
    }
    json!("auto")
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI → Claude
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert OpenAI Chat Completions request to Claude Messages API format.
/// Ported from openai-to-claude.js `openaiToClaudeRequest`.
pub fn openai_to_claude_request(model: &str, body: &Value, stream: bool) -> Value {
    let ceiling = DEFAULT_MAX_TOKENS; // Model ceiling would come from capabilities; keeping default
    let mut result = json!({
        "model": model,
        "max_tokens": adjust_max_tokens(body, ceiling),
        "stream": stream
    });

    // Temperature
    if let Some(temp) = body.get("temperature") {
        result["temperature"] = temp.clone();
    }

    let mut system_parts = Vec::new();
    let mut result_messages = Vec::new();

    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        // Extract system messages
        for msg in messages {
            if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_SYSTEM) {
                if let Some(content) = msg.get("content") {
                    if let Some(s) = content.as_str() {
                        system_parts.push(s.to_string());
                    } else if let Some(arr) = content.as_array() {
                        let text: String = arr
                            .iter()
                            .filter_map(|p| p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                            .join("\n");
                        system_parts.push(text);
                    }
                }
            }
        }

        // Filter out system messages
        let non_system: Vec<&Value> = messages
            .iter()
            .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some(ROLE_SYSTEM))
            .collect();

        // Process messages with merging logic
        // CRITICAL: tool_result must be in separate message immediately after tool_use
        let mut current_role: Option<&str> = None;
        let mut current_parts: Vec<Value> = Vec::new();

        for msg in &non_system {
            let msg_role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let new_role = if msg_role == ROLE_USER || msg_role == ROLE_TOOL {
                ROLE_USER
            } else {
                ROLE_ASSISTANT
            };
            let blocks = get_content_blocks_from_message(msg);
            let has_tool_use = blocks.iter().any(|b| {
                b.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_USE)
            });
            let has_tool_result = blocks.iter().any(|b| {
                b.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_RESULT)
            });

            // Separate tool_result from other content
            if has_tool_result {
                let tool_result_blocks: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some(CLAUDE_BLOCK_TOOL_RESULT))
                    .cloned()
                    .collect();
                let other_blocks: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|v| v.as_str()) != Some(CLAUDE_BLOCK_TOOL_RESULT))
                    .cloned()
                    .collect();

                // Flush current message
                if let Some(role) = current_role {
                    if !current_parts.is_empty() {
                        result_messages.push(json!({ "role": role, "content": Value::Array(current_parts.clone()) }));
                        current_parts.clear();
                    }
                }

                if !tool_result_blocks.is_empty() {
                    result_messages.push(json!({ "role": ROLE_USER, "content": Value::Array(tool_result_blocks) }));
                }

                if !other_blocks.is_empty() {
                    current_role = Some(new_role);
                    current_parts.extend(other_blocks);
                }
                continue;
            }

            if current_role != Some(new_role) {
                // Flush
                if let Some(role) = current_role {
                    if !current_parts.is_empty() {
                        result_messages.push(json!({ "role": role, "content": Value::Array(current_parts.clone()) }));
                        current_parts.clear();
                    }
                }
                current_role = Some(new_role);
            }

            current_parts.extend(blocks.clone());

            if has_tool_use {
                // Flush
                if let Some(role) = current_role {
                    if !current_parts.is_empty() {
                        result_messages.push(json!({ "role": role, "content": Value::Array(current_parts.clone()) }));
                        current_parts.clear();
                    }
                }
            }
        }

        // Flush remaining
        if let Some(role) = current_role {
            if !current_parts.is_empty() {
                result_messages.push(json!({ "role": role, "content": Value::Array(current_parts.clone()) }));
            }
        }

        // Add cache_control to last assistant message
        let valid_block_types = [
            CLAUDE_BLOCK_TEXT,
            CLAUDE_BLOCK_TOOL_USE,
            CLAUDE_BLOCK_TOOL_RESULT,
            CLAUDE_BLOCK_IMAGE,
        ];
        for i in (0..result_messages.len()).rev() {
            let message = &mut result_messages[i];
            if message.get("role").and_then(|v| v.as_str()) == Some(ROLE_ASSISTANT) {
                if let Some(content) = message.get_mut("content").and_then(|v| v.as_array_mut()) {
                    if !content.is_empty() {
                        for j in (0..content.len()).rev() {
                            let block = &content[j];
                            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if valid_block_types.contains(&block_type) {
                                content[j]["cache_control"] = json!({ "type": "ephemeral" });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    result["messages"] = Value::Array(result_messages);

    // Handle response_format for JSON mode
    if let Some(rf) = body.get("response_format") {
        let rf_type = rf.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match rf_type {
            "json_schema" => {
                if let Some(schema) = rf.get("json_schema").and_then(|v| v.get("schema")) {
                    let schema_str = serde_json::to_string_pretty(schema).unwrap_or_default();
                    system_parts.push(format!(
                        "You must respond with valid JSON that strictly follows this JSON schema:\n```json\n{}\n```\nRespond ONLY with the JSON object, no other text.",
                        schema_str
                    ));
                }
            }
            "json_object" => {
                system_parts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.".to_string());
            }
            _ => {}
        }
    }

    // System with Claude Code prompt and cache_control
    let claude_code_prompt = json!({ "type": CLAUDE_BLOCK_TEXT, "text": CLAUDE_SYSTEM_PROMPT });

    if !system_parts.is_empty() {
        let system_text = system_parts.join("\n");
        result["system"] = json!([
            claude_code_prompt,
            { "type": CLAUDE_BLOCK_TEXT, "text": system_text, "cache_control": { "type": "ephemeral", "ttl": "1h" } }
        ]);
    } else {
        result["system"] = json!([claude_code_prompt]);
    }

    // Tools
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let mut claude_tools = Vec::new();
        for tool in tools {
            let tool_type = tool.get("type").and_then(|v| v.as_str());
            // Pass-through built-in tools without prefix/conversion
            if let Some(tt) = tool_type {
                if tt != OPENAI_BLOCK_FUNCTION {
                    claude_tools.push(tool.clone());
                    continue;
                }
            }

            // Function-shaped tools: { type: "function", function: { name, ... } } or { function: { name, ... } }
            let tool_data = if let Some(f) = tool.get("function") {
                f
            } else {
                tool
            };
            let original_name = tool_data.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let tool_name = format!("{}{}", CLAUDE_OAUTH_TOOL_PREFIX, original_name);

            let input_schema = tool_data
                .get("parameters")
                .cloned()
                .or_else(|| tool_data.get("input_schema").cloned())
                .unwrap_or(json!({"type": "object", "properties": {}, "required": []}));

            claude_tools.push(json!({
                "name": tool_name,
                "description": tool_data.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "input_schema": input_schema
            }));
        }

        if !claude_tools.is_empty() {
            // Add cache_control to last tool
            let len = claude_tools.len();
            claude_tools[len - 1]["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
        }
        result["tools"] = Value::Array(claude_tools);
    }

    // Tool choice
    if let Some(tc) = body.get("tool_choice") {
        if !tc.is_null() {
            result["tool_choice"] = convert_openai_tool_choice(tc);
        }
    }

    result
}

/// Get content blocks from a single OpenAI message → Claude format.
fn get_content_blocks_from_message(msg: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");

    match role {
        ROLE_TOOL => {
            let tool_use_id = msg.get("tool_call_id").cloned().unwrap_or(Value::Null);
            let content = msg.get("content").cloned().unwrap_or(Value::Null);
            blocks.push(json!({
                "type": CLAUDE_BLOCK_TOOL_RESULT,
                "tool_use_id": tool_use_id,
                "content": content
            }));
        }
        ROLE_USER => {
            if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    blocks.push(json!({ "type": CLAUDE_BLOCK_TEXT, "text": content }));
                }
            } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                for part in arr {
                    let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match part_type {
                        OPENAI_BLOCK_TEXT => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    blocks.push(json!({ "type": CLAUDE_BLOCK_TEXT, "text": text }));
                                }
                            }
                        }
                        CLAUDE_BLOCK_TOOL_RESULT => {
                            let mut block = json!({
                                "type": CLAUDE_BLOCK_TOOL_RESULT,
                                "tool_use_id": part.get("tool_use_id").cloned().unwrap_or(Value::Null),
                                "content": part.get("content").cloned().unwrap_or(Value::Null)
                            });
                            if let Some(is_error) = part.get("is_error") {
                                if is_error.as_bool() == Some(true) {
                                    block["is_error"] = json!(true);
                                }
                            }
                            blocks.push(block);
                        }
                        OPENAI_BLOCK_IMAGE_URL => {
                            if let Some(url) = part
                                .get("image_url")
                                .and_then(|v| v.get("url"))
                                .and_then(|v| v.as_str())
                            {
                                if let Some((mime, base64)) = parse_data_uri(url) {
                                    blocks.push(json!({
                                        "type": CLAUDE_BLOCK_IMAGE,
                                        "source": { "type": "base64", "media_type": mime, "data": base64 }
                                    }));
                                } else if url.starts_with("http://") || url.starts_with("https://") {
                                    blocks.push(json!({
                                        "type": CLAUDE_BLOCK_IMAGE,
                                        "source": { "type": "url", "url": url }
                                    }));
                                }
                            }
                        }
                        OPENAI_BLOCK_IMAGE => {
                            if let Some(source) = part.get("source") {
                                blocks.push(json!({ "type": CLAUDE_BLOCK_IMAGE, "source": source }));
                            }
                        }
                        OPENAI_BLOCK_FILE => {
                            if let Some(file) = part.get("file") {
                                if let Some(file_data) = file.get("file_data").and_then(|v| v.as_str()) {
                                    if let Some((mime, base64)) = parse_data_uri(file_data) {
                                        if mime == "application/pdf" {
                                            blocks.push(json!({
                                                "type": CLAUDE_BLOCK_DOCUMENT,
                                                "source": { "type": "base64", "media_type": mime, "data": base64 }
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
        ROLE_ASSISTANT => {
            if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                for part in arr {
                    let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match part_type {
                        OPENAI_BLOCK_TEXT => {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    blocks.push(json!({ "type": CLAUDE_BLOCK_TEXT, "text": text }));
                                }
                            }
                        }
                        CLAUDE_BLOCK_TOOL_USE => {
                            // Tool name already has prefix, keep as-is
                            blocks.push(json!({
                                "type": CLAUDE_BLOCK_TOOL_USE,
                                "id": part.get("id").cloned().unwrap_or(Value::Null),
                                "name": part.get("name").cloned().unwrap_or(Value::Null),
                                "input": part.get("input").cloned().unwrap_or(Value::Null)
                            }));
                        }
                        CLAUDE_BLOCK_THINKING => {
                            // Include thinking block but strip cache_control
                            let mut block = part.clone();
                            if let Some(obj) = block.as_object_mut() {
                                obj.remove("cache_control");
                            }
                            blocks.push(block);
                        }
                        _ => {}
                    }
                }
            } else if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    blocks.push(json!({ "type": CLAUDE_BLOCK_TEXT, "text": content }));
                }
            }

            // Tool calls
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tool_calls {
                    if tc.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_FUNCTION) {
                        let func_name = tc
                            .get("function")
                            .and_then(|v| v.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let tool_name = format!("{}{}", CLAUDE_OAUTH_TOOL_PREFIX, func_name);
                        let args = tc
                            .get("function")
                            .and_then(|v| v.get("arguments"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let input = safe_parse_json(&args, args.clone());
                        blocks.push(json!({
                            "type": CLAUDE_BLOCK_TOOL_USE,
                            "id": tc.get("id").cloned().unwrap_or(Value::Null),
                            "name": tool_name,
                            "input": input
                        }));
                    }
                }
            }
        }
        _ => {}
    }

    blocks
}

/// Convert OpenAI tool_choice to Claude format.
fn convert_openai_tool_choice(choice: &Value) -> Value {
    if choice.is_null() {
        return json!({ "type": "auto" });
    }

    if let Some(s) = choice.as_str() {
        return match s {
            "required" => json!({ "type": "any" }),
            _ => json!({ "type": "auto" }), // "auto", "none", or anything unexpected
        };
    }

    if let Some(obj) = choice.as_object() {
        // OpenAI forced tool: { type: "function", function: { name } }
        if let Some(name) = choice
            .get("function")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            if !name.is_empty() {
                return json!({ "type": "tool", "name": name });
            }
        }
        // Already Claude-native — only pass through accepted types
        if let Some(ct) = choice.get("type").and_then(|v| v.as_str()) {
            match ct {
                "auto" | "any" | "tool" | "none" => return choice.clone(),
                _ => {}
            }
        }
    }

    json!({ "type": "auto" })
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Claude → OpenAI (streaming)
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Claude stream chunk to OpenAI format.
/// Ported from response/claude-to-openai.js `claudeToOpenAIResponse`.
pub fn claude_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    let mut results = Vec::new();
    let event = chunk.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event {
        "message_start" => {
            let msg_id = chunk
                .get("message")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("msg_{}", chrono::Utc::now().timestamp_millis()));
            state.set("messageId", json!(msg_id));
            state.set("toolCallIndex", json!(0));

            let model = chunk
                .get("message")
                .and_then(|v| v.get("model"))
                .cloned()
                .unwrap_or(Value::Null);
            state.set("model", model);

            // Capture usage from message_start (cache tokens)
            if let Some(usage) = chunk.get("message").and_then(|v| v.get("usage")) {
                let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let prompt_tokens = input_tokens + cache_read + cache_creation;
                let mut usage_obj = json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": 0,
                    "total_tokens": prompt_tokens,
                    "input_tokens": input_tokens,
                    "output_tokens": 0
                });
                if cache_read > 0 {
                    usage_obj["cache_read_input_tokens"] = json!(cache_read);
                }
                if cache_creation > 0 {
                    usage_obj["cache_creation_input_tokens"] = json!(cache_creation);
                }
                state.set("usage", usage_obj);
            }

            let id = format!("chatcmpl-{}", msg_id);
            let created = chrono::Utc::now().timestamp() as u64;
            let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
            results.push(build_chunk(&id, created, model_str, json!({ "role": ROLE_ASSISTANT }), None));
        }

        "content_block_start" => {
            let block = chunk.get("content_block").unwrap_or(&Value::Null);
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if block_type == "server_tool_use" {
                state.set("serverToolBlockIndex", json!(chunk.get("index").cloned().unwrap_or(Value::Null)));
                return vec![];
            }

            if block_type == CLAUDE_BLOCK_TEXT {
                state.set("textBlockStarted", json!(true));
            } else if block_type == CLAUDE_BLOCK_THINKING {
                state.set("inThinkingBlock", json!(true));
                state.set("currentBlockIndex", chunk.get("index").cloned().unwrap_or(Value::Null));
                let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                let created = chrono::Utc::now().timestamp() as u64;
                let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                results.push(build_chunk(&id, created, model_str, json!({ "content": "idado" }), None));
            } else if block_type == CLAUDE_BLOCK_TOOL_USE {
                let tool_call_index = state.get("toolCallIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("toolCallIndex", json!(tool_call_index + 1));

                let block_name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let block_id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");

                let tool_call = json!({
                    "index": tool_call_index,
                    "id": block_id,
                    "type": OPENAI_BLOCK_FUNCTION,
                    "function": { "name": block_name, "arguments": "" }
                });

                // Store in state toolCalls map (keyed by chunk index)
                let idx_key = chunk.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                if !state.has("toolCalls") {
                    state.set("toolCalls", json!({}));
                }
                if let Some(tc_map) = state.get_mut("toolCalls").and_then(|v| v.as_object_mut()) {
                    tc_map.insert(idx_key.to_string(), tool_call.clone());
                }

                let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                let created = chrono::Utc::now().timestamp() as u64;
                let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                results.push(build_chunk(&id, created, model_str, json!({ "tool_calls": [tool_call] }), None));
            }
        }

        "content_block_delta" => {
            // Skip deltas for built-in server tool blocks
            let server_idx = state.get("serverToolBlockIndex").and_then(|v| v.as_u64());
            let chunk_idx = chunk.get("index").and_then(|v| v.as_u64());
            if server_idx.is_some() && server_idx == chunk_idx {
                return vec![];
            }

            let delta = chunk.get("delta").unwrap_or(&Value::Null);
            let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if delta_type == "text_delta" {
                if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                        let created = chrono::Utc::now().timestamp() as u64;
                        let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                        results.push(build_chunk(&id, created, model_str, json!({ "content": text }), None));
                    }
                }
            } else if delta_type == "thinking_delta" {
                if let Some(thinking) = delta.get("thinking").and_then(|v| v.as_str()) {
                    if !thinking.is_empty() {
                        let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                        let created = chrono::Utc::now().timestamp() as u64;
                        let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                        results.push(build_chunk(&id, created, model_str, reasoning_delta(thinking, false), None));
                    }
                }
            } else if delta_type == "input_json_delta" {
                if let Some(partial) = delta.get("partial_json").and_then(|v| v.as_str()) {
                    if !partial.is_empty() {
                        let idx_key = chunk.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                        if let Some(tool_call) = state
                            .get("toolCalls")
                            .and_then(|v| v.get(&idx_key.to_string()))
                            .cloned()
                        {
                            // Append arguments
                            let tc_index = tool_call.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                            let tc_id = tool_call.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                            let created = chrono::Utc::now().timestamp() as u64;
                            let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                            results.push(build_chunk(
                                &id,
                                created,
                                model_str,
                                json!({
                                    "tool_calls": [{
                                        "index": tc_index,
                                        "id": tc_id,
                                        "function": { "arguments": partial }
                                    }]
                                }),
                                None,
                            ));
                        }
                    }
                }
            }
        }

        "content_block_stop" => {
            // Skip stop for built-in server tool blocks
            let server_idx = state.get("serverToolBlockIndex").and_then(|v| v.as_u64());
            let chunk_idx = chunk.get("index").and_then(|v| v.as_u64());
            if server_idx.is_some() && server_idx == chunk_idx {
                state.set("serverToolBlockIndex", json!(-1));
                return vec![];
            }

            let in_thinking = state.get("inThinkingBlock").and_then(|v| v.as_bool()).unwrap_or(false);
            let current_block_idx = state.get("currentBlockIndex").and_then(|v| v.as_u64());
            if in_thinking && current_block_idx == chunk_idx {
                let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                let created = chrono::Utc::now().timestamp() as u64;
                let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                results.push(build_chunk(&id, created, model_str, json!({ "content": "idado" }), None));
                state.set("inThinkingBlock", json!(false));
            }
            state.set("textBlockStarted", json!(false));
            state.set("thinkingBlockStarted", json!(false));
        }

        "message_delta" => {
            // Extract usage
            if let Some(usage) = chunk.get("usage") {
                let prev = state.get("usage").cloned().unwrap_or(json!({}));
                let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or_else(|| {
                    prev.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                });
                let output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or_else(|| {
                    prev.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                });
                let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or_else(|| {
                    prev.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                });
                let prompt_tokens = input_tokens + cache_read + cache_creation;

                let mut usage_obj = json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": output_tokens,
                    "total_tokens": prompt_tokens + output_tokens,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens
                });
                if cache_read > 0 {
                    usage_obj["cache_read_input_tokens"] = json!(cache_read);
                }
                if cache_creation > 0 {
                    usage_obj["cache_creation_input_tokens"] = json!(cache_creation);
                }
                state.set("usage", usage_obj);
            }

            // Stop reason
            if let Some(stop_reason) = chunk.get("delta").and_then(|v| v.get("stop_reason")).and_then(|v| v.as_str()) {
                let finish_reason = to_openai_finish(stop_reason, "claude");
                state.set("finishReason", json!(finish_reason));

                let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                let created = chrono::Utc::now().timestamp() as u64;
                let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let mut final_chunk = build_chunk(&id, created, model_str, json!({}), Some(&finish_reason));

                // Attach usage
                if let Some(usage) = state.get("usage").cloned() {
                    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    final_chunk["usage"] = to_openai_usage(
                        &json!({
                            "input_tokens": input,
                            "output_tokens": output,
                            "cache_read_input_tokens": cache_read,
                            "cache_creation_input_tokens": cache_creation
                        }),
                        "claude",
                    ).unwrap_or(json!({}));
                }
                results.push(final_chunk);
                state.set("finishReasonSent", json!(true));
            }
        }

        "message_stop" => {
            let finish_sent = state.get("finishReasonSent").and_then(|v| v.as_bool()).unwrap_or(false);
            if !finish_sent {
                let finish_reason = state.get("finishReason").and_then(|v| v.as_str()).map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        let has_tool_calls = state.get("toolCalls").and_then(|v| v.as_object()).map(|o| !o.is_empty()).unwrap_or(false);
                        if has_tool_calls {
                            OPENAI_FINISH_TOOL_CALLS.to_string()
                        } else {
                            OPENAI_FINISH_STOP.to_string()
                        }
                    });
                let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
                let created = chrono::Utc::now().timestamp() as u64;
                let model_str = state.get("model").and_then(|v| v.as_str()).unwrap_or("");
                let mut chunk = build_chunk(&id, created, model_str, json!({}), Some(&finish_reason));
                if let Some(usage) = state.get("usage").cloned() {
                    chunk["usage"] = usage;
                }
                results.push(chunk);
                state.set("finishReasonSent", json!(true));
            }
        }

        _ => {}
    }

    results
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: OpenAI → Claude (streaming)
// ═══════════════════════════════════════════════════════════════════════════════

/// Legacy "proxy_" prefix — response strips it defensively.
const CLAUDE_OAUTH_TOOL_PREFIX_RESPONSE: &str = "proxy_";

/// Convert OpenAI stream chunk to Claude format.
/// Ported from response/openai-to-claude.js `openaiToClaudeResponse`.
pub fn openai_to_claude_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
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
        let cached_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|v| v.get("cached_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_creation = usage
            .get("prompt_tokens_details")
            .and_then(|v| v.get("cache_creation_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let input_tokens = prompt_tokens.saturating_sub(cached_tokens.saturating_add(cache_creation));

        let mut usage_obj = json!({ "input_tokens": input_tokens, "output_tokens": output_tokens });
        if cached_tokens > 0 {
            usage_obj["cache_read_input_tokens"] = json!(cached_tokens);
        }
        if cache_creation > 0 {
            usage_obj["cache_creation_input_tokens"] = json!(cache_creation);
        }
        state.set("usage", usage_obj);
    }

    // First chunk — send message_start
    let message_start_sent = state.get("messageStartSent").and_then(|v| v.as_bool()).unwrap_or(false);
    if !message_start_sent {
        state.set("messageStartSent", json!(true));
        let msg_id = chunk
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.replace("chatcmpl-", ""))
            .filter(|s| s.len() >= 8 && s != "chat")
            .unwrap_or_else(|| format!("msg_{}", chrono::Utc::now().timestamp_millis()));
        state.set("messageId", json!(msg_id));

        let model = chunk.get("model").cloned().unwrap_or(json!(MODEL_FALLBACK));
        state.set("model", model.clone());
        state.set("nextBlockIndex", json!(0));

        results.push(json!({
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": ROLE_ASSISTANT,
                "model": model,
                "content": [],
                "stop_reason": Value::Null,
                "stop_sequence": Value::Null,
                "usage": { "input_tokens": 0, "output_tokens": 0 }
            }
        }));
    }

    // Handle reasoning (thinking)
    let reasoning_content = extract_reasoning_text(delta);
    if !reasoning_content.is_empty() {
        stop_text_block(state, &mut results);

        let thinking_started = state.get("thinkingBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
        if !thinking_started {
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
            "delta": { "type": "thinking_delta", "thinking": reasoning_content }
        }));
    }

    // Handle regular content
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            stop_thinking_block(state, &mut results);

            let text_started = state.get("textBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
            if !text_started {
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
        for tc in tool_calls {
            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");

            // Open tool block once per idx
            if !tc_id.is_empty() && !state_has_tool_call(state, idx) {
                stop_thinking_block(state, &mut results);
                stop_text_block(state, &mut results);

                let next_block = state.get("nextBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                state.set("nextBlockIndex", json!(next_block + 1));

                // Strip prefix from tool name
                let mut tool_name = tc
                    .get("function")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if tool_name.starts_with(CLAUDE_OAUTH_TOOL_PREFIX_RESPONSE) {
                    tool_name = tool_name[CLAUDE_OAUTH_TOOL_PREFIX_RESPONSE.len()..].to_string();
                }

                state_set_tool_call(state, idx, &json!({
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
                    if !state.has("toolArgBuffers") {
                        state.set("toolArgBuffers", json!({}));
                    }
                    if let Some(buffers) = state.get_mut("toolArgBuffers").and_then(|v| v.as_object_mut()) {
                        let key = idx.to_string();
                        let current = buffers.get(&key).and_then(|v| v.as_str()).unwrap_or("");
                        buffers.insert(key, json!(format!("{}{}", current, args)));
                    }
                }
            }
        }
    }

    // Finish
    if let Some(finish_reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
        if !finish_reason.is_empty() && finish_reason != "null" {
            stop_thinking_block(state, &mut results);
            stop_text_block(state, &mut results);

            // Emit buffered tool args
            if let Some(tool_calls) = state.get("toolCalls").and_then(|v| v.as_object()) {
                if let Some(buffers) = state.get("toolArgBuffers").and_then(|v| v.as_object()) {
                    for (idx_str, tool_info) in tool_calls {
                        let block_index = tool_info.get("blockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
                        let tool_name = tool_info.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(buffered) = buffers.get(idx_str).and_then(|v| v.as_str()) {
                            results.push(json!({
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": { "type": "input_json_delta", "partial_json": buffered }
                            }));
                        }
                        results.push(json!({
                            "type": "content_block_stop",
                            "index": block_index
                        }));
                    }
                }
            }

            state.set("finishReason", json!(finish_reason));

            let final_usage = state.get("usage").cloned().unwrap_or(json!({ "input_tokens": 0, "output_tokens": 0 }));
            let stop_reason = from_openai_finish(finish_reason, "claude");
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

fn stop_thinking_block(state: &mut ResponseState, results: &mut Vec<Value>) {
    let thinking_started = state.get("thinkingBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
    if thinking_started {
        let idx = state.get("thinkingBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
        results.push(json!({
            "type": "content_block_stop",
            "index": idx
        }));
        state.set("thinkingBlockStarted", json!(false));
    }
}

fn stop_text_block(state: &mut ResponseState, results: &mut Vec<Value>) {
    let text_started = state.get("textBlockStarted").and_then(|v| v.as_bool()).unwrap_or(false);
    let text_closed = state.get("textBlockClosed").and_then(|v| v.as_bool()).unwrap_or(false);
    if text_started && !text_closed {
        state.set("textBlockClosed", json!(true));
        let idx = state.get("textBlockIndex").and_then(|v| v.as_u64()).unwrap_or(0);
        results.push(json!({
            "type": "content_block_stop",
            "index": idx
        }));
        state.set("textBlockStarted", json!(false));
    }
}

fn state_has_tool_call(state: &ResponseState, idx: u64) -> bool {
    state.get("toolCalls").and_then(|v| v.get(&idx.to_string())).is_some()
}

fn state_set_tool_call(state: &mut ResponseState, idx: u64, val: &Value) {
    if !state.has("toolCalls") {
        state.set("toolCalls", json!({}));
    }
    if let Some(tc_map) = state.get_mut("toolCalls").and_then(|v| v.as_object_mut()) {
        tc_map.insert(idx.to_string(), val.clone());
    }
}
