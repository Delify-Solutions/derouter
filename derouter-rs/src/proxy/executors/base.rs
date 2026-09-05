//! Base executor trait — Phase 1.
//! trait ProviderExecutor: stream + complete methods.
//! Executor selection from connection.provider.

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::Stream;

use crate::db::repos::connections::ProviderConnection;

/// The result of an upstream provider call — either a streaming response
/// or a complete JSON response.
pub enum UpstreamResponse {
    /// SSE stream — used when the client requests streaming and the provider supports it
    Stream {
        headers: HeaderMap,
        stream: Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin>,
    },
    /// Complete JSON response — used for non-streaming requests
    Json {
        status: StatusCode,
        headers: HeaderMap,
        body: Bytes,
    },
    /// Error from the upstream provider
    Error {
        status: StatusCode,
        message: String,
    },
}

/// Trait for provider executors — each provider implements this to handle
/// the upstream HTTP call (constructing auth headers, endpoint URL, shaping body).
#[async_trait::async_trait]
pub trait ProviderExecutor: Send + Sync {
    /// Execute a streaming request to the upstream provider.
    /// Returns an SSE stream of bytes.
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse>;

    /// Execute a non-streaming request to the upstream provider.
    /// Returns the complete response body.
    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse>;
}

/// Select an executor for a given provider type.
/// Returns a Box<dyn ProviderExecutor> for the supported providers.
pub fn select_executor(provider: &str) -> Box<dyn ProviderExecutor> {
    match provider.to_lowercase().as_str() {
        "openai" => Box::new(super::openai::OpenAiExecutor),
        "anthropic" => Box::new(super::anthropic::AnthropicExecutor),
        "google" | "gemini" => Box::new(super::google::GoogleExecutor),
        "azure" | "azure-openai" => Box::new(super::azure::AzureExecutor),
        "ollama" => Box::new(super::ollama::OllamaExecutor),
        // Group 3 executors
        "xiaomi-tokenplan" | "xmtp" => Box::new(super::xiaomi_tokenplan::XiaomiTokenplanExecutor),
        "codebuddy-intl" | "codebuddy" | "cbai" => Box::new(super::codebuddy_intl::CodebuddyIntlExecutor),
        "codebuddy-cn" | "cbcn" => Box::new(super::codebuddy_cn::CodebuddyCnExecutor),
        "gemini-cli" | "gc" => Box::new(super::gemini_cli::GeminiCliExecutor),
        "iflow" | "if" => Box::new(super::iflow::IFlowExecutor),
        "opencode" | "oc" => Box::new(super::opencode::OpenCodeExecutor),
        "kimchi" => Box::new(super::kimchi::KimchiExecutor),
        "mimo-free" | "mmf" => Box::new(super::mimo_free::MimoFreeExecutor),
        "vertex" | "vx" | "vertex-partner" | "vxp" => Box::new(super::vertex::VertexExecutor),
        "zed" | "zd" => Box::new(super::zed::ZedExecutor),
        // Group 3 batch B executors
        "grok-web" | "gw" => Box::new(super::grok_web::GrokWebExecutor),
        "github" | "gh" => Box::new(super::github::GithubExecutor),
        "perplexity-web" | "pw" => Box::new(super::perplexity_web::PerplexityWebExecutor),
        "grok-cli" | "gcli" | "gb" => Box::new(super::grok_cli::GrokCliExecutor),
        "qoder" | "qd" => Box::new(super::qoder::QoderExecutor),
        "windsurf" | "ws" => Box::new(super::windsurf::WindsurfExecutor),
        "antigravity" | "ag" => Box::new(super::antigravity::AntigravityExecutor),
        "devin-cli" | "dv" | "devin" => Box::new(super::devin_cli::DevinCliExecutor),
        // Group 3 batch C executors
        "cursor" | "cu" => Box::new(super::cursor::CursorExecutor),
        "kiro" | "ki" => Box::new(super::kiro::KiroExecutor),
        "codex" | "cd" => Box::new(super::codex::CodexExecutor),
        // Group 3 batch D executors
        "commandcode" | "cmc" => Box::new(super::commandcode::CommandCodeExecutor),
        // Anything else is treated as OpenAI-compatible
        _ => Box::new(super::openai_compat::OpenAiCompatExecutor),
    }
}

/// Shared helper: build a reqwest client with default settings.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Shared helper: extract the API key / auth token from a connection's data JSON.
pub fn get_connection_auth(data: &serde_json::Value) -> Option<String> {
    data.get("apiKey")
        .or_else(|| data.get("api_key"))
        .or_else(|| data.get("token"))
        .or_else(|| data.get("key"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Shared helper: get the base URL from a connection's data JSON.
pub fn get_base_url(data: &serde_json::Value, default: &str) -> String {
    data.get("baseUrl")
        .or_else(|| data.get("base_url"))
        .or_else(|| data.get("endpoint"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default.to_string())
}
