//! Codex executor — port of open-sse/executors/codex.js.
//!
//! Handles the OpenAI Codex API (Responses API format) with OAuth bearer auth.
//! Codex uses the Responses API format (`/backend-api/codex/responses`), always
//! streams, and requires `store=false`. The executor performs token refresh
//! via the kiro_token module's `refresh_codex_token` function when the access
//! token is near expiry.
//!
//! Key behaviors ported from Node:
//! - Source format detection + translator framework for source↔responses translation
//! - System role → developer role conversion in input array
//! - Strip server-generated item IDs (rs_/fc_/resp_/msg_)
//! - Flatten chat-completions tool shape to Responses flat format
//! - Filter unsupported tool types
//! - Always set stream=true, store=false
//! - Inject default Codex instructions if missing
//! - Strip fields not in the Responses API allowlist
//! - Resolve thinking level from model suffix and reasoning_effort param
//! - Set session_id and originator headers
//! - ChatGPT-Account-ID header from providerSpecificData
//! - 401 token refresh + single retry
//! - Token masking in error messages
//! - Review model → upstream model mapping (e.g. gpt-5.5-review → gpt-5.5)
//! - _compact URL suffix
//! - prompt_cache_key injection from session_id
//!
//! The SSE-level overloaded-error peek/retry loop from Node is NOT ported —
//! it requires complex stream peeking and re-assembly. Single attempt only.

use std::collections::{HashMap, HashSet};

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::Mutex;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use super::kiro_token;
use crate::db::repos::connections::ProviderConnection;
use crate::proxy::translator::{
    self, FORMAT_OPENAI, FORMAT_OPENAI_RESPONSES, FORMAT_CLAUDE, ResponseState,
    RequestAdapterPair, ResponseAdapterPair,
};

pub struct CodexExecutor;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

const CODEX_DEFAULT_INSTRUCTIONS: &str = "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\n## General\n\n- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)\n\n## Editing constraints\n\n- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.\n- Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like \"Assigns the value to the variable\", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to spend time parsing out. Usage of these comments should be rare.\n- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n- You may be in a dirty git worktree.\n    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.\n    * If asked to make a commit or code edits and there are unrelated changes that your work or changes that you didn't make in those files, don't revert those changes.\n    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.\n    * If the changes are in unrelated files, just ignore them and don't revert them.\n- Do not amend a commit unless explicitly requested to do so.\n- While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how to proceed.\n- **NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved by the user.\n\n## Plan tool\n\nWhen using the planning tool:\n- Skip using the planning tool for straightforward tasks (roughly the easiest 25%).\n- Do not make single-step plans.\n- When you made a plan, update it after having performed one of the sub-tasks that you shared on the plan.\n\n## Codex CLI harness, sandboxing, and approvals\n\nThe Codex CLI harness supports several different configurations for sandboxing and escalation approvals that the user can choose from.\n\nFilesystem sandboxing defines which files can be read or written. The options for `sandbox_mode` are:\n- **read-only**: The sandbox only permits reading files.\n- **workspace-write**: The sandbox permits reading files, and editing files in `cwd` and `writable_roots`. Editing files in other directories requires approval.\n- **danger-full-access**: No filesystem sandboxing - all commands are permitted.\n\nNetwork sandboxing defines whether network can be accessed without approval. Options for `network_access` are:\n- **restricted**: Requires approval\n- **enabled**: No approval needed\n\nApprovals are your mechanism to get user consent to run shell commands without the sandbox. Possible configuration options for `approval_policy` are\n- **untrusted**: The harness will escalate most commands for user approval, apart from a limited allowlist of safe \"read\" commands.\n- **on-failure**: The harness will allow all commands to run in the sandbox (if enabled), and failures will be escalated to the user for approval to run again without the sandbox.\n- **on-request**: Commands will be run in the sandbox by default, and you can specify in your tool call if you want to escalate a command to run without sandboxing. (Note that this mode is not always available. If it is, you'll see parameters for it in the `shell` command description.)\n- **never**: This is a non-interactive mode where you may NEVER ask the user for approval to run commands. Instead, you must always persist and work around constraints to solve the task for the user. You MUST do your utmost best to finish the task and validate your work before yielding. If this mode is paired with `danger-full-access`, take advantage of it to deliver the best outcome for the user. Further, in this mode, your default testing philosophy is overridden: Even if you don't see local patterns for testing, you may add tests and scripts to validate your work. Just remove them before yielding.\n\nWhen you are running with `approval_policy == on-request`, and sandboxing enabled, here are scenarios where you'll need to request approval:\n- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)\n- You need to run a GUI app (e.g., open/xdg-open/osascript) to open browsers or files.\n- You are running sandboxed and need to run a command that requires network access (e.g. installing packages)\n- If you run a command that is important to solving the user's query, but it fails because of sandboxing, rerun the command with approval. ALWAYS proceed to use the `sandbox_permissions` and `justification` parameters - do not message the user before requesting approval for the command.\n- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for\n- (for all of these, you should weigh alternative paths that do not require approval)\n\nWhen `sandbox_mode` is set to read-only, you'll need to request approval for any command that isn't a read.\n\nYou will be told what filesystem sandboxing, network sandboxing, and approval mode are active in a developer or user message. If you are not told about this, assume that you are running with workspace-write, network sandboxing enabled, and approval on-failure.\n\nAlthough they introduce friction to the user because your work is paused until the user responds, you should leverage them when necessary to accomplish important work. If the completing the task requires escalated permissions, Do not let these settings or the sandbox deter you from attempting to accomplish the user's task unless it is set to \"never\", in which case never ask for approvals.\n\nWhen requesting approval to execute a command that will require escalated privileges:\n  - Provide the `sandbox_permissions` parameter with the value `\"require_escalated\"`\n  - Include a short, 1 sentence explanation for why you need escalated permissions in the justification parameter\n\n## Special user requests\n\n- If the user makes a simple request (such as asking the time) which you can fulfill by running a terminal command (such as `date`), you should do so.\n- If the user asks for a \"review\", default to a code review mindset: prioritise identifying bugs, risks, behavioural regressions, and missing tests. Findings must be the primary focus of the response - keep summaries or overviews brief and only after the issues. Present findings first (ordered by severity with file/line references), follow with open questions or assumptions, and offer a change-summary only as a secondary detail. If no findings are discovered, state that explicitly and mention any residual risks or testing gaps.\n\n## Frontend tasks\nWhen doing frontend design tasks, avoid collapsing into \"AI slop\" or safe, average-looking layouts.\nAim for interfaces that feel intentional, bold, and a bit surprising.\n- Typography: Use expressive, purposeful fonts and avoid default stacks (Inter, Roboto, Arial, system).\n- Color & Look: Choose a clear visual direction; define CSS variables; avoid purple-on-white defaults. No purple bias or dark mode bias.\n- Motion: Use a few meaningful animations (page-load, staggered reveals) instead of generic micro-motions.\n- Background: Don't rely on flat, single-color backgrounds; use gradients, shapes, or subtle patterns to build atmosphere.\n- Overall: Avoid boilerplate layouts and interchangeable UI patterns. Vary themes, type families, and visual languages across outputs.\n- Ensure the page loads properly on both desktop and mobile\n\nException: If working within an existing website or design system, preserve the established patterns, structure, and visual language.\n\n## Presenting your work and final message\n\nYou are producing plain text that will later be styled by the CLI. Follow these rules exactly. Formatting should make results easy to scan, but not feel mechanical. Use judgment to decide how much structure adds value.\n\n- Default: be very concise; friendly coding teammate tone.\n- Ask only when needed; suggest ideas; mirror the user's style.\n- For substantial work, summarize clearly; follow final-answer formatting.\n- Skip heavy formatting for simple confirmations.\n- Don't dump large files you've written; reference paths only.\n- No \"save/copy this file\" - User is on the same machine.\n- Offer logical next steps (tests, commits, build) briefly; add verify steps if you couldn't do something.\n- For code changes:\n  * Lead with a quick explanation of the change, and then give more details in the context covering where and why a change was made. Do not start this explanation with \"summary\", just jump right in.\n  * If there are natural next steps the user may want to take, suggest them at the end of your response. Do not make suggestions if there are no natural next steps.\n  * When suggesting multiple options, use numeric lists for the suggestions so the user can quickly respond with a single number.\n  * The user does not command execution outputs. When asked to show the output of a command (e.g. `git show`), relay the important details in your answer or summarize the key lines so the user understands the result.\n\n### Final answer structure and style guidelines\n\n- Plain text; CLI handles styling. Use structure only when it helps scanability.\n- Headers: optional; short Title Case (1-3 words) wrapped in **...**; no blank line before the first bullet; add only if they truly help.\n- Bullets: use - ; merge related points; keep to one line when possible; 4-6 per list ordered by importance; keep phrasing consistent.\n- Monospace: backticks for commands/paths/env vars/code ids and inline examples; use for literal keyword bullets; never combine with **.\n- Code samples or multi-line snippets should be wrapped in fenced code blocks; include an info string as often as possible.\n- Structure: group related bullets; order sections general -> specific -> supporting; for subsections, start with a bolded keyword bullet, then items; match complexity to the task.\n- Tone: collaborative, concise, factual; present tense, active voice; self-contained; no \"above/below\"; parallel wording.\n- Don'ts: no nested bullets/hierarchies; no ANSI codes; don't cram unrelated keywords; keep keyword lists short - wrap/reformat if long; avoid naming formatting styles in answers.\n- Adaptation: code explanations -> precise, structured with code refs; simple tasks -> lead with outcome; big changes -> logical walkthrough + rationale + next actions; casual one-offs -> plain sentences, no headers/bullets.\n- File References: When referencing files in your response follow the below rules:\n  * Use inline code to make file paths clickable.\n  * Each reference should have a stand alone path. Even if it's same file.\n  * Accepted: absolute, workspace-relative, a/ or b/ diff prefixes, or bare filename/suffix.\n  * Optionally include line/column (1-based): :line[:column] or #Lline[Ccolumn] (column defaults to 1).\n  * Do not use URIs like file://, vscode://, or https://.\n  * Do not provide range of lines\n  * Examples: src/app.ts, src/app.ts:42, b/server/index.js#L10, C:\\repo\\project\\main.rs:12:5";

/// Fields accepted by the Codex Responses API — anything else is stripped.
const RESPONSES_API_ALLOWLIST: &[&str] = &[
    "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
    "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
    "text",
];

/// Hosted tool types that Codex/OpenAI Responses executes server-side.
const CODEX_HOSTED_TOOL_TYPES: &[&str] = &[
    "image_generation", "web_search", "web_search_preview", "file_search",
    "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
    "tool_search",
];

/// Responses-native freeform tool types that pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES: &[&str] = &["custom"];

/// Thinking effort levels extractable from model name suffix.
const EFFORT_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];

/// Codex GPT 5.6 models that support "max" and "ultra" thinking levels.
const CODEX_GPT_5_6_MODELS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/// In-memory cache of recent Codex token refreshes keyed by connection id.
static CODEX_REFRESH_CACHE: Lazy<Mutex<HashMap<String, kiro_token::RefreshedToken>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Mask a token/key in a string for safe logging/error messages.
fn mask_token(s: &str) -> String {
    if s.len() <= 8 {
        return "****".to_string();
    }
    format!("{}...{}", &s[..4], &s[s.len() - 4..])
}

/// Detect the source format from the request body shape.
/// - Body with `input` array -> openai-responses
/// - Body with `messages` array + claude markers -> claude
/// - Body with `messages` array -> openai
/// - Default -> openai
fn detect_source_format(body: &Value) -> &'static str {
    // If body already has `input`, it's in responses format
    if body.get("input").is_some() {
        return FORMAT_OPENAI_RESPONSES;
    }

    // Check for claude markers in messages
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            // Claude messages use content arrays with type blocks
            if msg.get("content").map(|v| v.is_array()).unwrap_or(false) {
                if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                    for block in content {
                        let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if matches!(block_type, "text" | "tool_use" | "tool_result" | "thinking" | "image") {
                            // Could be claude — check for anthropic marker
                            if msg.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                                if block_type == "tool_use" || block_type == "tool_result" || block_type == "thinking" {
                                    return FORMAT_CLAUDE;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    FORMAT_OPENAI
}

/// Apply a request adapter pair to translate the body from source to target format.
fn apply_request_adapter(
    adapter: &RequestAdapterPair,
    model: &str,
    body: &Value,
    stream: bool,
) -> Value {
    match adapter {
        RequestAdapterPair::Direct(f) => f(model, body, stream),
        RequestAdapterPair::Pivot { to_openai, from_openai } => {
            let intermediate = if let Some(to_oi) = to_openai {
                to_oi(model, body, stream)
            } else {
                body.clone()
            };
            if let Some(from_oi) = from_openai {
                from_oi(model, &intermediate, stream)
            } else {
                intermediate
            }
        }
    }
}

/// Apply a response adapter pair to translate upstream chunks back to source format.
fn apply_response_adapter(
    adapter: &ResponseAdapterPair,
    chunk: &Value,
    state: &mut ResponseState,
) -> Vec<Value> {
    match adapter {
        ResponseAdapterPair::Direct(f) => f(chunk, state),
        ResponseAdapterPair::Pivot { to_openai, from_openai } => {
            let intermediate: Vec<Value> = if let Some(to_oi) = to_openai {
                to_oi(chunk, state)
            } else {
                vec![chunk.clone()]
            };
            let mut results = Vec::new();
            for inter_chunk in intermediate {
                if let Some(from_oi) = from_openai {
                    results.extend(from_oi(&inter_chunk, state));
                } else {
                    results.push(inter_chunk);
                }
            }
            results
        }
    }
}

/// Check if a value looks like a server-generated item ID (rs_/fc_/resp_/msg_).
fn is_server_id(s: &str) -> bool {
    s.starts_with("rs_")
        || s.starts_with("fc_")
        || s.starts_with("resp_")
        || s.starts_with("msg_")
}

/// Convert role=system to role=developer in body.input.
fn convert_system_to_developer(body: &mut Value) {
    if let Some(input) = body.get_mut("input").and_then(|v| v.as_array_mut()) {
        for item in input.iter_mut() {
            if !item.is_object() || item.is_array() {
                continue;
            }
            let is_system = item.get("role").and_then(|v| v.as_str()) == Some("system")
                && item
                    .get("type")
                    .map(|v| v.is_null() || v.as_str() == Some("message"))
                    .unwrap_or(true);
            if is_system {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("role".to_string(), Value::String("developer".to_string()));
                }
            }
        }
    }
}

/// Strip server-generated item IDs from body.input.
fn strip_stored_item_references(body: &mut Value) {
    if let Some(input) = body.get_mut("input").and_then(|v| v.as_array_mut()) {
        input.retain(|item| {
            if let Some(s) = item.as_str() {
                return !is_server_id(s);
            }
            if item.is_object() && !item.is_array() {
                if item.get("type").and_then(|v| v.as_str()) == Some("item_reference") {
                    return false;
                }
            }
            true
        });
        // Strip server-generated IDs from remaining items
        for item in input.iter_mut() {
            if item.is_object() && !item.is_array() {
                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                    if is_server_id(id) {
                        if let Some(obj) = item.as_object_mut() {
                            obj.remove("id");
                        }
                    }
                }
            }
        }
    }
}

/// Flatten chat-completions tool shape into Responses flat format and filter unsupported tools.
fn normalize_codex_tools(body: &mut Value) {
    let tools = match body.get_mut("tools").and_then(|v| v.as_array_mut()) {
        Some(t) => t,
        None => return,
    };

    let mut valid_names: HashSet<String> = HashSet::new();
    let mut filtered: Vec<Value> = Vec::new();

    for tool in tools.iter_mut() {
        if !tool.is_object() || tool.is_array() {
            continue;
        }

        let type_val = tool
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Namespace tools: collect sub-tool names, keep the tool as-is
        if type_val == "namespace" {
            if let Some(sub) = tool.get("tools").and_then(|v| v.as_array()) {
                for st in sub {
                    let name = st
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if !name.is_empty() {
                        valid_names.insert(name.chars().take(128).collect());
                    }
                }
            }
            filtered.push(tool.clone());
            continue;
        }

        // Function tools: flatten from {type:"function", function:{name, parameters}} to flat format
        if type_val != "function" {
            // Passthrough custom tools
            if CODEX_PASSTHROUGH_TOOL_TYPES.contains(&type_val.as_str()) {
                filtered.push(tool.clone());
                continue;
            }
            // Reject if has .function or .name (chat-completions shape for non-function type)
            if type_val.is_empty() || tool.get("function").is_some() || tool.get("name").is_some() {
                continue;
            }
            // Keep hosted tool types
            if CODEX_HOSTED_TOOL_TYPES.contains(&type_val.as_str()) {
                filtered.push(tool.clone());
            }
            continue;
        }

        // Flatten function tool
        let fn_obj = tool.get("function");
        let raw_name = tool
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| fn_obj.and_then(|f| f.get("name")).and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        if raw_name.is_empty() {
            continue;
        }

        let description = tool
            .get("description")
            .and_then(|v| v.as_str())
            .or_else(|| fn_obj.and_then(|f| f.get("description")).and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();

        let parameters = tool
            .get("parameters")
            .filter(|v| v.is_object() && !v.is_array())
            .cloned()
            .or_else(|| {
                fn_obj
                    .and_then(|f| f.get("parameters"))
                    .filter(|v| v.is_object() && !v.is_array())
                    .cloned()
            })
            .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}}));

        let name: String = raw_name.chars().take(128).collect();
        valid_names.insert(name.clone());

        let mut normalized = serde_json::Map::new();
        normalized.insert("type".to_string(), Value::String("function".to_string()));
        normalized.insert("name".to_string(), Value::String(name));
        if !description.is_empty() {
            normalized.insert("description".to_string(), Value::String(description));
        }
        normalized.insert("parameters".to_string(), parameters);

        filtered.push(Value::Object(normalized));
    }

    // Apply the filtered tools back before borrowing body again
    *tools = filtered;

    // Drop tool_choice if it references an unknown function name
    if let Some(tc) = body.get_mut("tool_choice") {
        if tc.is_object() && !tc.is_array() {
            if tc.get("type").and_then(|v| v.as_str()) == Some("function") {
                let name = tc
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() || !valid_names.contains(&name) {
                    if let Some(obj) = body.as_object_mut() {
                        obj.remove("tool_choice");
                    }
                }
            }
        }
    }
}

/// Check if a model supports a given thinking level.
/// Ported from thinkingLevels.js — codex-specific logic.
fn supports_thinking_level(model: &str, level: &str) -> bool {
    if CODEX_GPT_5_6_MODELS.iter().any(|m| model.contains(m)) {
        let levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
        return levels.contains(&level);
    }
    if model.contains("codex") {
        // codex cannot disable thinking — only low, medium, high, xhigh
        return ["low", "medium", "high", "xhigh"].contains(&level);
    }
    // Default openai levels
    ["none", "minimal", "low", "medium", "high", "xhigh"].contains(&level)
}

/// Normalize reasoning effort for Codex.
/// Ported from codex.js `normalizeReasoningEffort`.
fn normalize_reasoning_effort<'a>(model: &str, value: &'a str) -> &'a str {
    // If the level is directly supported, keep it
    if supports_thinking_level(model, value) {
        return match value {
            "none" => "none",
            "minimal" => "minimal",
            "low" => "low",
            "medium" => "medium",
            "high" => "high",
            "xhigh" => "xhigh",
            "max" => "max",
            "ultra" => "ultra",
            _ => value,
        };
    }
    // "ultra" → "max" if model supports max
    if value == "ultra" && supports_thinking_level(model, "max") {
        return "max";
    }
    // "max" or "ultra" → "xhigh" as fallback
    if value == "max" || value == "ultra" {
        return "xhigh";
    }
    value
}

/// Resolve the upstream model ID for Codex.
/// Review models (e.g. `gpt-5.5-review`) map to their base model.
/// Ported from getModelUpstreamId("cx", model).
fn resolve_upstream_model(model: &str) -> String {
    // Strip -review suffix — review models use the same upstream model
    if model.ends_with("-review") {
        return model[..model.len() - "-review".len()].to_string();
    }
    model.to_string()
}

/// Transform the request body for Codex Responses API.
/// This runs AFTER source→responses format translation.
fn transform_request(model: &str, body: &mut Value, conn: &ProviderConnection) {
    // Extract _compact flag before it gets stripped by the allowlist filter
    let is_compact = body
        .get("_compact")
        .map(|v| v.as_bool().unwrap_or(false))
        .unwrap_or(false);
    if let Some(obj) = body.as_object_mut() {
        obj.remove("_compact");
    }

    // Store compact flag in a temporary field we'll read later
    if is_compact {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("__codex_compact".to_string(), Value::Bool(true));
        }
    }

    // Normalize string input to array format
    if let Some(input) = body.get("input").cloned() {
        if let Some(s) = input.as_str() {
            if !s.is_empty() {
                body["input"] = serde_json::json!([
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": s }] }
                ]);
            }
        }
        // Ensure input is present and non-empty
        let need_default = body
            .get("input")
            .map(|v| v.is_array() && v.as_array().unwrap().is_empty())
            .unwrap_or(true);
        if need_default {
            body["input"] = serde_json::json!([
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] }
            ]);
        }
    } else {
        body["input"] = serde_json::json!([
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] }
        ]);
    }

    // Convert system → developer role
    convert_system_to_developer(body);

    // Strip server-generated item IDs
    strip_stored_item_references(body);

    // Flatten function tools + drop unsupported types
    normalize_codex_tools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body["stream"] = Value::Bool(true);

    // If no instructions provided, inject default Codex instructions
    let instructions = body.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
    if instructions.trim().is_empty() {
        body["instructions"] = Value::String(CODEX_DEFAULT_INSTRUCTIONS.to_string());
    }

    // Ensure store is false (Codex requirement)
    body["store"] = Value::Bool(false);

    // Resolve session_id for prompt_cache_key
    let psd = kiro_token::get_provider_specific_data(conn);
    let session_id = psd
        .get("workspaceId")
        .or_else(|| psd.get("chatgptAccountId"))
        .or_else(|| psd.get("accountId"))
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();

    // Inject prompt_cache_key for stable Codex prompt caching
    if body.get("prompt_cache_key").is_none() {
        body["prompt_cache_key"] = Value::String(session_id.clone());
    }

    // Map virtual Codex review models to the upstream Codex model
    let body_model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(model)
        .to_string();
    let upstream_model = resolve_upstream_model(&body_model);

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    let mut model_effort: Option<&str> = None;
    let mut final_model = upstream_model.clone();
    for level in EFFORT_LEVELS {
        let suffix = format!("-{}", level);
        if upstream_model.ends_with(&suffix) {
            model_effort = Some(level);
            final_model = upstream_model[..upstream_model.len() - suffix.len()].to_string();
            break;
        }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (low)
    let body_effort = body.get("reasoning_effort").and_then(|v| v.as_str());
    let effort = if let Some(e) = body_effort {
        normalize_reasoning_effort(&final_model, e)
    } else if let Some(e) = model_effort {
        normalize_reasoning_effort(&final_model, e)
    } else {
        "low"
    };

    // Set reasoning with effort + summary
    if body.get("reasoning").is_none() {
        body["reasoning"] = serde_json::json!({ "effort": effort, "summary": "auto" });
    } else {
        if let Some(r) = body.get_mut("reasoning").and_then(|v| v.as_object_mut()) {
            if let Some(e) = r.get("effort").and_then(|v| v.as_str()) {
                let normalized = normalize_reasoning_effort(&final_model, e);
                r.insert("effort".to_string(), Value::String(normalized.to_string()));
            }
            if !r.contains_key("summary") {
                r.insert("summary".to_string(), Value::String("auto".to_string()));
            }
        }
    }

    // Remove reasoning_effort (already folded into reasoning.effort)
    if let Some(obj) = body.as_object_mut() {
        obj.remove("reasoning_effort");
    }

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if let Some(r) = body.get("reasoning").and_then(|v| v.get("effort")).and_then(|v| v.as_str()) {
        if !r.is_empty() && r != "none" {
            body["include"] = serde_json::json!(["reasoning.encrypted_content"]);
        }
    }

    // Remove unsupported parameters for Codex API
    if let Some(obj) = body.as_object_mut() {
        let to_remove: Vec<String> = obj
            .keys()
            .filter(|k| {
                k.as_str() == "temperature"
                    || k.as_str() == "top_p"
                    || k.as_str() == "frequency_penalty"
                    || k.as_str() == "presence_penalty"
                    || k.as_str() == "logprobs"
                    || k.as_str() == "top_logprobs"
                    || k.as_str() == "n"
                    || k.as_str() == "seed"
                    || k.as_str() == "max_tokens"
                    || k.as_str() == "max_completion_tokens"
                    || k.as_str() == "max_output_tokens"
                    || k.as_str() == "user"
                    || k.as_str() == "prompt_cache_retention"
                    || k.as_str() == "metadata"
                    || k.as_str() == "stream_options"
                    || k.as_str() == "safety_identifier"
                    || k.as_str() == "previous_response_id"
            })
            .cloned()
            .collect();
        for k in to_remove {
            obj.remove(&k);
        }

        // Service tier normalization: "fast" → "priority", only "priority" is allowed
        if let Some(st) = obj.get_mut("service_tier") {
            if st.as_str() == Some("fast") {
                *st = Value::String("priority".to_string());
            }
        }
        if let Some(st) = obj.get("service_tier").and_then(|v| v.as_str()) {
            if st != "priority" {
                obj.remove("service_tier");
            }
        }

        // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
        let to_remove: Vec<String> = obj
            .keys()
            .filter(|k| !RESPONSES_API_ALLOWLIST.contains(&k.as_str()))
            .cloned()
            .collect();
        for k in to_remove {
            obj.remove(&k);
        }
    }

    // Set the resolved model (after suffix stripping and review → base mapping)
    body["model"] = Value::String(final_model);
}

/// Build the upstream URL, optionally with /compact suffix.
fn build_url(body: &Value) -> String {
    let is_compact = body
        .get("__codex_compact")
        .map(|v| v.as_bool().unwrap_or(false))
        .unwrap_or(false);

    if is_compact {
        format!("{}/compact", CODEX_BASE_URL)
    } else {
        CODEX_BASE_URL.to_string()
    }
}

/// Resolve the access token, refreshing if needed.
/// Returns (access_token, refreshed: bool).
async fn resolve_access_token(
    conn: &ProviderConnection,
) -> Option<(String, bool)> {
    let mut access_token = kiro_token::get_access_token(conn);
    let refresh_token = kiro_token::get_refresh_token(conn);
    let mut refreshed = false;

    // Check in-memory cache first (stampede prevention)
    {
        let cache = CODEX_REFRESH_CACHE.lock().await;
        if let Some(cached) = cache.get(&conn.id) {
            let now = now_ms();
            let lead = 5 * 60 * 1000; // 5 min lead
            if cached.expires_at_ms.saturating_sub(now) > lead {
                return Some((cached.access_token.clone(), false));
            }
        }
    }

    // Check if we need to refresh
    if access_token.is_some() && kiro_token::needs_refresh(conn) {
        if let Some(ref rt) = refresh_token {
            match kiro_token::refresh_codex_token(rt).await {
                Ok(refreshed_token) => {
                    // Cache the refreshed token
                    CODEX_REFRESH_CACHE.lock().await.insert(
                        conn.id.clone(),
                        kiro_token::RefreshedToken {
                            access_token: refreshed_token.access_token.clone(),
                            refresh_token: refreshed_token.refresh_token.clone(),
                            expires_at_ms: refreshed_token.expires_at_ms,
                        },
                    );
                    access_token = Some(refreshed_token.access_token);
                    refreshed = true;
                }
                Err(e) => {
                    tracing::warn!(
                        "Codex token refresh failed for connection {}: {}",
                        conn.id,
                        e
                    );
                    // Try with existing token — it might still work
                }
            }
        }
    }

    // If no access token, try apiKey as fallback
    if access_token.is_none() {
        access_token = get_connection_auth(&conn.data);
    }

    access_token.map(|t| (t, refreshed))
}

#[async_trait::async_trait]
impl ProviderExecutor for CodexExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: Value,
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, true, &headers).await
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: Value,
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        // Codex is stream-only — always stream
        self.execute(conn, body, true, &headers).await
    }
}

impl CodexExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: Value,
        stream: bool,
        _incoming_headers: &HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let _ = stream; // Codex always streams

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gpt-5.4")
            .to_string();

        // Detect source format and translate to openai-responses
        let source_format = detect_source_format(&body);

        let mut body_responses = if source_format == FORMAT_OPENAI_RESPONSES {
            // Already in responses format — just clone
            body.clone()
        } else if let Some(adapter) =
            translator::select_request_adapter(source_format, FORMAT_OPENAI_RESPONSES)
        {
            // Translate source → openai-responses
            apply_request_adapter(&adapter, &model, &body, true)
        } else {
            // No adapter available — best effort: use as-is
            tracing::warn!(
                "Codex: no request adapter for source format '{}', using body as-is",
                source_format
            );
            body.clone()
        };

        // Apply Codex-specific transform (system→developer, strip IDs, tools, instructions, etc.)
        transform_request(&model, &mut body_responses, conn);

        // Build URL (optionally /compact suffix)
        let url = build_url(&body_responses);

        // Clean up the __codex_compact temp field before sending
        if let Some(obj) = body_responses.as_object_mut() {
            obj.remove("__codex_compact");
        }

        // Resolve access token
        let (access_token, _refreshed) = match resolve_access_token(conn).await {
            Some((token, ref_flag)) => (token, ref_flag),
            None => {
                return Ok(UpstreamResponse::Error {
                    status: StatusCode::UNAUTHORIZED,
                    message: "Codex connection missing access token".to_string(),
                });
            }
        };

        // Build headers
        let psd = kiro_token::get_provider_specific_data(conn);
        let session_id = psd
            .get("workspaceId")
            .or_else(|| psd.get("chatgptAccountId"))
            .or_else(|| psd.get("accountId"))
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        let account_id = psd
            .get("workspaceId")
            .or_else(|| psd.get("chatgptAccountId"))
            .or_else(|| psd.get("accountId"))
            .and_then(|v| v.as_str());

        let client = build_client();

        // First attempt
        let resp = self
            .send_request(
                &client,
                &url,
                &access_token,
                &session_id,
                account_id,
                &body_responses,
            )
            .await?;

        let status = resp.status();

        // 401 → refresh token and retry once
        if status.as_u16() == 401 {
            tracing::info!(
                "Codex 401 for connection {} — attempting token refresh + retry",
                conn.id
            );

            let refresh_token = kiro_token::get_refresh_token(conn);
            if let Some(ref rt) = refresh_token {
                match kiro_token::refresh_codex_token(rt).await {
                    Ok(refreshed) => {
                        // Cache the new token
                        CODEX_REFRESH_CACHE.lock().await.insert(
                            conn.id.clone(),
                            kiro_token::RefreshedToken {
                                access_token: refreshed.access_token.clone(),
                                refresh_token: refreshed.refresh_token.clone(),
                                expires_at_ms: refreshed.expires_at_ms,
                            },
                        );

                        // Retry with the new token
                        let retry_resp = self
                            .send_request(
                                &client,
                                &url,
                                &refreshed.access_token,
                                &session_id,
                                account_id,
                                &body_responses,
                            )
                            .await?;

                        let retry_status = retry_resp.status();
                        if retry_status.as_u16() == 401 {
                            // Still 401 after refresh — return error (no loop)
                            let text = retry_resp.text().await.unwrap_or_default();
                            return Ok(UpstreamResponse::Error {
                                status: StatusCode::UNAUTHORIZED,
                                message: format!(
                                    "Codex authentication failed after token refresh: {}",
                                    mask_token(&text)
                                ),
                            });
                        }

                        if !retry_status.is_success() {
                            let text = retry_resp.text().await.unwrap_or_default();
                            let err_status = map_error_status(retry_status.as_u16());
                            return Ok(UpstreamResponse::Error {
                                status: err_status,
                                message: format!("Codex upstream error: {}", text),
                            });
                        }

                        // Success on retry — stream the response
                        return self
                            .handle_success_response(
                                retry_resp,
                                source_format,
                                &model,
                            )
                            .await;
                    }
                    Err(e) => {
                        // Refresh failed — return 401
                        return Ok(UpstreamResponse::Error {
                            status: StatusCode::UNAUTHORIZED,
                            message: format!(
                                "Codex token refresh failed: {}. Re-authentication required.",
                                e
                            ),
                        });
                    }
                }
            } else {
                // No refresh token — return 401
                return Ok(UpstreamResponse::Error {
                    status: StatusCode::UNAUTHORIZED,
                    message: "Codex authentication failed: no refresh token available".to_string(),
                });
            }
        }

        // Non-401 error
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let err_status = map_error_status(status.as_u16());
            return Ok(UpstreamResponse::Error {
                status: err_status,
                message: format!("Codex upstream error: {}", text),
            });
        }

        // Success — handle the response
        self.handle_success_response(resp, source_format, &model).await
    }

    /// Send a single request to the Codex upstream.
    async fn send_request(
        &self,
        client: &reqwest::Client,
        url: &str,
        access_token: &str,
        session_id: &str,
        account_id: Option<&str>,
        body: &Value,
    ) -> anyhow::Result<reqwest::Response> {
        let mut req = client
            .post(url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("session_id", session_id)
            .header("originator", "codex_cli_rs")
            .header("User-Agent", "codex_cli_rs/0.136.0")
            .json(body);

        if let Some(aid) = account_id {
            if !aid.is_empty() {
                req = req.header("ChatGPT-Account-ID", aid);
            }
        }

        req.send().await.map_err(anyhow::Error::from)
    }

    /// Handle a successful (2xx) response from Codex.
    /// If source_format == openai-responses, pass through the SSE stream directly.
    /// Otherwise, translate the SSE chunks back to the source format.
    async fn handle_success_response(
        &self,
        resp: reqwest::Response,
        source_format: &'static str,
        model: &str,
    ) -> anyhow::Result<UpstreamResponse> {
        // If source is already openai-responses, pass through directly
        if source_format == FORMAT_OPENAI_RESPONSES {
            let stream = resp
                .bytes_stream()
                .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

            let boxed: Box<
                dyn futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin,
            > = Box::new(stream);

            return Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: boxed,
            });
        }

        // For non-responses source formats, we need to translate the SSE stream.
        // Codex always streams SSE in responses format. We:
        // 1. Read the SSE bytes
        // 2. Parse each SSE event as JSON (responses format)
        // 3. Run through select_response_adapter(FORMAT_OPENAI_RESPONSES, source_format)
        // 4. Re-encode translated chunks as SSE in the source format
        let response_adapter = translator::select_response_adapter(
            FORMAT_OPENAI_RESPONSES,
            source_format,
        );

        match response_adapter {
            Some(adapter) => {
                // Read the full SSE response from upstream
                let body_bytes = resp.bytes().await?;

                // Parse + translate + re-encode
                let translated_sse =
                    translate_sse_stream(&body_bytes, &adapter, model, source_format);

                Ok(UpstreamResponse::Json {
                    status: StatusCode::OK,
                    headers: HeaderMap::new(),
                    body: Bytes::from(translated_sse),
                })
            }
            None => {
                // No response adapter — pass through raw SSE
                let stream = resp
                    .bytes_stream()
                    .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

                let boxed: Box<
                    dyn futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin,
                > = Box::new(stream);

                Ok(UpstreamResponse::Stream {
                    headers: HeaderMap::new(),
                    stream: boxed,
                })
            }
        }
    }
}

/// Map an HTTP status code to the appropriate StatusCode for error responses.
fn map_error_status(code: u16) -> StatusCode {
    match code {
        401 | 403 => StatusCode::UNAUTHORIZED,
        429 => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Parse an SSE byte stream into individual event JSON values.
/// Codex SSE format is:
///   event: <event_type>
///   data: <json>
///
/// Or just:
///   data: <json>
///
/// We extract each `data:` line, parse as JSON, and return a list of events.
fn parse_sse_events(data: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(data);
    let mut events = Vec::new();

    // Split on double newlines to get individual SSE events
    for event_block in text.split("\n\n") {
        let mut event_type: Option<String> = None;
        let mut data_lines: Vec<&str> = Vec::new();

        for line in event_block.lines() {
            if line.starts_with("event:") {
                event_type = line[6..].trim().to_string().into();
            } else if line.starts_with("data:") {
                let data = line[5..].trim();
                if !data.is_empty() && data != "[DONE]" {
                    data_lines.push(data);
                }
            }
        }

        for data_str in data_lines {
            if let Ok(json_val) = serde_json::from_str::<Value>(data_str) {
                // If there was an event: line, embed it in the JSON for the adapter
                let mut event = json_val;
                if let Some(et) = &event_type {
                    if let Some(obj) = event.as_object_mut() {
                        obj.insert("event".to_string(), Value::String(et.clone()));
                        // Ensure type field is set (adapters check "type" or "event")
                        if !obj.contains_key("type") {
                            obj.insert("type".to_string(), Value::String(et.clone()));
                        }
                    }
                }
                events.push(event);
            }
        }
    }

    events
}

/// Translate an SSE byte stream from responses format to the source format.
/// Outputs a full SSE byte stream in the target format.
fn translate_sse_stream(
    body: &[u8],
    adapter: &ResponseAdapterPair,
    model: &str,
    _source_format: &str,
) -> Vec<u8> {
    let events = parse_sse_events(body);
    let mut state = ResponseState::new();
    let mut output = String::new();

    for event in &events {
        // Set the model in state so adapters can use it
        state.set("model", Value::String(model.to_string()));

        let translated = apply_response_adapter(adapter, event, &mut state);

        for chunk in translated {
            let chunk_str = serde_json::to_string(&chunk).unwrap_or_default();
            output.push_str("data: ");
            output.push_str(&chunk_str);
            output.push_str("\n\n");
        }
    }

    // Flush: send a null chunk to trigger the adapter's final flush
    state.set("model", Value::String(model.to_string()));
    let flush_chunks = apply_response_adapter(adapter, &Value::Null, &mut state);
    for chunk in flush_chunks {
        let chunk_str = serde_json::to_string(&chunk).unwrap_or_default();
        output.push_str("data: ");
        output.push_str(&chunk_str);
        output.push_str("\n\n");
    }

    output.push_str("data: [DONE]\n\n");
    output.into_bytes()
}
