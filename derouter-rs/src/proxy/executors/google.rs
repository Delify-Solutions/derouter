//! Google/Gemini executor — Phase 1.
//! Port of open-sse/providers/registry/gemini.js.
//! Auth: x-goog-api-key header from connection.data.apiKey
//! Stream endpoint: {base}/v1beta/models/{model}:streamGenerateContent?alt=sse
//! Non-stream endpoint: {base}/v1beta/models/{model}:generateContent

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth, get_base_url};
use crate::db::repos::connections::ProviderConnection;

pub struct GoogleExecutor;

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

#[async_trait::async_trait]
impl ProviderExecutor for GoogleExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Google connection missing API key"))?;

        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);

        // Extract model from body — Gemini uses model in the URL path
        let model = body.get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gemini-1.5-flash")
            .to_string();

        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
            base_url.trim_end_matches('/'),
            model
        );

        // Convert OpenAI-style body to Gemini format
        let gemini_body = convert_to_gemini_format(&body, true);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("x-goog-api-key", &api_key)
            .header("Content-Type", "application/json")
            .json(&gemini_body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let stream = resp.bytes_stream().map(|r| {
            r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });

        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: Box::new(stream),
        })
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Google connection missing API key"))?;

        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);

        let model = body.get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gemini-1.5-flash")
            .to_string();

        let url = format!(
            "{}/v1beta/models/{}:generateContent",
            base_url.trim_end_matches('/'),
            model
        );

        let gemini_body = convert_to_gemini_format(&body, false);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("x-goog-api-key", &api_key)
            .header("Content-Type", "application/json")
            .json(&gemini_body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let bytes = resp.bytes().await?;
        Ok(UpstreamResponse::Json {
            status: StatusCode::OK,
            headers: HeaderMap::new(),
            body: bytes,
        })
    }
}

/// Convert OpenAI chat completions format to Gemini format
fn convert_to_gemini_format(body: &serde_json::Value, _stream: bool) -> serde_json::Value {
    let messages = body.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut contents = Vec::new();

    for msg in &messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let gemini_role = match role {
            "assistant" => "model",
            _ => "user",
        };

        let content = if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
            vec![serde_json::json!({"text": s})]
        } else if let Some(parts) = msg.get("content").and_then(|v| v.as_array()) {
            parts.iter().map(|p| {
                if let Some(text) = p.get("text").and_then(|v| v.as_str()) {
                    serde_json::json!({"text": text})
                } else if let Some(image) = p.get("image_url") {
                    serde_json::json!({"inlineData": image})
                } else {
                    p.clone()
                }
            }).collect()
        } else {
            vec![]
        };

        contents.push(serde_json::json!({
            "role": gemini_role,
            "parts": content,
        }));
    }

    let mut result = serde_json::json!({
        "contents": contents,
    });

    // Copy generation config params
    let mut gen_config = serde_json::Map::new();
    for key in &["temperature", "topP", "topK", "maxOutputTokens", "stopSequences"] {
        if let Some(val) = body.get(*key) {
            gen_config.insert(key.to_string(), val.clone());
        }
    }
    // Map max_tokens -> maxOutputTokens
    if let Some(max_tokens) = body.get("max_tokens") {
        gen_config.insert("maxOutputTokens".to_string(), max_tokens.clone());
    }
    if !gen_config.is_empty() {
        result["generationConfig"] = serde_json::Value::Object(gen_config);
    }

    // System instruction
    if let Some(system) = body.get("system").and_then(|v| v.as_str()) {
        result["systemInstruction"] = serde_json::json!({"parts": [{"text": system}]});
    }

    result
}
