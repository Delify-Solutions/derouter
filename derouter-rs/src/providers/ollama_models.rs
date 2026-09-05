//! Ollama models — static list ported from open-sse/config/ollamaModels.js.
//! Used by GET /api/tags to return the model list for the ollama tag picker.

use serde::Serialize;

/// Ollama model entry matching the Node shape from ollamaModels.js.
#[derive(Debug, Clone, Serialize)]
pub struct OllamaModel {
    pub name: &'static str,
    pub modified_at: &'static str,
    pub size: u64,
    pub digest: &'static str,
    pub details: OllamaModelDetails,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaModelDetails {
    pub format: &'static str,
    pub family: &'static str,
    pub parameter_size: &'static str,
    pub quantization_level: &'static str,
}

/// Static ollama models list — ported from open-sse/config/ollamaModels.js.
pub static OLLAMA_MODELS: &[OllamaModel] = &[
    OllamaModel {
        name: "llama3.2",
        modified_at: "2025-12-26T00:00:00Z",
        size: 2000000000,
        digest: "abc123def456",
        details: OllamaModelDetails {
            format: "gguf",
            family: "llama",
            parameter_size: "3B",
            quantization_level: "Q4_K_M",
        },
    },
    OllamaModel {
        name: "qwen2.5",
        modified_at: "2025-12-26T00:00:00Z",
        size: 4000000000,
        digest: "def456abc123",
        details: OllamaModelDetails {
            format: "gguf",
            family: "qwen",
            parameter_size: "7B",
            quantization_level: "Q4_K_M",
        },
    },
];
