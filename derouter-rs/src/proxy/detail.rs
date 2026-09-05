//! Proxy detail — buildRequestDetail. Phase 1.
//! Port of open-sse/handlers/chatCore/requestDetail.js.
//! D7 invariant: requestedModel = bare combo name (no `/`) from clientRawRequest.model.

use crate::db::repos::request_details::DetailItem;

/// Build a request detail item from the chat flow.
/// `requested_model` is the original client model string — if it has no `/`,
/// it's a combo name and we preserve it as-is (D7 invariant).
/// `resolved_model` is the actual provider/model that was used.
pub fn build_request_detail(
    provider: Option<String>,
    resolved_model: Option<String>,
    requested_model: Option<String>,
    connection_id: Option<String>,
    api_key: Option<String>,
    status: Option<String>,
    latency: serde_json::Value,
    tokens: serde_json::Value,
    request: serde_json::Value,
    provider_request: serde_json::Value,
    provider_response: serde_json::Value,
    response: serde_json::Value,
) -> DetailItem {
    DetailItem::build(
        provider,
        resolved_model,
        requested_model,
        connection_id,
        api_key,
        status,
        latency,
        tokens,
        request,
        provider_request,
        provider_response,
        response,
    )
}

/// Extract the requestedModel from the client's raw request body.
/// If the model string has no `/`, it's a combo name (or bare model) — preserve as-is.
/// If it has a `/`, it's a direct provider/model reference — requestedModel is the full string.
/// The key invariant (D7): requestedModel is always the client's raw model string.
pub fn extract_requested_model(body: &serde_json::Value) -> Option<String> {
    body.get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract usage/tokens from a response body, normalizing across providers.
/// Port of extractUsageFromResponse from requestDetail.js.
pub fn extract_usage_from_response(response: &serde_json::Value) -> serde_json::Value {
    // Try OpenAI format: usage.prompt_tokens, usage.completion_tokens
    if let Some(usage) = response.get("usage") {
        if usage.get("prompt_tokens").is_some() || usage.get("completion_tokens").is_some() {
            let prompt = usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let completion = usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let cached = usage.get("cached_tokens")
                .or_else(|| usage.get("prompt_tokens_details"))
                .and_then(|v| {
                    if let Some(s) = v.get("cached_tokens").and_then(|v| v.as_i64()) {
                        Some(s)
                    } else {
                        v.as_i64()
                    }
                })
                .unwrap_or(0);
            let reasoning = usage.get("reasoning_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let cache_creation = usage.get("cache_creation_input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            return serde_json::json!({
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached,
                "reasoning_tokens": reasoning,
                "cache_creation_input_tokens": cache_creation,
            });
        }

        // Try Claude format: usage.input_tokens, usage.output_tokens
        if usage.get("input_tokens").is_some() || usage.get("output_tokens").is_some() {
            let input = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let output = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            let cached = usage.get("cached_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let cache_read = usage.get("cache_read_input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let cache_creation = usage.get("cache_creation_input_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            return serde_json::json!({
                "prompt_tokens": input,
                "completion_tokens": output,
                "cached_tokens": cached,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_creation,
            });
        }
    }

    // Try Gemini format: usageMetadata
    if let Some(meta) = response.get("usageMetadata") {
        let prompt = meta.get("promptTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let completion = meta.get("candidatesTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let cached = meta.get("cachedContentTokenCount").and_then(|v| v.as_i64()).unwrap_or(0);
        return serde_json::json!({
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cached_tokens": cached,
        });
    }

    serde_json::json!({})
}

/// Parse SSE text to extract usage from the final DONE event or accumulated data.
/// Port of parseSSEToOpenAIResponse usage extraction.
pub fn extract_usage_from_sse(sse_text: &str) -> serde_json::Value {
    // Look for usage in the last data: line
    // Look for usage in the last data: lines (iterate in reverse)
    let lines: Vec<&str> = sse_text.lines().collect();
    for line in lines.into_iter().rev() {
        if let Some(data) = line.strip_prefix("data: ") {
            if data == "[DONE]" {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(usage) = parsed.get("usage") {
                    return extract_usage_from_response(&serde_json::json!({"usage": usage}));
                }
                // Anthropic message_delta with usage
                if let Some(usage) = parsed.get("message").and_then(|m| m.get("usage")) {
                    return extract_usage_from_response(&serde_json::json!({"usage": usage}));
                }
            }
        }
    }
    serde_json::json!({})
}
