//! OpenAI <-> Antigravity request adapter.
//!
//! Ported from:
//! - open-sse/translator/request/antigravity-to-openai.js
//!
//! Antigravity body shape:
//!   { project, model, userAgent, requestType, requestId,
//!     request: { contents, systemInstruction, tools, toolConfig, generationConfig, sessionId } }

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;

/// Convert an Antigravity request to OpenAI Chat Completions format.
/// Ported from antigravity-to-openai.js `antigravityToOpenAIRequest`.
pub fn antigravity_to_openai_request(model: &str, body: &Value, stream: bool) -> Value {
    let req = body.get("request").unwrap_or(body);
    let mut result = json!({
        "model": model,
        "messages": [],
        "stream": stream
    });

    // Generation config
    if let Some(config) = req.get("generationConfig") {
        if let Some(max) = config.get("maxOutputTokens").and_then(|v| v.as_u64()) {
            let temp_body = json!({ "max_tokens": max, "tools": req.get("tools").cloned().unwrap_or(Value::Null) });
            result["max_tokens"] = json!(adjust_max_tokens(&temp_body, DEFAULT_MAX_TOKENS));
        }
        if let Some(temp) = config.get("temperature") {
            result["temperature"] = temp.clone();
        }
        if let Some(top_p) = config.get("topP") {
            result["top_p"] = top_p.clone();
        }
        if let Some(top_k) = config.get("topK") {
            result["top_k"] = top_k.clone();
        }

        // Thinking config -> reasoning_effort
        if let Some(tc) = config.get("thinkingConfig") {
            let budget = tc.get("thinkingBudget").and_then(|v| v.as_u64()).unwrap_or(0);
            if let Some(effort) = budget_to_effort(budget) {
                result["reasoning_effort"] = json!(effort);
            }
        }
    }

    // System instruction
    if let Some(sys_inst) = req.get("systemInstruction") {
        let system_text = extract_gemini_text(sys_inst);
        if !system_text.is_empty() {
            if let Some(messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
                messages.push(json!({ "role": ROLE_SYSTEM, "content": system_text }));
            }
        }
    }

    // Convert contents to messages
    if let Some(contents) = req.get("contents").and_then(|v| v.as_array()) {
        if let Some(messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for content in contents {
                let converted = convert_antigravity_content(content);
                match converted {
                    ConvertedAntigravityContent::None => {}
                    ConvertedAntigravityContent::Single(m) => messages.push(m),
                    ConvertedAntigravityContent::Multiple(ms) => {
                        for m in ms {
                            messages.push(m);
                        }
                    }
                }
            }
        }
    }

    // Tools
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        let mut openai_tools = Vec::new();
        for tool in tools {
            if let Some(decls) = tool.get("functionDeclarations").and_then(|v| v.as_array()) {
                for func in decls {
                    let params = func.get("parameters").cloned().unwrap_or(json!({"type": "object", "properties": {}}));
                    let normalized = normalize_schema_types(&params);
                    openai_tools.push(json!({
                        "type": OPENAI_BLOCK_FUNCTION,
                        "function": {
                            "name": func.get("name").cloned().unwrap_or(Value::Null),
                            "description": func.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                            "parameters": normalized
                        }
                    }));
                }
            }
        }
        if !openai_tools.is_empty() {
            result["tools"] = Value::Array(openai_tools);
        }
    }

    result
}

enum ConvertedAntigravityContent {
    None,
    Single(Value),
    Multiple(Vec<Value>),
}

/// Convert Antigravity content (Gemini-shaped) to OpenAI message(s).
/// Handles: text, thought, thoughtSignature, functionCall, functionResponse, inlineData.
fn convert_antigravity_content(content: &Value) -> ConvertedAntigravityContent {
    let role = match content.get("role").and_then(|v| v.as_str()) {
        Some(r) if r == GEMINI_ROLE_MODEL => ROLE_ASSISTANT,
        Some(r) if r == GEMINI_ROLE_USER => ROLE_USER,
        Some(r) => r,
        None => return ConvertedAntigravityContent::None,
    };

    let parts = match content.get("parts").and_then(|v| v.as_array()) {
        Some(p) if !p.is_empty() => p,
        _ => return ConvertedAntigravityContent::None,
    };

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();
    let mut tool_results = Vec::new();
    let mut reasoning_content = String::new();

    for part in parts {
        // Thinking content (thought: true)
        if part.get("thought").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                reasoning_content.push_str(text);
            }
            continue;
        }

        // Text with thoughtSignature = regular text after thinking
        if part.get("thoughtSignature").is_some() {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    text_parts.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
                }
            }
            continue;
        }

        // Regular text
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                text_parts.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
            }
        }

        // Inline data (images)
        if let Some(inline_data) = part.get("inlineData") {
            if let (Some(mime), Some(data)) = (
                inline_data.get("mimeType").and_then(|v| v.as_str()),
                inline_data.get("data").and_then(|v| v.as_str()),
            ) {
                let url = encode_data_uri(mime, data);
                text_parts.push(json!({
                    "type": OPENAI_BLOCK_IMAGE_URL,
                    "image_url": { "url": url }
                }));
            }
        }

        // Function call
        if let Some(fc) = part.get("functionCall") {
            let fc_id = fc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| format!("call_{}", fc.get("name").and_then(|v| v.as_str()).unwrap_or("")));
            let fc_name = fc.get("name").cloned().unwrap_or(Value::Null);
            let args = fc.get("args").cloned().unwrap_or(json!({}));
            let args_str = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
            tool_calls.push(json!({
                "id": fc_id,
                "type": OPENAI_BLOCK_FUNCTION,
                "function": { "name": fc_name, "arguments": args_str }
            }));
        }

        // Function response -> tool result message
        if let Some(fr) = part.get("functionResponse") {
            let fr_id = fr.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| format!("call_{}", fr.get("name").and_then(|v| v.as_str()).unwrap_or("")));
            let result_val = fr.get("response")
                .and_then(|v| v.get("result"))
                .cloned()
                .or_else(|| fr.get("response").cloned())
                .unwrap_or(json!({}));
            let content_str = serde_json::to_string(&result_val).unwrap_or_default();
            tool_results.push(json!({
                "role": ROLE_TOOL,
                "tool_call_id": fr_id,
                "content": content_str
            }));
        }
    }

    // Content with functionResponses — return array of tool result messages,
    // plus an assistant message for any co-located tool calls / text.
    if !tool_results.is_empty() {
        if !tool_calls.is_empty() || !text_parts.is_empty() || !reasoning_content.is_empty() {
            let mut assistant_msg = serde_json::Map::new();
            assistant_msg.insert("role".to_string(), json!(ROLE_ASSISTANT));
            if !text_parts.is_empty() {
                assistant_msg.insert("content".to_string(), collapse_text_parts(&text_parts));
            }
            if !reasoning_content.is_empty() {
                assistant_msg.insert("reasoning_content".to_string(), json!(reasoning_content));
            }
            if !tool_calls.is_empty() {
                assistant_msg.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let mut all = tool_results;
            all.push(Value::Object(assistant_msg));
            return ConvertedAntigravityContent::Multiple(all);
        }
        return ConvertedAntigravityContent::Multiple(tool_results);
    }

    // Assistant with tool calls
    if !tool_calls.is_empty() {
        let mut msg = serde_json::Map::new();
        msg.insert("role".to_string(), json!(ROLE_ASSISTANT));
        if !text_parts.is_empty() {
            msg.insert("content".to_string(), collapse_text_parts(&text_parts));
        }
        if !reasoning_content.is_empty() {
            msg.insert("reasoning_content".to_string(), json!(reasoning_content));
        }
        msg.insert("tool_calls".to_string(), Value::Array(tool_calls));
        return ConvertedAntigravityContent::Single(Value::Object(msg));
    }

    // Regular message
    if !text_parts.is_empty() || !reasoning_content.is_empty() {
        let mut msg = serde_json::Map::new();
        msg.insert("role".to_string(), json!(role));
        if !text_parts.is_empty() {
            msg.insert("content".to_string(), collapse_text_parts(&text_parts));
        }
        if !reasoning_content.is_empty() {
            msg.insert("reasoning_content".to_string(), json!(reasoning_content));
        }
        return ConvertedAntigravityContent::Single(Value::Object(msg));
    }

    ConvertedAntigravityContent::None
}
