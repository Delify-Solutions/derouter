//! Translator module — format detection, adapter selection, and request/response adapters.
//!
//! The `FORMAT_*` constants and `detect_format_by_endpoint` identify the request/response
//! shape a provider uses. The actual shape adapters (openai↔claude, openai→gemini, etc.)
//! live in submodules and are selected via `select_request_adapter` / `select_response_adapter`
//! based on the transport format string.
//!
//! Ported from open-sse/translator/ (index.js, formats.js, request/*.js, response/*.js).

pub mod schema;
pub mod openai_claude;
pub mod openai_gemini;
pub mod openai_responses;
pub mod openai_kiro;
pub mod openai_cursor;
pub mod openai_ollama;
pub mod openai_commandcode;
pub mod antigravity;

use serde_json::Value;

// ── Format identifiers ───────────────────────────────────────────────────────
// Matches the Node FORMATS map 1:1.

pub const FORMAT_OPENAI: &str = "openai";
pub const FORMAT_OPENAI_RESPONSES: &str = "openai-responses";
pub const FORMAT_OPENAI_RESPONSE: &str = "openai-response";
pub const FORMAT_CLAUDE: &str = "claude";
pub const FORMAT_GEMINI: &str = "gemini";
pub const FORMAT_GEMINI_CLI: &str = "gemini-cli";
pub const FORMAT_VERTEX: &str = "vertex";
pub const FORMAT_CODEX: &str = "codex";
pub const FORMAT_ANTIGRAVITY: &str = "antigravity";
pub const FORMAT_KIRO: &str = "kiro";
pub const FORMAT_CURSOR: &str = "cursor";
pub const FORMAT_OLLAMA: &str = "ollama";
pub const FORMAT_COMMANDCODE: &str = "commandcode";

// ── Format detection ────────────────────────────────────────────────────────

/// Detect the source format from the request URL pathname + body.
/// Returns `None` to fall back to body-based detection (mirrors Node behavior).
pub fn detect_format_by_endpoint(pathname: &str, body: &serde_json::Value) -> Option<&'static str> {
    // /v1/responses is always openai-responses
    if pathname.contains("/v1/responses") {
        return Some(FORMAT_OPENAI_RESPONSES);
    }

    // /v1/messages is always Claude
    if pathname.contains("/v1/messages") {
        return Some(FORMAT_CLAUDE);
    }

    // /v1/chat/completions + input[] → treat as openai (Cursor CLI sends a Responses
    // body via the chat endpoint)
    if pathname.contains("/v1/chat/completions")
        && body.get("input").map(|v| v.is_array()).unwrap_or(false)
    {
        return Some(FORMAT_OPENAI);
    }

    None
}

// ── Adapter selection (task 2.2) ────────────────────────────────────────────

/// Type alias for request adapter functions: (model, body, stream) → translated body.
pub type RequestAdapter = fn(&str, &Value, bool) -> Value;

/// Type alias for response adapter functions: (chunk, state) → list of translated chunks.
/// Returns a Vec because some adapters produce multiple output chunks from one input.
pub type ResponseAdapter = fn(&Value, &mut ResponseState) -> Vec<Value>;

/// Mutable state passed to response adapters. This is a simple JSON object that
/// adapters can read/write freely, mirroring the Node pattern where `state` is a
/// plain JS object.
#[derive(Debug, Default, Clone)]
pub struct ResponseState {
    /// Arbitrary JSON state that adapters can use.
    pub data: Value,
}

impl ResponseState {
    pub fn new() -> Self {
        Self {
            data: Value::Object(serde_json::Map::new()),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.data.get_mut(key)
    }

    pub fn set(&mut self, key: &str, val: Value) {
        if let Some(obj) = self.data.as_object_mut() {
            obj.insert(key.to_string(), val);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(key.to_string(), val);
            self.data = Value::Object(map);
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.data.get(key).is_some()
    }
}

/// Select the request adapter for a given source→target format pair.
///
/// The Node registry uses a two-step pivot through OpenAI:
///   source → openai → target
/// Direct routes (e.g. claude:kiro) bypass the pivot when a direct adapter exists.
///
/// Returns a function pair: (source→openai, openai→target) or a direct adapter.
/// Returns None when no translation is needed (same format) or no adapter exists.
pub fn select_request_adapter(source_format: &str, target_format: &str) -> Option<RequestAdapterPair> {
    if source_format == target_format {
        return None;
    }

    // Check for direct route first
    if let Some(direct) = select_direct_request_adapter(source_format, target_format) {
        return Some(RequestAdapterPair::Direct(direct));
    }

    // Pivot through OpenAI
    let to_openai = if source_format != FORMAT_OPENAI {
        select_to_openai_request_adapter(source_format)
    } else {
        None
    };

    let from_openai = if target_format != FORMAT_OPENAI {
        select_from_openai_request_adapter(target_format)
    } else {
        None
    };

    if to_openai.is_none() && from_openai.is_none() {
        return None;
    }

    Some(RequestAdapterPair::Pivot {
        to_openai,
        from_openai,
    })
}

/// Request adapter pair — either a direct adapter or a two-step pivot through OpenAI.
pub enum RequestAdapterPair {
    Direct(RequestAdapter),
    Pivot {
        to_openai: Option<RequestAdapter>,
        from_openai: Option<RequestAdapter>,
    },
}

/// Select the response adapter for a given target→source format pair.
///
/// The Node registry uses a two-step pivot through OpenAI:
///   target → openai → source
/// Direct routes (e.g. kiro:claude) bypass the pivot.
pub fn select_response_adapter(target_format: &str, source_format: &str) -> Option<ResponseAdapterPair> {
    if target_format == source_format {
        return None;
    }

    // Check for direct route first
    if let Some(direct) = select_direct_response_adapter(target_format, source_format) {
        return Some(ResponseAdapterPair::Direct(direct));
    }

    // Pivot through OpenAI
    let to_openai = if target_format != FORMAT_OPENAI {
        select_to_openai_response_adapter(target_format)
    } else {
        None
    };

    let from_openai = if source_format != FORMAT_OPENAI {
        select_from_openai_response_adapter(source_format)
    } else {
        None
    };

    if to_openai.is_none() && from_openai.is_none() {
        return None;
    }

    Some(ResponseAdapterPair::Pivot {
        to_openai,
        from_openai,
    })
}

/// Response adapter pair — either a direct adapter or a two-step pivot through OpenAI.
pub enum ResponseAdapterPair {
    Direct(ResponseAdapter),
    Pivot {
        to_openai: Option<ResponseAdapter>,
        from_openai: Option<ResponseAdapter>,
    },
}

// ── Direct route selectors ───────────────────────────────────────────────────

fn select_direct_request_adapter(source: &str, target: &str) -> Option<RequestAdapter> {
    match (source, target) {
        (FORMAT_CLAUDE, FORMAT_KIRO) => Some(openai_kiro::claude_to_kiro_request),
        _ => None,
    }
}

fn select_direct_response_adapter(target: &str, source: &str) -> Option<ResponseAdapter> {
    match (target, source) {
        (FORMAT_KIRO, FORMAT_CLAUDE) => Some(openai_kiro::kiro_to_claude_response),
        _ => None,
    }
}

// ── source → openai request adapters ────────────────────────────────────────

fn select_to_openai_request_adapter(source: &str) -> Option<RequestAdapter> {
    match source {
        FORMAT_CLAUDE => Some(openai_claude::claude_to_openai_request),
        FORMAT_GEMINI | FORMAT_GEMINI_CLI => Some(openai_gemini::gemini_to_openai_request),
        FORMAT_ANTIGRAVITY => Some(antigravity::antigravity_to_openai_request),
        FORMAT_OPENAI_RESPONSES => Some(openai_responses::openai_responses_to_openai_request),
        // Kiro, Cursor, Ollama, CommandCode only have request adapters in the
        // openai→target direction (they are targets, not sources).
        _ => None,
    }
}

// ── openai → target request adapters ─────────────────────────────────────────

fn select_from_openai_request_adapter(target: &str) -> Option<RequestAdapter> {
    match target {
        FORMAT_CLAUDE => Some(openai_claude::openai_to_claude_request),
        FORMAT_GEMINI => Some(openai_gemini::openai_to_gemini_request),
        FORMAT_GEMINI_CLI => Some(openai_gemini::openai_to_gemini_cli_request),
        FORMAT_VERTEX => Some(openai_gemini::openai_to_vertex_request),
        FORMAT_ANTIGRAVITY => Some(openai_gemini::openai_to_antigravity_request),
        FORMAT_OPENAI_RESPONSES => Some(openai_responses::openai_to_openai_responses_request),
        FORMAT_KIRO => Some(openai_kiro::openai_to_kiro_request),
        FORMAT_CURSOR => Some(openai_cursor::openai_to_cursor_request),
        FORMAT_OLLAMA => Some(openai_ollama::openai_to_ollama_request),
        FORMAT_COMMANDCODE => Some(openai_commandcode::openai_to_commandcode_request),
        _ => None,
    }
}

// ── target → openai response adapters ────────────────────────────────────────

fn select_to_openai_response_adapter(target: &str) -> Option<ResponseAdapter> {
    match target {
        FORMAT_CLAUDE => Some(openai_claude::claude_to_openai_response),
        FORMAT_GEMINI | FORMAT_GEMINI_CLI | FORMAT_VERTEX | FORMAT_ANTIGRAVITY => {
            Some(openai_gemini::gemini_to_openai_response)
        }
        FORMAT_OPENAI_RESPONSES => Some(openai_responses::openai_responses_to_openai_response),
        FORMAT_KIRO => Some(openai_kiro::kiro_to_openai_response),
        FORMAT_CURSOR => Some(openai_cursor::cursor_to_openai_response),
        FORMAT_OLLAMA => Some(openai_ollama::ollama_to_openai_response),
        FORMAT_COMMANDCODE => Some(openai_commandcode::commandcode_to_openai_response),
        _ => None,
    }
}

// ── openai → source response adapters ────────────────────────────────────────

fn select_from_openai_response_adapter(source: &str) -> Option<ResponseAdapter> {
    match source {
        FORMAT_CLAUDE => Some(openai_claude::openai_to_claude_response),
        FORMAT_ANTIGRAVITY => Some(openai_gemini::openai_to_antigravity_response),
        FORMAT_OPENAI_RESPONSES => Some(openai_responses::openai_to_openai_responses_response),
        _ => None,
    }
}
