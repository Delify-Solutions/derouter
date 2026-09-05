//! OpenAI <-> Gemini / Vertex / Antigravity / Gemini-CLI translator adapters.
//!
//! Ported from:
//! - open-sse/translator/request/openai-to-gemini.js   (openaiToGeminiRequest, openaiToGeminiCLIRequest, openaiToAntigravityRequest)
//! - open-sse/translator/request/openai-to-vertex.js    (openaiToVertexRequest)
//! - open-sse/translator/request/gemini-to-openai.js    (geminiToOpenAIRequest)
//! - open-sse/translator/response/gemini-to-openai.js   (geminiToOpenAIResponse)
//! - open-sse/translator/response/openai-to-antigravity.js (openaiToAntigravityResponse)
//!
//! The Node adapters wrap some outputs in Cloud Code envelopes (projectId, requestId, sessionId).
//! Those wrapper layers are executor concerns; the translator adapters produce the inner
//! Gemini/Antigravity body. The Rust executors will handle envelope wrapping.

use serde_json::{json, Value};
use crate::proxy::translator::schema::*;
use crate::proxy::translator::ResponseState;

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: OpenAI -> Gemini (base for all variants)
// ═══════════════════════════════════════════════════════════════════════════════

/// Core: Convert OpenAI request to Gemini format (base for all variants).
/// Ported from openai-to-gemini.js `openaiToGeminiBase`.
fn openai_to_gemini_base(model: &str, body: &Value, stream: bool, signature: &str) -> Value {
    let mut result = json!({
        "model": model,
        "contents": [],
        "generationConfig": {},
        "safetySettings": default_safety_settings()
    });

    // Generation config
    if let Some(temp) = body.get("temperature") {
        result["generationConfig"]["temperature"] = temp.clone();
    }
    if let Some(top_p) = body.get("top_p") {
        result["generationConfig"]["topP"] = top_p.clone();
    }
    if let Some(top_k) = body.get("top_k") {
        result["generationConfig"]["topK"] = top_k.clone();
    }
    if let Some(max_tokens) = body.get("max_tokens") {
        result["generationConfig"]["maxOutputTokens"] = max_tokens.clone();
    }

    // Build tool_call_id -> name map
    let mut tc_id2name = serde_json::Map::new();
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_ASSISTANT) {
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tool_calls {
                        if tc.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_FUNCTION) {
                            if let (Some(id), Some(name)) = (
                                tc.get("id").and_then(|v| v.as_str()),
                                tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()),
                            ) {
                                tc_id2name.insert(id.to_string(), json!(name));
                            }
                        }
                    }
                }
            }
        }
    }

    // Build tool responses cache
    let mut tool_responses = serde_json::Map::new();
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_TOOL) {
                if let Some(tool_call_id) = msg.get("tool_call_id").and_then(|v| v.as_str()) {
                    tool_responses.insert(tool_call_id.to_string(), msg.get("content").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    // Extract system message and set systemInstruction BEFORE borrowing contents
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        let msg_len = messages.len();
        if msg_len > 1 {
            for msg in messages {
                if msg.get("role").and_then(|v| v.as_str()) == Some(ROLE_SYSTEM) {
                    let content = msg.get("content").unwrap_or(&Value::Null);
                    let system_text = if let Some(s) = content.as_str() {
                        s.to_string()
                    } else {
                        extract_gemini_text(content)
                    };
                    result["systemInstruction"] = json!({
                        "role": GEMINI_ROLE_USER,
                        "parts": [{ "text": system_text }]
                    });
                    break;
                }
            }
        }
    }

    // Convert messages
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        let msg_len = messages.len();
        let mut contents = result.get_mut("contents").and_then(|v| v.as_array_mut()).unwrap();

        for msg in messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let content = msg.get("content").unwrap_or(&Value::Null);

            if role == ROLE_SYSTEM && msg_len > 1 {
                // Already handled above — skip
            } else if role == ROLE_USER || (role == ROLE_SYSTEM && msg_len == 1) {
                let parts = convert_openai_content_to_parts(content);
                if !parts.is_empty() {
                    contents.push(json!({ "role": GEMINI_ROLE_USER, "parts": parts }));
                }
            } else if role == ROLE_ASSISTANT {
                let mut parts = Vec::new();

                // Thinking/reasoning -> thought part with signature
                if let Some(reasoning) = msg.get("reasoning_content").and_then(|v| v.as_str()) {
                    if !reasoning.is_empty() {
                        parts.push(json!({ "thought": true, "text": reasoning }));
                        parts.push(json!({ "thoughtSignature": signature, "text": "" }));
                    }
                }

                if !content.is_null() {
                    let text = if let Some(s) = content.as_str() {
                        s.to_string()
                    } else {
                        extract_gemini_text(content)
                    };
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                }

                if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                    let mut tool_call_ids = Vec::new();
                    let mut has_tool_calls = false;

                    for tc in tool_calls {
                        if tc.get("type").and_then(|v| v.as_str()) != Some(OPENAI_BLOCK_FUNCTION) {
                            continue;
                        }
                        has_tool_calls = true;

                        let args_str = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}");
                        let args = try_parse_json(args_str);
                        let fc_name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                        let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");

                        parts.push(json!({
                            "thoughtSignature": signature,
                            "functionCall": {
                                "id": tc_id,
                                "name": sanitize_gemini_function_name(fc_name),
                                "args": args
                            }
                        }));
                        tool_call_ids.push(tc_id.to_string());
                    }

                    if !parts.is_empty() {
                        contents.push(json!({ "role": GEMINI_ROLE_MODEL, "parts": parts.clone() }));
                    }

                    // Check if there are actual tool responses in the next messages
                    let has_actual_responses = tool_call_ids.iter().any(|fid| tool_responses.contains_key(fid));

                    if has_actual_responses {
                        let mut tool_parts = Vec::new();
                        for fid in &tool_call_ids {
                            let resp = match tool_responses.get(fid) {
                                Some(r) => r.clone(),
                                None => continue,
                            };

                            let name = tc_id2name.get(fid).and_then(|v| v.as_str()).map(|s| s.to_string())
                                .unwrap_or_else(|| {
                                    // Try to derive name from id: split on "-" and take all but last 2 parts
                                    let id_parts: Vec<&str> = fid.split('-').collect();
                                    if id_parts.len() > 2 {
                                        id_parts[..id_parts.len() - 2].join("-")
                                    } else {
                                        fid.clone()
                                    }
                                });

                            let mut parsed = try_parse_json(&resp.to_string());
                            if parsed.is_null() {
                                parsed = json!({ "result": resp });
                            } else if !parsed.is_object() && !parsed.is_array() {
                                parsed = json!({ "result": parsed });
                            }

                            tool_parts.push(json!({
                                "functionResponse": {
                                    "id": fid,
                                    "name": sanitize_gemini_function_name(&name),
                                    "response": { "result": parsed }
                                }
                            }));
                        }
                        if !tool_parts.is_empty() {
                            contents.push(json!({ "role": GEMINI_ROLE_USER, "parts": tool_parts }));
                        }
                    }
                } else if !parts.is_empty() {
                    contents.push(json!({ "role": GEMINI_ROLE_MODEL, "parts": parts }));
                }
            }
        }
    }

    // Convert tools
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        if !tools.is_empty() {
            let mut function_declarations = Vec::new();
            for t in tools {
                // Claude format (name + input_schema)
                if t.get("name").is_some() && t.get("input_schema").is_some() {
                    let raw_schema = t.get("input_schema").cloned().unwrap_or(json!({"type": "object", "properties": {}}));
                    let cleaned = clean_json_schema_for_antigravity(&raw_schema);
                    function_declarations.push(json!({
                        "name": sanitize_gemini_function_name(t.get("name").and_then(|v| v.as_str()).unwrap_or("")),
                        "description": t.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                        "parameters": cleaned
                    }));
                }
                // OpenAI format (type: function, function: { ... })
                else if t.get("type").and_then(|v| v.as_str()) == Some(OPENAI_BLOCK_FUNCTION) {
                    if let Some(fn_obj) = t.get("function") {
                        let raw_schema = fn_obj.get("parameters").cloned().unwrap_or(json!({"type": "object", "properties": {}}));
                        let cleaned = clean_json_schema_for_antigravity(&raw_schema);
                        function_declarations.push(json!({
                            "name": sanitize_gemini_function_name(fn_obj.get("name").and_then(|v| v.as_str()).unwrap_or("")),
                            "description": fn_obj.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                            "parameters": cleaned
                        }));
                    }
                }
            }
            if !function_declarations.is_empty() {
                result["tools"] = json!([{ "functionDeclarations": function_declarations }]);
            }
        }
    }

    // Normalize Gemini contents (merge consecutive same-role turns)
    if let Some(contents) = result.get("contents").and_then(|v| v.as_array()) {
        let normalized = normalize_gemini_contents(contents);
        result["contents"] = Value::Array(normalized);
    }

    result
}

/// Convert OpenAI Chat Completions request to Gemini API format.
/// Ported from openai-to-gemini.js `openaiToGeminiRequest`.
pub fn openai_to_gemini_request(model: &str, body: &Value, stream: bool) -> Value {
    openai_to_gemini_base(model, body, stream, DEFAULT_THINKING_AG_SIGNATURE)
}

/// Convert OpenAI Chat Completions request to Gemini CLI (Cloud Code Assist) format.
/// Ported from openai-to-gemini.js `openaiToGeminiCLIRequest`.
pub fn openai_to_gemini_cli_request(model: &str, body: &Value, stream: bool) -> Value {
    let gemini = openai_to_gemini_base(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE);

    // Clean schema for tools
    let mut result = gemini;
    if let Some(tools) = result.get_mut("tools").and_then(|v| v.as_array_mut()) {
        if let Some(first) = tools.first_mut() {
            if let Some(decls) = first.get_mut("functionDeclarations").and_then(|v| v.as_array_mut()) {
                for fn_decl in decls {
                    if let Some(params) = fn_decl.get("parameters").cloned() {
                        let cleaned = clean_json_schema_for_antigravity(&params);
                        fn_decl["parameters"] = cleaned;
                    }
                }
            }
        }
    }

    result
}

/// Convert OpenAI Chat Completions request to Vertex AI format.
/// Ported from openai-to-vertex.js `openaiToVertexRequest`.
/// Post-processes a Gemini-format body for Vertex AI: strip `id` from functionCall/functionResponse,
/// replace synthetic thoughtSignatures with Vertex-native signature.
pub fn openai_to_vertex_request(model: &str, body: &Value, stream: bool) -> Value {
    let mut result = openai_to_gemini_base(model, body, stream, DEFAULT_THINKING_VERTEX_SIGNATURE);

    if let Some(contents) = result.get_mut("contents").and_then(|v| v.as_array_mut()) {
        for turn in contents {
            if let Some(parts) = turn.get_mut("parts").and_then(|v| v.as_array_mut()) {
                for part in parts {
                    // Replace synthetic signature with Vertex-native one
                    if part.get("thoughtSignature").is_some() {
                        part["thoughtSignature"] = json!(DEFAULT_THINKING_VERTEX_SIGNATURE);
                    }
                    // Strip id from functionCall
                    if let Some(fc) = part.get_mut("functionCall").and_then(|v| v.as_object_mut()) {
                        fc.remove("id");
                    }
                    // Strip id from functionResponse
                    if let Some(fr) = part.get_mut("functionResponse").and_then(|v| v.as_object_mut()) {
                        fr.remove("id");
                    }
                }
            }
        }
    }

    result
}

/// Convert OpenAI Chat Completions request to Antigravity format.
/// Ported from openai-to-gemini.js `openaiToAntigravityRequest`.
/// For Claude models, this would route through Claude->Gemini conversion; here we produce
/// the Gemini-CLI inner body. The executor handles the Cloud Code envelope wrapping.
pub fn openai_to_antigravity_request(model: &str, body: &Value, stream: bool) -> Value {
    // Check if model is a Claude model
    if model.to_lowercase().contains("claude") {
        // For Claude models in Antigravity, the Node code converts to Claude format first
        // then wraps in a Cloud Code envelope. That requires full Claude conversion.
        // For the Rust port, we delegate to the Gemini-CLI path and let the executor handle
        // the Claude-specific envelope. This matches the Gemini-CLI body shape.
        openai_to_gemini_cli_request(model, body, stream)
    } else {
        openai_to_gemini_cli_request(model, body, stream)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST: Gemini -> OpenAI
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert Gemini request to OpenAI Chat Completions format.
/// Ported from gemini-to-openai.js `geminiToOpenAIRequest`.
pub fn gemini_to_openai_request(model: &str, body: &Value, stream: bool) -> Value {
    let mut result = json!({
        "model": model,
        "messages": [],
        "stream": stream
    });

    // Generation config
    if let Some(config) = body.get("generationConfig") {
        if let Some(max) = config.get("maxOutputTokens").and_then(|v| v.as_u64()) {
            let temp_body = json!({ "max_tokens": max, "tools": body.get("tools").cloned().unwrap_or(Value::Null) });
            result["max_tokens"] = json!(adjust_max_tokens(&temp_body, DEFAULT_MAX_TOKENS));
        }
        if let Some(temp) = config.get("temperature") {
            result["temperature"] = temp.clone();
        }
        if let Some(top_p) = config.get("topP") {
            result["top_p"] = top_p.clone();
        }
    }

    // System instruction
    if let Some(sys_inst) = body.get("systemInstruction") {
        let system_text = extract_gemini_text(sys_inst);
        if !system_text.is_empty() {
            if let Some(messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
                messages.push(json!({ "role": ROLE_SYSTEM, "content": system_text }));
            }
        }
    }

    // Convert contents to messages
    if let Some(contents) = body.get("contents").and_then(|v| v.as_array()) {
        if let Some(messages) = result.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for content in contents {
                if let Some(converted) = convert_gemini_content(content) {
                    messages.push(converted);
                }
            }
        }
    }

    // Tools
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let mut openai_tools = Vec::new();
        for tool in tools {
            if let Some(decls) = tool.get("functionDeclarations").and_then(|v| v.as_array()) {
                for func in decls {
                    openai_tools.push(json!({
                        "type": OPENAI_BLOCK_FUNCTION,
                        "function": {
                            "name": func.get("name").cloned().unwrap_or(Value::Null),
                            "description": func.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                            "parameters": func.get("parameters").cloned().unwrap_or(json!({"type": "object", "properties": {}}))
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

/// Convert Gemini content to OpenAI message.
/// Ported from gemini-to-openai.js `convertGeminiContent`.
fn convert_gemini_content(content: &Value) -> Option<Value> {
    let role = if content.get("role").and_then(|v| v.as_str()) == Some(GEMINI_ROLE_USER) {
        ROLE_USER
    } else {
        ROLE_ASSISTANT
    };

    let parts = content.get("parts").and_then(|v| v.as_array())?;

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();

    for part in parts {
        // Text content
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            text_parts.push(json!({ "type": OPENAI_BLOCK_TEXT, "text": text }));
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

        // Function response -> tool message (return immediately as separate message)
        if let Some(fr) = part.get("functionResponse") {
            let fr_id = fr.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| format!("call_{}", fr.get("name").and_then(|v| v.as_str()).unwrap_or("")));
            let result_val = fr.get("response")
                .and_then(|v| v.get("result"))
                .cloned()
                .or_else(|| fr.get("response").cloned())
                .unwrap_or(json!({}));
            let content_str = serde_json::to_string(&result_val).unwrap_or_default();
            return Some(json!({
                "role": ROLE_TOOL,
                "tool_call_id": fr_id,
                "content": content_str
            }));
        }
    }

    // Assistant with tool calls
    if !tool_calls.is_empty() {
        let mut msg = serde_json::Map::new();
        msg.insert("role".to_string(), json!(ROLE_ASSISTANT));
        if !text_parts.is_empty() {
            // If only one text part, extract the string directly
            if text_parts.len() == 1 {
                if let Some(text) = text_parts[0].get("text").cloned() {
                    msg.insert("content".to_string(), text);
                }
            } else {
                msg.insert("content".to_string(), Value::Array(text_parts));
            }
        }
        msg.insert("tool_calls".to_string(), Value::Array(tool_calls));
        return Some(Value::Object(msg));
    }

    if !text_parts.is_empty() {
        let collapsed = collapse_text_parts(&text_parts);
        return Some(json!({ "role": role, "content": collapsed }));
    }

    None
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: Gemini -> OpenAI (streaming)
// ═══════════════════════════════════════════════════════════════════════════════

/// Build chunk meta for current gemini state.
fn gemini_chunk_meta(state: &ResponseState) -> (String, u64, String) {
    let id = format!("chatcmpl-{}", state.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
    let created = chrono::Utc::now().timestamp() as u64;
    let model = state.get("model").and_then(|v| v.as_str()).unwrap_or("gemini").to_string();
    (id, created, model)
}

/// Emit a function call chunk from a Gemini functionCall part.
fn emit_function_call(function_call: &Value, state: &mut ResponseState) -> Value {
    let raw_name = function_call.get("name").and_then(|v| v.as_str()).unwrap_or("");
    // Restore original tool name from mapping (AG cloaking) — state.toolNameMap would be used
    // by the executor; here we use the raw name as-is.
    let fc_name = raw_name.to_string();
    let fc_args = function_call.get("args").cloned().unwrap_or(json!({}));
    let tool_call_index = state.get("functionIndex").and_then(|v| v.as_u64()).unwrap_or(0);
    state.set("functionIndex", json!(tool_call_index + 1));
    let tc_id = format!("{}-{}-{}", fc_name, chrono::Utc::now().timestamp_millis(), tool_call_index);

    let tool_call = json!({
        "id": tc_id,
        "index": tool_call_index,
        "type": OPENAI_BLOCK_FUNCTION,
        "function": { "name": fc_name, "arguments": serde_json::to_string(&fc_args).unwrap_or_else(|_| "{}".to_string()) }
    });

    let gemini_count = state.get("geminiToolCallCount").and_then(|v| v.as_u64()).unwrap_or(0);
    state.set("geminiToolCallCount", json!(gemini_count + 1));

    let (id, created, model) = gemini_chunk_meta(state);
    build_chunk(&id, created, &model, json!({ "tool_calls": [tool_call] }), None)
}

/// Convert Gemini response chunk to OpenAI format.
/// Ported from gemini-to-openai.js `geminiToOpenAIResponse`.
pub fn gemini_to_openai_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    // Handle Antigravity wrapper
    let response = chunk.get("response").unwrap_or(chunk);
    let candidates = match response.get("candidates").and_then(|v| v.as_array()) {
        Some(c) if !c.is_empty() => c,
        _ => return vec![],
    };

    let mut results = Vec::new();
    let candidate = &candidates[0];
    let content = candidate.get("content").unwrap_or(&Value::Null);

    // Initialize state
    if !state.has("messageId") {
        let msg_id = response.get("responseId").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| format!("msg_{}", chrono::Utc::now().timestamp_millis()));
        state.set("messageId", json!(msg_id));
        let model = response.get("modelVersion").and_then(|v| v.as_str()).unwrap_or("gemini").to_string();
        state.set("model", json!(model));
        state.set("functionIndex", json!(0));
        state.set("geminiToolCallCount", json!(0));

        let (id, created, model_str) = gemini_chunk_meta(state);
        results.push(build_chunk(&id, created, &model_str, json!({ "role": ROLE_ASSISTANT }), None));
    }

    // Process parts
    if let Some(parts) = content.get("parts").and_then(|v| v.as_array()) {
        for part in parts {
            let has_thought_sig = part.get("thoughtSignature").is_some() || part.get("thought_signature").is_some();
            let is_thought = part.get("thought").and_then(|v| v.as_bool()).unwrap_or(false);

            // Handle thought signature (thinking mode)
            if has_thought_sig {
                let has_text = part.get("text").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
                let has_function_call = part.get("functionCall").is_some();

                if has_text {
                    let (id, created, model_str) = gemini_chunk_meta(state);
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let delta = if is_thought {
                        reasoning_delta(text, false)
                    } else {
                        json!({ "content": text })
                    };
                    results.push(build_chunk(&id, created, &model_str, delta, None));
                }

                if has_function_call {
                    if let Some(fc) = part.get("functionCall") {
                        results.push(emit_function_call(fc, state));
                    }
                }
                continue;
            }

            // Text content (includes thought:true without signature)
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    let (id, created, model_str) = gemini_chunk_meta(state);
                    let delta = if is_thought {
                        reasoning_delta(text, false)
                    } else {
                        json!({ "content": text })
                    };
                    results.push(build_chunk(&id, created, &model_str, delta, None));
                }
            }

            // Function call
            if let Some(fc) = part.get("functionCall") {
                results.push(emit_function_call(fc, state));
            }

            // Inline data (images)
            let inline_data = part.get("inlineData").or_else(|| part.get("inline_data"));
            if let Some(inline) = inline_data {
                if let Some(data) = inline.get("data").and_then(|v| v.as_str()) {
                    if !data.is_empty() {
                        let mime = inline.get("mimeType").or_else(|| inline.get("mime_type"))
                            .and_then(|v| v.as_str()).unwrap_or(DEFAULT_IMAGE_MIME);
                        let (id, created, model_str) = gemini_chunk_meta(state);
                        results.push(build_chunk(
                            &id, created, &model_str,
                            json!({
                                "images": [{
                                    "type": OPENAI_BLOCK_IMAGE_URL,
                                    "image_url": { "url": encode_data_uri(mime, data) }
                                }]
                            }),
                            None,
                        ));
                    }
                }
            }
        }
    }

    // Usage metadata
    let usage_meta = response.get("usageMetadata").or_else(|| chunk.get("usageMetadata"));
    if let Some(usage) = usage_meta {
        if let Some(openai_usage) = to_openai_usage(usage, "gemini") {
            state.set("usage", openai_usage);
        }
    }

    // Finish reason
    if let Some(finish_reason) = candidate.get("finishReason").and_then(|v| v.as_str()) {
        let mut openai_finish = to_openai_finish(finish_reason, "gemini");
        let gemini_tool_count = state.get("geminiToolCallCount").and_then(|v| v.as_u64()).unwrap_or(0);
        if openai_finish == OPENAI_FINISH_STOP && gemini_tool_count > 0 {
            openai_finish = OPENAI_FINISH_TOOL_CALLS.to_string();
        }

        let (id, created, model_str) = gemini_chunk_meta(state);
        let mut final_chunk = build_chunk(&id, created, &model_str, json!({}), Some(&openai_finish));

        // Include usage in final chunk
        if let Some(usage) = state.get("usage").cloned() {
            final_chunk["usage"] = usage;
        }

        results.push(final_chunk);
        state.set("finishReason", json!(openai_finish));
    }

    results
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE: OpenAI -> Antigravity (streaming)
// ═══════════════════════════════════════════════════════════════════════════════

/// Convert OpenAI SSE chunk to Antigravity SSE format.
/// Ported from openai-to-antigravity.js `openaiToAntigravityResponse`.
pub fn openai_to_antigravity_response(chunk: &Value, state: &mut ResponseState) -> Vec<Value> {
    if chunk.is_null() {
        return vec![];
    }

    let choices = match chunk.get("choices").and_then(|v| v.as_array()) {
        Some(c) if !c.is_empty() => c,
        _ => {
            // Handle usage-only chunks
            if let Some(usage) = chunk.get("usage") {
                state.set("_usage", usage.clone());
            }
            return vec![];
        }
    };

    let choice = &choices[0];
    let delta = choice.get("delta").unwrap_or(&Value::Null);
    let finish_reason = choice.get("finish_reason").and_then(|v| v.as_str());

    // Init state
    if !state.has("_toolCallAccum") {
        state.set("_toolCallAccum", json!({}));
    }
    if !state.has("_responseId") {
        let rid = chunk.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| format!("resp_{}", chrono::Utc::now().timestamp_millis()));
        state.set("_responseId", json!(rid));
    }
    if !state.has("_modelVersion") {
        let mv = chunk.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
        state.set("_modelVersion", json!(mv));
    }

    let mut parts = Vec::new();

    // Thinking/reasoning -> thought part
    if let Some(reasoning) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
        if !reasoning.is_empty() {
            parts.push(json!({ "thought": true, "text": reasoning }));
        }
    }

    // Text content
    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
        if !content.is_empty() {
            parts.push(json!({ "text": content }));
        }
    }

    // Accumulate tool calls silently (no emit until finish)
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tool_calls {
            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let key = idx.to_string();

            if !state.has("_toolCallAccum") {
                state.set("_toolCallAccum", json!({}));
            }

            // Ensure the accumulator entry exists
            if state.get("_toolCallAccum").and_then(|v| v.get(&key)).is_none() {
                if let Some(accum) = state.get_mut("_toolCallAccum").and_then(|v| v.as_object_mut()) {
                    accum.insert(key.clone(), json!({ "id": "", "name": "", "arguments": "" }));
                }
            }

            if let Some(accum) = state.get_mut("_toolCallAccum").and_then(|v| v.get_mut(&key)) {
                if let Some(obj) = accum.as_object_mut() {
                    if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                        if !id.is_empty() {
                            obj.insert("id".to_string(), json!(id));
                        }
                    }
                    if let Some(name) = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()) {
                        if !name.is_empty() {
                            let current = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            obj.insert("name".to_string(), json!(format!("{}{}", current, name)));
                        }
                    }
                    if let Some(args) = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()) {
                        if !args.is_empty() {
                            let current = obj.get("arguments").and_then(|v| v.as_str()).unwrap_or("");
                            obj.insert("arguments".to_string(), json!(format!("{}{}", current, args)));
                        }
                    }
                }
            }
        }

        // Skip emit — wait for finish_reason
        if parts.is_empty() && finish_reason.is_none() {
            return vec![];
        }
    }

    // On finish, emit accumulated tool calls as complete functionCall parts
    if finish_reason.is_some() {
        if let Some(accum) = state.get("_toolCallAccum").and_then(|v| v.as_object()) {
            for (_idx, val) in accum {
                let args_str = val.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                let args = serde_json::from_str::<Value>(args_str).unwrap_or(json!({}));
                let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("");
                parts.push(json!({
                    "functionCall": { "name": name, "args": args }
                }));
            }
        }
    }

    // Skip empty non-finish chunks
    if parts.is_empty() && finish_reason.is_none() {
        return vec![];
    }

    // Ensure at least empty text part on finish with no content
    if parts.is_empty() && finish_reason.is_some() {
        parts.push(json!({ "text": "" }));
    }

    // Build candidate
    let mut candidate = json!({
        "content": { "role": GEMINI_ROLE_MODEL, "parts": parts }
    });

    // Finish reason mapping
    if let Some(fr) = finish_reason {
        let mapped = match fr {
            OPENAI_FINISH_STOP => GEMINI_FINISH_STOP,
            OPENAI_FINISH_LENGTH => GEMINI_FINISH_MAX_TOKENS,
            OPENAI_FINISH_TOOL_CALLS => GEMINI_FINISH_STOP,
            OPENAI_FINISH_CONTENT_FILTER => GEMINI_FINISH_SAFETY,
            _ => GEMINI_FINISH_STOP,
        };
        candidate["finishReason"] = json!(mapped);
    }

    // Build response
    let mut response = json!({
        "candidates": [candidate],
        "modelVersion": state.get("_modelVersion").cloned().unwrap_or(Value::Null),
        "responseId": state.get("_responseId").cloned().unwrap_or(Value::Null)
    });

    // Usage metadata
    let usage = chunk.get("usage").cloned().or_else(|| state.get("_usage").cloned());
    if let Some(usage) = usage {
        let prompt = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let candidates_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let total = usage.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let mut meta = json!({
            "promptTokenCount": prompt,
            "candidatesTokenCount": candidates_tokens,
            "totalTokenCount": total
        });
        if let Some(reasoning) = usage.get("completion_tokens_details").and_then(|v| v.get("reasoning_tokens")).and_then(|v| v.as_u64()) {
            meta["thoughtsTokenCount"] = json!(reasoning);
        }
        if let Some(cached) = usage.get("prompt_tokens_details").and_then(|v| v.get("cached_tokens")).and_then(|v| v.as_u64()) {
            meta["cachedContentTokenCount"] = json!(cached);
        }
        response["usageMetadata"] = meta;
    }

    vec![json!({ "response": response })]
}
