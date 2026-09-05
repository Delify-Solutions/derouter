//! Cursor Protobuf Encoder/Decoder
//!
//! Rust port of open-sse/utils/cursorProtobuf.js.
//! Implements the ConnectRPC protobuf wire format for the Cursor API.
//!
//! # D1 Verification
//! This encoder is byte-verified against the Node.js implementation for
//! deterministic inputs. See the `byte_verify` test module at the bottom.

use serde_json::Value;
use uuid::Uuid;
use std::io::Read;

// ==================== CONSTANTS ====================

/// Wire types
const WIRE_VARINT: u8 = 0;
const WIRE_LEN: u8 = 2;
const WIRE_FIXED64: u8 = 1;
const WIRE_FIXED32: u8 = 5;

/// Message roles
const ROLE_USER: u64 = 1;
const ROLE_ASSISTANT: u64 = 2;

/// Unified modes
const UNIFIED_MODE_CHAT: u64 = 1;
const UNIFIED_MODE_AGENT: u64 = 2;

/// Thinking levels
const THINKING_LEVEL_UNSPECIFIED: u64 = 0;
const THINKING_LEVEL_MEDIUM: u64 = 1;
const THINKING_LEVEL_HIGH: u64 = 2;

/// ClientSideToolV2 MCP type
const CLIENT_SIDE_TOOL_V2_MCP: u64 = 19;

// Field numbers — top-level StreamUnifiedChatRequestWithTools / StreamUnifiedChatRequest
const FIELD_REQUEST: u32 = 1;

const FIELD_MESSAGES: u32 = 1;
const FIELD_UNKNOWN_2: u32 = 2;
const FIELD_INSTRUCTION: u32 = 3;
const FIELD_UNKNOWN_4: u32 = 4;
const FIELD_MODEL: u32 = 5;
const FIELD_WEB_TOOL: u32 = 8;
const FIELD_UNKNOWN_13: u32 = 13;
const FIELD_CURSOR_SETTING: u32 = 15;
const FIELD_UNKNOWN_19: u32 = 19;
const FIELD_CONVERSATION_ID: u32 = 23;
const FIELD_METADATA: u32 = 26;
const FIELD_IS_AGENTIC: u32 = 27;
const FIELD_SUPPORTED_TOOLS: u32 = 29;
const FIELD_MESSAGE_IDS: u32 = 30;
const FIELD_MCP_TOOLS: u32 = 34;
const FIELD_LARGE_CONTEXT: u32 = 35;
const FIELD_UNKNOWN_38: u32 = 38;
const FIELD_UNIFIED_MODE: u32 = 46;
const FIELD_UNKNOWN_47: u32 = 47;
const FIELD_SHOULD_DISABLE_TOOLS: u32 = 48;
const FIELD_THINKING_LEVEL: u32 = 49;
const FIELD_UNKNOWN_51: u32 = 51;
const FIELD_UNKNOWN_53: u32 = 53;
const FIELD_UNIFIED_MODE_NAME: u32 = 54;

// ConversationMessage fields
const FIELD_MSG_CONTENT: u32 = 1;
const FIELD_MSG_ROLE: u32 = 2;
const FIELD_MSG_ID: u32 = 13;
const FIELD_MSG_TOOL_RESULTS: u32 = 18;
const FIELD_MSG_IS_AGENTIC: u32 = 29;
const FIELD_MSG_SERVER_BUBBLE_ID: u32 = 32;
const FIELD_MSG_UNIFIED_MODE: u32 = 47;
const FIELD_MSG_SUPPORTED_TOOLS: u32 = 51;

// ConversationMessage.ToolResult fields
const FIELD_TOOL_RESULT_CALL_ID: u32 = 1;
const FIELD_TOOL_RESULT_NAME: u32 = 2;
const FIELD_TOOL_RESULT_INDEX: u32 = 3;
const FIELD_TOOL_RESULT_RAW_ARGS: u32 = 5;
const FIELD_TOOL_RESULT_RESULT: u32 = 8;
const FIELD_TOOL_RESULT_TOOL_CALL: u32 = 11;
const FIELD_TOOL_RESULT_MODEL_CALL_ID: u32 = 12;

// ClientSideToolV2Result fields
const FIELD_CV2R_TOOL: u32 = 1;
const FIELD_CV2R_MCP_RESULT: u32 = 28;
const FIELD_CV2R_CALL_ID: u32 = 35;
const FIELD_CV2R_MODEL_CALL_ID: u32 = 48;
const FIELD_CV2R_TOOL_INDEX: u32 = 49;

// MCPResult fields
const FIELD_MCPR_SELECTED_TOOL: u32 = 1;
const FIELD_MCPR_RESULT: u32 = 2;

// ClientSideToolV2Call fields
const FIELD_CV2C_TOOL: u32 = 1;
const FIELD_CV2C_MCP_PARAMS: u32 = 27;
const FIELD_CV2C_CALL_ID: u32 = 3;
const FIELD_CV2C_NAME: u32 = 9;
const FIELD_CV2C_RAW_ARGS: u32 = 10;
const FIELD_CV2C_TOOL_INDEX: u32 = 48;
const FIELD_CV2C_MODEL_CALL_ID: u32 = 49;

// Model fields
const FIELD_MODEL_NAME: u32 = 1;
const FIELD_MODEL_EMPTY: u32 = 4;

// Instruction fields
const FIELD_INSTRUCTION_TEXT: u32 = 1;

// CursorSetting fields
const FIELD_SETTING_PATH: u32 = 1;
const FIELD_SETTING_UNKNOWN_3: u32 = 3;
const FIELD_SETTING_UNKNOWN_6: u32 = 6;
const FIELD_SETTING_UNKNOWN_8: u32 = 8;
const FIELD_SETTING_UNKNOWN_9: u32 = 9;
const FIELD_SETTING6_FIELD_1: u32 = 1;
const FIELD_SETTING6_FIELD_2: u32 = 2;

// Metadata fields
const FIELD_META_PLATFORM: u32 = 1;
const FIELD_META_ARCH: u32 = 2;
const FIELD_META_VERSION: u32 = 3;
const FIELD_META_CWD: u32 = 4;
const FIELD_META_TIMESTAMP: u32 = 5;

// MessageId fields
const FIELD_MSGID_ID: u32 = 1;
const FIELD_MSGID_SUMMARY: u32 = 2;
const FIELD_MSGID_ROLE: u32 = 3;

// MCPTool fields
const FIELD_MCP_TOOL_NAME: u32 = 1;
const FIELD_MCP_TOOL_DESC: u32 = 2;
const FIELD_MCP_TOOL_PARAMS: u32 = 3;
const FIELD_MCP_TOOL_SERVER: u32 = 4;

// Response fields (StreamUnifiedChatResponseWithTools)
const FIELD_TOOL_CALL: u32 = 1;
const FIELD_RESPONSE: u32 = 2;
const FIELD_TOOL_ID: u32 = 3;
const FIELD_TOOL_NAME: u32 = 9;
const FIELD_TOOL_RAW_ARGS: u32 = 10;
const FIELD_TOOL_IS_LAST: u32 = 11;
#[allow(dead_code)]
const FIELD_TOOL_IS_LAST_ALT: u32 = 15;
const FIELD_TOOL_MCP_PARAMS: u32 = 27;

// MCPParams fields (response)
const FIELD_MCP_TOOLS_LIST: u32 = 1;
const FIELD_MCP_NESTED_NAME: u32 = 1;
const FIELD_MCP_NESTED_PARAMS: u32 = 3;

// StreamUnifiedChatResponse fields
const FIELD_RESPONSE_TEXT: u32 = 1;
const FIELD_THINKING: u32 = 25;
const FIELD_THINKING_TEXT: u32 = 1;

// ==================== PRIMITIVE ENCODING ====================

/// Encode a u64 as a protobuf varint.
///
/// Port of `encodeVarint(value)` from cursorProtobuf.js.
pub fn encode_varint(value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut v = value;
    while v >= 0x80 {
        bytes.push(((v & 0x7F) | 0x80) as u8);
        v >>= 7;
    }
    bytes.push((v & 0x7F) as u8);
    bytes
}

/// Encode a LEN-type field: tag + length varint + data bytes.
///
/// Port of `encodeField(fieldNum, WIRE_TYPE.LEN, value)` from cursorProtobuf.js.
pub fn encode_field_len(field_num: u32, data: &[u8]) -> Vec<u8> {
    let tag = ((field_num << 3) | WIRE_LEN as u32) as u64;
    let mut result = encode_varint(tag);
    result.extend_from_slice(&encode_varint(data.len() as u64));
    result.extend_from_slice(data);
    result
}

/// Encode a LEN-type field from a string.
pub fn encode_field_str(field_num: u32, s: &str) -> Vec<u8> {
    encode_field_len(field_num, s.as_bytes())
}

/// Encode a VARINT-type field: tag + value varint.
///
/// Port of `encodeField(fieldNum, WIRE_TYPE.VARINT, value)` from cursorProtobuf.js.
pub fn encode_field_varint(field_num: u32, val: u64) -> Vec<u8> {
    let tag = ((field_num << 3) | WIRE_VARINT as u32) as u64;
    let mut result = encode_varint(tag);
    result.extend_from_slice(&encode_varint(val));
    result
}

/// Concatenate multiple byte vectors into one.
fn concat(arrays: &[&[u8]]) -> Vec<u8> {
    let total: usize = arrays.iter().map(|a| a.len()).sum();
    let mut result = Vec::with_capacity(total);
    for a in arrays {
        result.extend_from_slice(a);
    }
    result
}

// ==================== MESSAGE ENCODING ====================

/// Format tool name: "toolName" -> "mcp_custom_toolName"
/// Also handles: "mcp__server__tool" -> "mcp_server_tool"
/// Port of `formatToolName(name)` from cursorProtobuf.js.
fn format_tool_name(name: &str) -> String {
    let base = if name.is_empty() { "tool" } else { name };

    if let Some(rest) = base.strip_prefix("mcp__") {
        if let Some(split_idx) = rest.find("__") {
            let server = if split_idx > 0 { &rest[..split_idx] } else { "custom" };
            let tool_name = &rest[split_idx + 2..];
            let tool_name = if tool_name.is_empty() { "tool" } else { tool_name };
            return format!("mcp_{}_{}", server, tool_name);
        }
        let tool_name = if rest.is_empty() { "tool" } else { rest };
        return format!("mcp_custom_{}", tool_name);
    }

    if base.starts_with("mcp_") {
        return base.to_string();
    }
    format!("mcp_custom_{}", base)
}

/// Parse formatted tool name: "mcp_server_tool" -> (server, selected_tool)
/// Port of `parseToolName(formattedName)` from cursorProtobuf.js.
fn parse_tool_name(formatted: &str) -> (String, String) {
    if !formatted.starts_with("mcp_") {
        let selected = if formatted.is_empty() { "tool".to_string() } else { formatted.to_string() };
        return ("custom".to_string(), selected);
    }

    let tail = &formatted[4..]; // skip "mcp_"
    if let Some(split_idx) = tail.find('_') {
        let server = if split_idx > 0 { &tail[..split_idx] } else { "custom" };
        let selected = &tail[split_idx + 1..];
        let selected = if selected.is_empty() { "tool".to_string() } else { selected.to_string() };
        return (server.to_string(), selected);
    }

    let selected = if tail.is_empty() { "tool".to_string() } else { tail.to_string() };
    ("custom".to_string(), selected)
}

/// Parse tool_call_id into (tool_call_id, model_call_id).
/// Cursor uses "\nmc_" delimiter for model_call_id.
/// Port of `parseToolId(id)` from cursorProtobuf.js.
fn parse_tool_id(id: &str) -> (String, Option<String>) {
    let delimiter = "\nmc_";
    if let Some(idx) = id.find(delimiter) {
        let tool_call_id = id[..idx].to_string();
        let model_call_id = id[idx + delimiter.len()..].to_string();
        (tool_call_id, Some(model_call_id))
    } else {
        (id.to_string(), None)
    }
}

/// Encode MCPResult proto: { selected_tool, result }
/// Port of `encodeMcpResult(selectedTool, resultContent)` from cursorProtobuf.js.
fn encode_mcp_result(selected_tool: &str, result_content: &str) -> Vec<u8> {
    concat(&[
        &encode_field_str(FIELD_MCPR_SELECTED_TOOL, selected_tool),
        &encode_field_str(FIELD_MCPR_RESULT, result_content),
    ])
}

/// Encode ClientSideToolV2Result proto.
/// Port of `encodeClientSideToolV2Result(...)` from cursorProtobuf.js.
fn encode_client_side_tool_v2_result(
    tool_call_id: &str,
    model_call_id: Option<&str>,
    selected_tool: &str,
    result_content: &str,
    tool_index: u64,
) -> Vec<u8> {
    let tool_index = if tool_index > 0 { tool_index } else { 1 };
    let mut parts: Vec<Vec<u8>> = vec![
        encode_field_varint(FIELD_CV2R_TOOL, CLIENT_SIDE_TOOL_V2_MCP),
        encode_field_len(FIELD_CV2R_MCP_RESULT, &encode_mcp_result(selected_tool, result_content)),
        encode_field_str(FIELD_CV2R_CALL_ID, tool_call_id),
    ];
    if let Some(mcid) = model_call_id {
        parts.push(encode_field_str(FIELD_CV2R_MODEL_CALL_ID, mcid));
    }
    parts.push(encode_field_varint(FIELD_CV2R_TOOL_INDEX, tool_index));
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Encode MCPParams.Tool nested inside ClientSideToolV2Call.
/// Port of `encodeMcpParamsForCall(toolName, rawArgs, serverName)` from cursorProtobuf.js.
fn encode_mcp_params_for_call(tool_name: &str, raw_args: &str, server_name: &str) -> Vec<u8> {
    let tool = concat(&[
        &encode_field_str(FIELD_MCP_TOOL_NAME, tool_name),
        &encode_field_str(FIELD_MCP_TOOL_PARAMS, raw_args),
        &encode_field_str(FIELD_MCP_TOOL_SERVER, server_name),
    ]);
    encode_field_len(FIELD_MCP_TOOLS_LIST, &tool)
}

/// Encode ClientSideToolV2Call proto.
/// Port of `encodeClientSideToolV2Call(...)` from cursorProtobuf.js.
fn encode_client_side_tool_v2_call(
    tool_call_id: &str,
    tool_name: &str,
    selected_tool: &str,
    server_name: &str,
    raw_args: &str,
    model_call_id: Option<&str>,
    tool_index: u64,
) -> Vec<u8> {
    let tool_index = if tool_index > 0 { tool_index } else { 1 };
    let mut parts: Vec<Vec<u8>> = vec![
        encode_field_varint(FIELD_CV2C_TOOL, CLIENT_SIDE_TOOL_V2_MCP),
        encode_field_len(FIELD_CV2C_MCP_PARAMS, &encode_mcp_params_for_call(selected_tool, raw_args, server_name)),
        encode_field_str(FIELD_CV2C_CALL_ID, tool_call_id),
        encode_field_str(FIELD_CV2C_NAME, tool_name),
        encode_field_str(FIELD_CV2C_RAW_ARGS, raw_args),
        encode_field_varint(FIELD_CV2C_TOOL_INDEX, tool_index),
    ];
    if let Some(mcid) = model_call_id {
        parts.push(encode_field_str(FIELD_CV2C_MODEL_CALL_ID, mcid));
    }
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Tool result for encoding.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub tool_name: String,
    pub tool_call_id: String,
    pub raw_args: String,
    pub result_content: String,
    pub tool_index: Option<u64>,
}

/// Encode ConversationMessage.ToolResult with full structure.
/// Port of `encodeToolResult(toolResult)` from cursorProtobuf.js.
pub fn encode_tool_result(tool_result: &ToolResult) -> Vec<u8> {
    let original_name = if tool_result.tool_name.is_empty() { "" } else { &tool_result.tool_name };
    let tool_name = format_tool_name(original_name);
    let raw_args = if tool_result.raw_args.is_empty() { "{}" } else { &tool_result.raw_args };
    let result_content = if tool_result.result_content.is_empty() { "" } else { &tool_result.result_content };
    let (tool_call_id, model_call_id) = parse_tool_id(&tool_result.tool_call_id);
    let tool_index = tool_result.tool_index.unwrap_or(1);
    let (server_name, selected_tool) = parse_tool_name(&tool_name);

    let mut parts: Vec<Vec<u8>> = vec![
        encode_field_str(FIELD_TOOL_RESULT_CALL_ID, &tool_call_id),
        encode_field_str(FIELD_TOOL_RESULT_NAME, &tool_name),
        encode_field_varint(FIELD_TOOL_RESULT_INDEX, if tool_index > 0 { tool_index } else { 1 }),
    ];
    if let Some(mcid) = &model_call_id {
        parts.push(encode_field_str(FIELD_TOOL_RESULT_MODEL_CALL_ID, mcid));
    }
    parts.push(encode_field_str(FIELD_TOOL_RESULT_RAW_ARGS, raw_args));
    parts.push(encode_field_len(
        FIELD_TOOL_RESULT_RESULT,
        &encode_client_side_tool_v2_result(&tool_call_id, model_call_id.as_deref(), &selected_tool, result_content, tool_index),
    ));
    parts.push(encode_field_len(
        FIELD_TOOL_RESULT_TOOL_CALL,
        &encode_client_side_tool_v2_call(&tool_call_id, &tool_name, &selected_tool, &server_name, raw_args, model_call_id.as_deref(), tool_index),
    ));
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Encode a ConversationMessage.
/// Port of `encodeMessage(content, role, messageId, chatModeEnum, isLast, hasTools, toolResults, serverBubbleId)` from cursorProtobuf.js.
pub fn encode_message(
    content: &str,
    role: u64,
    message_id: &str,
    is_last: bool,
    has_tools: bool,
    tool_results: &[ToolResult],
    server_bubble_id: Option<&str>,
) -> Vec<u8> {
    let _has_tool_results = !tool_results.is_empty();
    let mut parts: Vec<Vec<u8>> = vec![
        encode_field_str(FIELD_MSG_CONTENT, content),
        encode_field_varint(FIELD_MSG_ROLE, role),
        encode_field_str(FIELD_MSG_ID, message_id),
    ];

    if let Some(sbid) = server_bubble_id {
        parts.push(encode_field_str(FIELD_MSG_SERVER_BUBBLE_ID, sbid));
    }

    for tr in tool_results {
        parts.push(encode_field_len(FIELD_MSG_TOOL_RESULTS, &encode_tool_result(tr)));
    }

    parts.push(encode_field_varint(FIELD_MSG_IS_AGENTIC, if has_tools { 1 } else { 0 }));
    parts.push(encode_field_varint(FIELD_MSG_UNIFIED_MODE, if has_tools { UNIFIED_MODE_AGENT } else { UNIFIED_MODE_CHAT }));

    if is_last && has_tools {
        parts.push(encode_field_len(FIELD_MSG_SUPPORTED_TOOLS, &encode_varint(1)));
    }

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Encode an Instruction proto.
/// Port of `encodeInstruction(text)` from cursorProtobuf.js.
pub fn encode_instruction(text: &str) -> Vec<u8> {
    if text.is_empty() {
        Vec::new()
    } else {
        encode_field_str(FIELD_INSTRUCTION_TEXT, text)
    }
}

/// Encode a Model proto.
/// Port of `encodeModel(modelName)` from cursorProtobuf.js.
pub fn encode_model(model_name: &str) -> Vec<u8> {
    concat(&[
        &encode_field_str(FIELD_MODEL_NAME, model_name),
        &encode_field_len(FIELD_MODEL_EMPTY, &[]),
    ])
}

/// Encode a CursorSetting proto.
/// Port of `encodeCursorSetting()` from cursorProtobuf.js.
pub fn encode_cursor_setting() -> Vec<u8> {
    let unknown6 = concat(&[
        &encode_field_len(FIELD_SETTING6_FIELD_1, &[]),
        &encode_field_len(FIELD_SETTING6_FIELD_2, &[]),
    ]);
    concat(&[
        &encode_field_str(FIELD_SETTING_PATH, "cursor\\aisettings"),
        &encode_field_len(FIELD_SETTING_UNKNOWN_3, &[]),
        &encode_field_len(FIELD_SETTING_UNKNOWN_6, &unknown6),
        &encode_field_varint(FIELD_SETTING_UNKNOWN_8, 1),
        &encode_field_varint(FIELD_SETTING_UNKNOWN_9, 1),
    ])
}

/// Encode a Metadata proto.
/// Port of `encodeMetadata()` from cursorProtobuf.js.
///
/// # Deviations from JS
/// - `process.platform` is hardcoded to "linux" (matching the JS default)
/// - `process.arch` is hardcoded to "x64" (matching the JS default)
/// - `process.version` is hardcoded to "v20.0.0"
/// - `process.cwd()` is hardcoded to "/"
/// - Timestamp is the current ISO8601 string (uses chrono since it's available in Cargo.toml)
pub fn encode_metadata() -> Vec<u8> {
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.%.3fZ").to_string();
    concat(&[
        &encode_field_str(FIELD_META_PLATFORM, "linux"),
        &encode_field_str(FIELD_META_ARCH, "x64"),
        &encode_field_str(FIELD_META_VERSION, "v20.0.0"),
        &encode_field_str(FIELD_META_CWD, "/"),
        &encode_field_str(FIELD_META_TIMESTAMP, &timestamp),
    ])
}

/// Encode a MessageId proto.
/// Port of `encodeMessageId(messageId, role, summaryId)` from cursorProtobuf.js.
pub fn encode_message_id(message_id: &str, role: u64, summary_id: Option<&str>) -> Vec<u8> {
    let mut parts: Vec<Vec<u8>> = vec![encode_field_str(FIELD_MSGID_ID, message_id)];
    if let Some(sid) = summary_id {
        parts.push(encode_field_str(FIELD_MSGID_SUMMARY, sid));
    }
    parts.push(encode_field_varint(FIELD_MSGID_ROLE, role));
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Encode an MCPTool proto.
/// Port of `encodeMcpTool(tool)` from cursorProtobuf.js.
pub fn encode_mcp_tool(tool: &Value) -> Vec<u8> {
    let tool_name = tool.get("function")
        .and_then(|f| f.get("name"))
        .or_else(|| tool.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool_desc = tool.get("function")
        .and_then(|f| f.get("description"))
        .or_else(|| tool.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let input_schema = tool.get("function")
        .and_then(|f| f.get("parameters"))
        .or_else(|| tool.get("input_schema"))
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    let mut parts: Vec<Vec<u8>> = Vec::new();
    if !tool_name.is_empty() {
        parts.push(encode_field_str(FIELD_MCP_TOOL_NAME, tool_name));
    }
    if !tool_desc.is_empty() {
        parts.push(encode_field_str(FIELD_MCP_TOOL_DESC, tool_desc));
    }
    if !input_schema.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        let schema_str = serde_json::to_string(&input_schema).unwrap_or_default();
        parts.push(encode_field_str(FIELD_MCP_TOOL_PARAMS, &schema_str));
    }
    parts.push(encode_field_str(FIELD_MCP_TOOL_SERVER, "custom"));
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

// ==================== REQUEST BUILDING ====================

/// Normalized message for encoding.
struct NormalizedMessage {
    role: String,
    content: String,
    tool_results: Vec<ToolResult>,
}

/// Encode the full request.
/// Port of `encodeRequest(messages, modelName, tools, reasoningEffort, forceAgentMode)` from cursorProtobuf.js.
///
/// This is the internal version that accepts injected UUIDs and a fixed timestamp
/// for deterministic testing (D1 verification).
fn encode_request_internal(
    messages: &[Value],
    model_name: &str,
    tools: &[Value],
    reasoning_effort: Option<&str>,
    force_agent_mode: bool,
    uuid_gen: &mut impl FnMut() -> String,
    timestamp: &str,
) -> Vec<u8> {
    let has_tools = tools.len() > 0;
    let is_agentic = has_tools || force_agent_mode;

    // Guardrail: split mixed assistant payload into separate assistant messages
    let mut normalized_messages: Vec<NormalizedMessage> = Vec::new();
    for i in 0..messages.len() {
        let msg = &messages[i];
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let has_tool_calls = msg.get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let has_tool_results = msg.get("tool_results")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);

        if role == "assistant" && has_tool_calls && has_tool_results {
            // Keep assistant tool call message without embedded results
            normalized_messages.push(NormalizedMessage {
                role: role.to_string(),
                content: msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                tool_results: Vec::new(),
            });

            // Check if next message already has matching tool results
            let next_msg = if i + 1 < messages.len() { Some(&messages[i + 1]) } else { None };
            let next_has_tool_results = next_msg
                .and_then(|m| m.get("role"))
                .and_then(|v| v.as_str())
                .map(|r| r == "assistant")
                .unwrap_or(false)
                && next_msg
                    .and_then(|m| m.get("tool_results"))
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);

            // Compare tool_call_ids
            let current_ids: Vec<String> = msg.get("tool_results")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter_map(|tr| tr.get("tool_call_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect())
                .unwrap_or_default();
            let next_ids: Vec<String> = next_msg
                .and_then(|m| m.get("tool_results"))
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter()
                    .filter_map(|tr| tr.get("tool_call_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect())
                .unwrap_or_default();

            let same_ids = !current_ids.is_empty() && current_ids.len() == next_ids.len()
                && current_ids.iter().all(|id| next_ids.contains(id));

            if !(next_has_tool_results && same_ids) {
                // Insert separate assistant tool-result message
                let tool_results: Vec<ToolResult> = msg.get("tool_results")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|tr| {
                        Some(ToolResult {
                            tool_name: tr.get("tool_name").or_else(|| tr.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            tool_call_id: tr.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            raw_args: tr.get("raw_args").and_then(|v| v.as_str()).unwrap_or("{}").to_string(),
                            result_content: tr.get("result_content").or_else(|| tr.get("result")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            tool_index: tr.get("tool_index").or_else(|| tr.get("index")).and_then(|v| v.as_u64()),
                        })
                    }).collect())
                    .unwrap_or_default();
                normalized_messages.push(NormalizedMessage {
                    role: "assistant".to_string(),
                    content: String::new(),
                    tool_results,
                });
            }
            continue;
        }

        let tool_results: Vec<ToolResult> = msg.get("tool_results")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|tr| {
                Some(ToolResult {
                    tool_name: tr.get("tool_name").or_else(|| tr.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    tool_call_id: tr.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    raw_args: tr.get("raw_args").and_then(|v| v.as_str()).unwrap_or("{}").to_string(),
                    result_content: tr.get("result_content").or_else(|| tr.get("result")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    tool_index: tr.get("tool_index").or_else(|| tr.get("index")).and_then(|v| v.as_u64()),
                })
            }).collect())
            .unwrap_or_default();

        normalized_messages.push(NormalizedMessage {
            role: role.to_string(),
            content: msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            tool_results,
        });
    }

    // Prepare messages and collect message IDs
    struct FormattedMessage {
        content: String,
        role: u64,
        message_id: String,
        is_last: bool,
        has_tools: bool,
        tool_results: Vec<ToolResult>,
    }

    let mut formatted_messages: Vec<FormattedMessage> = Vec::new();
    let mut message_ids: Vec<(String, u64)> = Vec::new();

    for (i, msg) in normalized_messages.iter().enumerate() {
        let role = if msg.role == "user" { ROLE_USER } else { ROLE_ASSISTANT };
        let msg_id = uuid_gen();
        let is_last = i == normalized_messages.len() - 1;

        formatted_messages.push(FormattedMessage {
            content: msg.content.clone(),
            role,
            message_id: msg_id.clone(),
            is_last,
            has_tools,
            tool_results: msg.tool_results.clone(),
        });

        message_ids.push((msg_id, role));
    }

    // Map reasoning effort to thinking level
    let thinking_level = match reasoning_effort {
        Some("medium") => THINKING_LEVEL_MEDIUM,
        Some("high") => THINKING_LEVEL_HIGH,
        _ => THINKING_LEVEL_UNSPECIFIED,
    };

    // Build the request — field order must exactly match the JS implementation
    let mut parts: Vec<Vec<u8>> = Vec::new();

    // Messages
    for fm in &formatted_messages {
        parts.push(encode_field_len(
            FIELD_MESSAGES,
            &encode_message(&fm.content, fm.role, &fm.message_id, fm.is_last, fm.has_tools, &fm.tool_results, None),
        ));
    }

    // Static fields
    parts.push(encode_field_varint(FIELD_UNKNOWN_2, 1));
    parts.push(encode_field_len(FIELD_INSTRUCTION, &encode_instruction("")));
    parts.push(encode_field_varint(FIELD_UNKNOWN_4, 1));
    parts.push(encode_field_len(FIELD_MODEL, &encode_model(model_name)));
    parts.push(encode_field_str(FIELD_WEB_TOOL, ""));
    parts.push(encode_field_varint(FIELD_UNKNOWN_13, 1));
    parts.push(encode_field_len(FIELD_CURSOR_SETTING, &encode_cursor_setting()));
    parts.push(encode_field_varint(FIELD_UNKNOWN_19, 1));
    let conversation_id = uuid_gen();
    parts.push(encode_field_str(FIELD_CONVERSATION_ID, &conversation_id));

    // Metadata with provided timestamp
    let metadata = concat(&[
        &encode_field_str(FIELD_META_PLATFORM, "linux"),
        &encode_field_str(FIELD_META_ARCH, "x64"),
        &encode_field_str(FIELD_META_VERSION, "v20.0.0"),
        &encode_field_str(FIELD_META_CWD, "/"),
        &encode_field_str(FIELD_META_TIMESTAMP, timestamp),
    ]);
    parts.push(encode_field_len(FIELD_METADATA, &metadata));

    // Tool-related fields
    parts.push(encode_field_varint(FIELD_IS_AGENTIC, if is_agentic { 1 } else { 0 }));
    if is_agentic {
        parts.push(encode_field_len(FIELD_SUPPORTED_TOOLS, &encode_varint(1)));
    }

    // Message IDs
    for (mid, role) in &message_ids {
        parts.push(encode_field_len(FIELD_MESSAGE_IDS, &encode_message_id(mid, *role, None)));
    }

    // MCP Tools
    for tool in tools {
        parts.push(encode_field_len(FIELD_MCP_TOOLS, &encode_mcp_tool(tool)));
    }

    // Mode fields
    parts.push(encode_field_varint(FIELD_LARGE_CONTEXT, 0));
    parts.push(encode_field_varint(FIELD_UNKNOWN_38, 0));
    parts.push(encode_field_varint(FIELD_UNIFIED_MODE, if is_agentic { UNIFIED_MODE_AGENT } else { UNIFIED_MODE_CHAT }));
    parts.push(encode_field_str(FIELD_UNKNOWN_47, ""));
    parts.push(encode_field_varint(FIELD_SHOULD_DISABLE_TOOLS, if is_agentic { 0 } else { 1 }));
    parts.push(encode_field_varint(FIELD_THINKING_LEVEL, thinking_level));
    parts.push(encode_field_varint(FIELD_UNKNOWN_51, 0));
    parts.push(encode_field_varint(FIELD_UNKNOWN_53, 1));
    parts.push(encode_field_str(FIELD_UNIFIED_MODE_NAME, if is_agentic { "Agent" } else { "Ask" }));

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    concat(&refs)
}

/// Build the chat request (wrap encodeRequest in field 1).
/// Port of `buildChatRequest(...)` from cursorProtobuf.js.
fn build_chat_request(
    messages: &[Value],
    model_name: &str,
    tools: &[Value],
    reasoning_effort: Option<&str>,
    force_agent_mode: bool,
    uuid_gen: &mut impl FnMut() -> String,
    timestamp: &str,
) -> Vec<u8> {
    let inner = encode_request_internal(messages, model_name, tools, reasoning_effort, force_agent_mode, uuid_gen, timestamp);
    encode_field_len(FIELD_REQUEST, &inner)
}

/// Wrap a protobuf payload in a ConnectRPC frame.
///
/// Port of `wrapConnectRPCFrame(payload, compress)` from cursorProtobuf.js.
/// 5-byte header: [flags: 1 byte] [length: 4 bytes big-endian] + payload.
/// compress=false always for Cursor requests, but the flag is supported.
pub fn wrap_connect_rpc_frame(payload: &[u8], compress: bool) -> Vec<u8> {
    if compress {
        // Cursor doesn't compress requests, but support the flag.
        // If compression is needed, use flate2::write::GzEncoder.
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, payload).ok();
        let compressed = encoder.finish().unwrap_or_default();
        let len = compressed.len() as u32;
        let mut frame = Vec::with_capacity(5 + compressed.len());
        frame.push(0x01); // flags = compressed
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(&compressed);
        frame
    } else {
        let len = payload.len() as u32;
        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(0x00); // flags = uncompressed
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(payload);
        frame
    }
}

/// Generate the full Cursor request body (ConnectRPC-framed protobuf).
///
/// Port of `generateCursorBody(messages, modelName, tools, reasoningEffort, forceAgentMode)` from cursorProtobuf.js.
///
/// Uses uuid v4 for message IDs and conversation ID, and current ISO8601 timestamp.
pub fn generate_cursor_body(
    messages: &[Value],
    model_name: &str,
    tools: &[Value],
    reasoning_effort: Option<&str>,
    force_agent_mode: bool,
) -> Vec<u8> {
    let mut uuid_gen = || Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.%.3fZ").to_string();
    let protobuf = build_chat_request(messages, model_name, tools, reasoning_effort, force_agent_mode, &mut uuid_gen, &timestamp);
    wrap_connect_rpc_frame(&protobuf, false)
}

// ==================== PRIMITIVE DECODING ====================

/// Decode a varint from a buffer at the given offset.
/// Returns (value, new_offset).
/// Port of `decodeVarint(buffer, offset)` from cursorProtobuf.js.
pub fn decode_varint(buffer: &[u8], offset: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut pos = offset;

    while pos < buffer.len() {
        let b = buffer[pos];
        result |= ((b & 0x7F) as u64) << shift;
        pos += 1;
        if b & 0x80 == 0 {
            return Some((result, pos));
        }
        shift += 7;
        if shift >= 64 {
            return None; // varint too long
        }
    }
    None
}

/// Decoded field: (field_number, wire_type, value_bytes, new_offset)
pub struct DecodedField {
    pub field_num: u32,
    pub wire_type: u8,
    pub value: Vec<u8>,
    pub new_offset: usize,
}

/// Decode a single field from a buffer at the given offset.
/// Port of `decodeField(buffer, offset)` from cursorProtobuf.js.
pub fn decode_field(buffer: &[u8], offset: usize) -> Option<DecodedField> {
    if offset >= buffer.len() {
        return None;
    }

    let (tag, pos1) = decode_varint(buffer, offset)?;
    let field_num = (tag >> 3) as u32;
    let wire_type = (tag & 0x07) as u8;

    let mut pos = pos1;

    let value = match wire_type {
    WIRE_VARINT => {
            let (v, p) = decode_varint(buffer, pos)?;
            // Store varint value as bytes (length-delimited encoding of the u64)
            pos = p;
            v.to_le_bytes().to_vec() // store as 8 bytes LE (will need special handling)
        }
        WIRE_LEN => {
            let (length, p2) = decode_varint(buffer, pos)?;
            pos = p2;
            let len = length as usize;
            if pos + len > buffer.len() {
                return None;
            }
            let val = buffer[pos..pos + len].to_vec();
            pos += len;
            val
        }
        WIRE_FIXED64 => {
            if pos + 8 > buffer.len() { return None; }
            let val = buffer[pos..pos + 8].to_vec();
            pos += 8;
            val
        }
        WIRE_FIXED32 => {
            if pos + 4 > buffer.len() { return None; }
            let val = buffer[pos..pos + 4].to_vec();
            pos += 4;
            val
        }
        _ => {
            return None;
        }
    };

    Some(DecodedField {
        field_num,
        wire_type,
        value,
        new_offset: pos,
    })
}

/// Decode all fields from a message buffer into a map.
/// Port of `decodeMessage(data)` from cursorProtobuf.js.
/// Returns a map of field_number -> Vec of (wire_type, value_bytes).
pub fn decode_message(data: &[u8]) -> std::collections::HashMap<u32, Vec<(u8, Vec<u8>)>> {
    let mut fields: std::collections::HashMap<u32, Vec<(u8, Vec<u8>)>> = std::collections::HashMap::new();
    let mut pos = 0;

    while pos < data.len() {
        match decode_field(data, pos) {
            Some(df) => {
                fields.entry(df.field_num)
                    .or_insert_with(Vec::new)
                    .push((df.wire_type, df.value));
                pos = df.new_offset;
            }
            None => break,
        }
    }

    fields
}

// ==================== RESPONSE PARSING ====================

/// Parsed ConnectRPC frame: (flags, payload, bytes_consumed).
/// Port of `parseConnectRPCFrame(buffer)` from cursorProtobuf.js.
pub fn parse_connect_rpc_frame(buffer: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if buffer.len() < 5 {
        return None;
    }

    let flags = buffer[0];
    let length = ((buffer[1] as usize) << 24)
        | ((buffer[2] as usize) << 16)
        | ((buffer[3] as usize) << 8)
        | (buffer[4] as usize);

    if buffer.len() < 5 + length {
        return None;
    }

    let payload = &buffer[5..5 + length];

    // Decompress if gzip (flags == 0x01)
    let payload = if flags == 0x01 {
        let mut decoder = flate2::read::GzDecoder::new(payload);
        let mut decompressed = Vec::new();
        match decoder.read_to_end(&mut decompressed) {
            Ok(_) => decompressed,
            Err(_) => return None,
        }
    } else {
        payload.to_vec()
    };

    Some((flags, payload, 5 + length))
}

/// Cursor tool call extracted from response.
#[derive(Debug, Clone)]
pub struct CursorToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub is_last: bool,
}

/// Cursor response extracted from protobuf payload.
#[derive(Debug, Clone, Default)]
pub struct CursorResponse {
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub tool_call: Option<CursorToolCall>,
    pub error: Option<String>,
}

/// Extract a tool call from a tool_call field value.
/// Port of `extractToolCall(toolCallData)` from cursorProtobuf.js.
fn extract_tool_call(tool_call_data: &[u8]) -> Option<CursorToolCall> {
    let tool_call = decode_message(tool_call_data);
    let mut tool_call_id = String::new();
    let mut tool_name = String::new();
    let mut raw_args = String::new();
    let mut is_last = false;

    // Extract tool call ID
    if let Some(entries) = tool_call.get(&FIELD_TOOL_ID) {
        if let Some((_, val)) = entries.first() {
            let full_id = String::from_utf8_lossy(val);
            // Cursor returns multi-line ID, take first line
            tool_call_id = full_id.split('\n').next().unwrap_or("").to_string();
        }
    }

    // Extract tool name
    if let Some(entries) = tool_call.get(&FIELD_TOOL_NAME) {
        if let Some((_, val)) = entries.first() {
            tool_name = String::from_utf8_lossy(val).to_string();
        }
    }

    // Extract is_last flag
    if let Some(entries) = tool_call.get(&FIELD_TOOL_IS_LAST) {
        if let Some((_, val)) = entries.first() {
            // VARINT value stored as LE bytes; decode to u64
            let mut buf = [0u8; 8];
            if val.len() <= 8 {
                buf[..val.len()].copy_from_slice(val);
            }
            is_last = u64::from_le_bytes(buf) != 0;
        }
    }

    // Extract MCP params - nested real tool info
    if let Some(entries) = tool_call.get(&FIELD_TOOL_MCP_PARAMS) {
        if let Some((_, val)) = entries.first() {
            let mcp_params = decode_message(val);
            if let Some(tools_list) = mcp_params.get(&FIELD_MCP_TOOLS_LIST) {
                if let Some((_, tool_val)) = tools_list.first() {
                    let tool = decode_message(tool_val);
                    if let Some(name_entries) = tool.get(&FIELD_MCP_NESTED_NAME) {
                        if let Some((_, nv)) = name_entries.first() {
                            tool_name = String::from_utf8_lossy(nv).to_string();
                        }
                    }
                    if let Some(params_entries) = tool.get(&FIELD_MCP_NESTED_PARAMS) {
                        if let Some((_, pv)) = params_entries.first() {
                            raw_args = String::from_utf8_lossy(pv).to_string();
                        }
                    }
                }
            }
        }
    }

    // Fallback to raw_args
    if raw_args.is_empty() {
        if let Some(entries) = tool_call.get(&FIELD_TOOL_RAW_ARGS) {
            if let Some((_, val)) = entries.first() {
                raw_args = String::from_utf8_lossy(val).to_string();
            }
        }
    }

    if !tool_call_id.is_empty() && !tool_name.is_empty() {
        let arguments = if raw_args.is_empty() { "{}".to_string() } else { raw_args };
        Some(CursorToolCall {
            id: tool_call_id,
            name: tool_name,
            arguments,
            is_last,
        })
    } else {
        None
    }
}

/// Extract text and thinking from a response field value.
/// Port of `extractTextAndThinking(responseData)` from cursorProtobuf.js.
fn extract_text_and_thinking(response_data: &[u8]) -> (Option<String>, Option<String>) {
    let nested = decode_message(response_data);
    let mut text = None;
    let mut thinking = None;

    // Extract text
    if let Some(entries) = nested.get(&FIELD_RESPONSE_TEXT) {
        if let Some((_, val)) = entries.first() {
            text = Some(String::from_utf8_lossy(val).to_string());
        }
    }

    // Extract thinking
    if let Some(entries) = nested.get(&FIELD_THINKING) {
        if let Some((_, val)) = entries.first() {
            let thinking_msg = decode_message(val);
            if let Some(t_entries) = thinking_msg.get(&FIELD_THINKING_TEXT) {
                if let Some((_, tv)) = t_entries.first() {
                    thinking = Some(String::from_utf8_lossy(tv).to_string());
                }
            }
        }
    }

    (text, thinking)
}

/// Extract text, thinking, and tool calls from a response payload.
/// Port of `extractTextFromResponse(payload)` from cursorProtobuf.js.
pub fn extract_text_from_response(payload: &[u8]) -> CursorResponse {
    let fields = decode_message(payload);

    // Field 1: ClientSideToolV2Call
    if let Some(entries) = fields.get(&FIELD_TOOL_CALL) {
        if let Some((_, val)) = entries.first() {
            if let Some(tool_call) = extract_tool_call(val) {
                return CursorResponse {
                    text: None,
                    error: None,
                    tool_call: Some(tool_call),
                    thinking: None,
                };
            }
        }
    }

    // Field 2: StreamUnifiedChatResponse
    if let Some(entries) = fields.get(&FIELD_RESPONSE) {
        if let Some((_, val)) = entries.first() {
            let (text, thinking) = extract_text_and_thinking(val);
            if text.is_some() || thinking.is_some() {
                return CursorResponse {
                    text,
                    error: None,
                    tool_call: None,
                    thinking,
                };
            }
        }
    }

    CursorResponse {
        text: None,
        error: None,
        tool_call: None,
        thinking: None,
    }
}

// ==================== D1 BYTE VERIFICATION ====================

#[cfg(test)]
mod byte_verify {
    use super::*;

    // Deterministic UUIDs matching the Node verification script.
    const FIXED_UUIDS: &[&str] = &[
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000005",
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000007",
        "00000000-0000-4000-8000-000000000008",
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-00000000000a",
    ];
    const FIXED_TIMESTAMP: &str = "2025-01-01T00:00:00.000Z";

    // Expected hex from Node: node scripts/verify_cursor_proto.mjs
    // Input (a): single user message "Hello", model "gpt-4", no tools
    const EXPECTED_HEX_A: &str = "000000011b0a98020a350a0548656c6c6f10016a2430303030303030302d303030302d343030302d383030302d303030303030303030303031e80100f8020110011a0020012a090a056770742d342200420068017a1f0a11637572736f725c616973657474696e67731a0032040a00120040014801980101ba012430303030303030302d303030302d343030302d383030302d303030303030303030303032d201320a056c696e757812037836341a077632302e302e3022012f2a18323032352d30312d30315430303a30303a30302e3030305ad80100f201280a2430303030303030302d303030302d343030302d383030302d3030303030303030303030311801980200b00200f00201fa0200800301880300980300a80301b2030341736b";

    // Input (b): user "Hi" + assistant "Hello!", model "claude-3-5-sonnet", no tools
    const EXPECTED_HEX_B: &str = "00000001870a84030a320a02486910016a2430303030303030302d303030302d343030302d383030302d303030303030303030303031e80100f802010a360a0648656c6c6f2110026a2430303030303030302d303030302d343030302d383030302d303030303030303030303032e80100f8020110011a0020012a150a11636c617564652d332d352d736f6e6e65742200420068017a1f0a11637572736f725c616973657474696e67731a0032040a00120040014801980101ba012430303030303030302d303030302d343030302d383030302d303030303030303030303033d201320a056c696e757812037836341a077632302e302e3022012f2a18323032352d30312d30315430303a30303a30302e3030305ad80100f201280a2430303030303030302d303030302d343030302d383030302d3030303030303030303030311801f201280a2430303030303030302d303030302d343030302d383030302d3030303030303030303030321802980200b00200f00201fa0200800301880300980300a80301b2030341736b";

    fn make_deterministic_uuid_gen() -> impl FnMut() -> String {
        let mut idx = 0usize;
        move || {
            let uuid = FIXED_UUIDS[idx % FIXED_UUIDS.len()].to_string();
            idx += 1;
            uuid
        }
    }

    fn generate_cursor_body_deterministic(
        messages: &[Value],
        model_name: &str,
        tools: &[Value],
        reasoning_effort: Option<&str>,
        force_agent_mode: bool,
    ) -> Vec<u8> {
        let mut uuid_gen = make_deterministic_uuid_gen();
        let protobuf = build_chat_request(messages, model_name, tools, reasoning_effort, force_agent_mode, &mut uuid_gen, FIXED_TIMESTAMP);
        wrap_connect_rpc_frame(&protobuf, false)
    }

    fn to_hex(data: &[u8]) -> String {
        data.iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn test_d1_byte_verify_input_a() {
        let messages = serde_json::json!([
            { "role": "user", "content": "Hello" }
        ]);
        let body = generate_cursor_body_deterministic(&messages.as_array().unwrap(), "gpt-4", &[], None, false);
        let hex = to_hex(&body);
        assert_eq!(hex, EXPECTED_HEX_A, "D1 byte mismatch for input (a):\n  Rust:  {}\n  Node:  {}", hex, EXPECTED_HEX_A);
    }

    #[test]
    fn test_d1_byte_verify_input_b() {
        let messages = serde_json::json!([
            { "role": "user", "content": "Hi" },
            { "role": "assistant", "content": "Hello!" }
        ]);
        let body = generate_cursor_body_deterministic(&messages.as_array().unwrap(), "claude-3-5-sonnet", &[], None, false);
        let hex = to_hex(&body);
        assert_eq!(hex, EXPECTED_HEX_B, "D1 byte mismatch for input (b):\n  Rust:  {}\n  Node:  {}", hex, EXPECTED_HEX_B);
    }

    #[test]
    fn test_varint_encoding() {
        // 0 -> [0x00]
        assert_eq!(encode_varint(0), vec![0x00]);
        // 1 -> [0x01]
        assert_eq!(encode_varint(1), vec![0x01]);
        // 127 -> [0x7F]
        assert_eq!(encode_varint(127), vec![0x7F]);
        // 128 -> [0x80, 0x01]
        assert_eq!(encode_varint(128), vec![0x80, 0x01]);
        // 300 -> [0xAC, 0x02]
        assert_eq!(encode_varint(300), vec![0xAC, 0x02]);
    }

    #[test]
    fn test_varint_roundtrip() {
        for val in [0u64, 1, 127, 128, 255, 256, 300, 16384, 65536, 1000000, u32::MAX as u64, u64::MAX] {
            let encoded = encode_varint(val);
            let (decoded, _) = decode_varint(&encoded, 0).expect("decode failed");
            assert_eq!(decoded, val, "varint roundtrip failed for {}", val);
        }
    }

    #[test]
    fn test_connect_rpc_frame() {
        let payload = b"hello world";
        let framed = wrap_connect_rpc_frame(payload, false);
        assert_eq!(framed[0], 0x00); // flags
        assert_eq!(&framed[1..5], &(payload.len() as u32).to_be_bytes()); // length
        assert_eq!(&framed[5..], payload); // payload
        assert_eq!(framed.len(), 5 + payload.len());
    }

    #[test]
    fn test_parse_connect_rpc_frame() {
        let payload = b"hello world";
        let framed = wrap_connect_rpc_frame(payload, false);
        let result = parse_connect_rpc_frame(&framed);
        assert!(result.is_some());
        let (flags, decoded_payload, consumed) = result.unwrap();
        assert_eq!(flags, 0x00);
        assert_eq!(&decoded_payload, payload);
        assert_eq!(consumed, 5 + payload.len());
    }
}
