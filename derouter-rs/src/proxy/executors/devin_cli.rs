//! Devin CLI executor.
//! Port of open-sse/executors/devin-cli.js.
//!
//! Routes completions through the official Devin CLI binary via the
//! Agent Client Protocol (ACP) JSON-RPC 2.0 over stdio.
//!
//! Protocol flow:
//!   1. Spawn `devin acp` (default agent = full built-in tools: fs/shell/search).
//!   2. Send: initialize → session/new → session/prompt.
//!   3. Receive: session/update notifications (agent_message_chunk = reply text).
//!   4. Emit deltas as OpenAI-compatible SSE chunks.
//!   5. Kill subprocess on agent_stopped or error.
//!
//! Auth: noAuth — the subprocess inherits the parent env and uses credentials
//! stored by `devin auth login`.
//!
//! Binary discovery: CLI_DEVIN_BIN env → PATH lookup → platform installer paths.

use std::process::Stdio;

use axum::http::HeaderMap;
use bytes::Bytes;
use futures::Stream;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::base::{ProviderExecutor, UpstreamResponse};
use crate::db::repos::connections::ProviderConnection;

pub struct DevinCliExecutor;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

/// Resolve the Devin binary path
fn resolve_devin_bin() -> String {
    // 1. Explicit override
    if let Ok(env_bin) = std::env::var("CLI_DEVIN_BIN") {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    // 2. Known installer locations
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = if cfg!(target_os = "windows") {
        vec![
            home.join("AppData").join("Local").join("devin").join("cli").join("bin").join("devin.exe"),
            home.join(".local").join("bin").join("devin.exe"),
            home.join("scoop").join("shims").join("devin.exe"),
            home.join("AppData").join("Local").join("Programs").join("devin").join("devin.exe"),
        ]
    } else {
        vec![
            home.join(".local").join("share").join("devin").join("bin").join("devin"),
            home.join(".devin").join("bin").join("devin"),
            home.join(".local").join("bin").join("devin"),
            std::path::PathBuf::from("/opt/homebrew/bin/devin"),
            std::path::PathBuf::from("/usr/local/bin/devin"),
            std::path::PathBuf::from("/usr/bin/devin"),
        ]
    };
    for candidate in &candidates {
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }

    // 3. Fallback — rely on PATH
    if cfg!(target_os = "windows") {
        "devin.exe".to_string()
    } else {
        "devin".to_string()
    }
}

/// Build JSON-RPC 2.0 message
fn rpc(method: &str, params: serde_json::Value, id: Option<u64>) -> String {
    let mut msg = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    if let Some(id) = id {
        msg["id"] = serde_json::json!(id);
    }
    format!("{}\n", serde_json::to_string(&msg).unwrap_or_default())
}

/// Extract text from message content (string or array of parts)
fn extract_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for p in arr {
            if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    parts.push(t.to_string());
                }
            }
        }
        return parts.join("");
    }
    String::new()
}

/// Build a single prompt text from OpenAI messages (multi-turn → single prompt)
fn build_prompt_text(messages: &[serde_json::Value]) -> String {
    let mut lines = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let mut text = String::new();
        if let Some(content) = m.get("content") {
            if let Some(s) = content.as_str() {
                text = s.to_string();
            } else if let Some(arr) = content.as_array() {
                for p in arr {
                    if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                        text.push_str(p.get("text").and_then(|v| v.as_str()).unwrap_or(""));
                    } else if p.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let input = p.get("input").unwrap_or(&serde_json::Value::Null);
                        text.push_str(&format!("\n[Tool call {} id={}]\n{}\n", name, id, input));
                    } else if p.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                        let id = p.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                        let content = p.get("content").unwrap_or(&serde_json::Value::Null);
                        let c = if let Some(s) = content.as_str() {
                            s.to_string()
                        } else {
                            content.to_string()
                        };
                        text.push_str(&format!("\n[Tool result id={}]\n{}\n", id, c));
                    }
                }
            }
        }
        // OpenAI tool_calls on assistant messages
        if role == "assistant" {
            if let Some(tcs) = m.get("tool_calls").and_then(|v| v.as_array()) {
                let parts: Vec<String> = tcs
                    .iter()
                    .map(|tc| {
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool");
                        let default_args = serde_json::json!({});
                        let args = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .unwrap_or(&default_args);
                        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        format!("[Tool call {} id={}]\n{}", name, id, args)
                    })
                    .collect();
                let joined = parts.join("\n\n");
                if !text.is_empty() {
                    text = format!("{}\n\n{}", text, joined);
                } else {
                    text = joined;
                }
            }
        }
        // OpenAI role=tool messages
        if role == "tool" {
            let content = m.get("content").unwrap_or(&serde_json::Value::Null);
            let c = if let Some(s) = content.as_str() {
                s.to_string()
            } else {
                content.to_string()
            };
            let tcid = m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
            text = format!("[Tool result id={}]\n{}", tcid, c);
        }
        if text.trim().is_empty() {
            continue;
        }
        match role {
            "system" => lines.push(format!("[System]\n{}", text)),
            "assistant" => lines.push(format!("[Assistant]\n{}", text)),
            "tool" => lines.push(format!("[Tool]\n{}", text)),
            _ => lines.push(format!("[User]\n{}", text)),
        }
    }
    if lines.is_empty() {
        "(empty)".to_string()
    } else {
        lines.join("\n\n")
    }
}

/// Extract text from a final ACP session/prompt result object
fn extract_result_text(result: &serde_json::Value) -> String {
    if let Some(s) = result.get("content").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(s) = result.get("text").and_then(|v| v.as_str()) {
        return s.to_string();
    }
    if let Some(msg) = result.get("message") {
        if let Some(s) = msg.get("content").and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    if let Some(msgs) = result.get("messages").and_then(|v| v.as_array()) {
        let texts: Vec<String> = msgs
            .iter()
            .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
            .map(|m| m.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string())
            .collect();
        return texts.join("\n");
    }
    String::new()
}

/// Resolve workspace cwd from client request
fn resolve_workspace_cwd(body: &serde_json::Value) -> String {
    let mut candidates = Vec::new();
    let push = |v: Option<&serde_json::Value>, candidates: &mut Vec<String>| {
        if let Some(s) = v.and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    };
    push(body.get("cwd"), &mut candidates);
    push(body.get("working_directory"), &mut candidates);
    push(body.get("workdir"), &mut candidates);
    push(body.get("workspace"), &mut candidates);
    if let Some(meta) = body.get("metadata") {
        push(meta.get("cwd"), &mut candidates);
        push(meta.get("working_directory"), &mut candidates);
    }

    for c in &candidates {
        let path = std::path::Path::new(c);
        if path.is_absolute() && path.exists() && path.is_dir() {
            return c.to_string();
        }
    }
    std::env::temp_dir().to_string_lossy().to_string()
}

#[async_trait::async_trait]
impl ProviderExecutor for DevinCliExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body).await
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        // Devin CLI is stream-only
        self.execute(conn, body).await
    }
}

impl DevinCliExecutor {
    async fn execute(
        &self,
        _conn: &ProviderConnection,
        body: serde_json::Value,
    ) -> anyhow::Result<UpstreamResponse> {
        let b = &body;
        let messages = b
            .get("messages")
            .and_then(|v| v.as_array())
            .or_else(|| b.get("input").and_then(|v| v.as_array()))
            .cloned()
            .unwrap_or_default();
        let prompt_text = build_prompt_text(&messages);
        let workspace_cwd = resolve_workspace_cwd(b);
        let devin_bin = resolve_devin_bin();
        let model = b
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("swe-1.6")
            .to_string();

        let response_id = format!("chatcmpl-devin-{}", now_ms());
        let created = now_secs();

        // Spawn the devin CLI subprocess
        let agent_type = std::env::var("CLI_DEVIN_AGENT_TYPE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let mut acp_args = vec!["acp".to_string()];
        if let Some(ref at) = agent_type {
            acp_args.push("--agent-type".to_string());
            acp_args.push(at.clone());
        }

        // Build environment — inherit parent env
        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        // Auto-approve tool execution
        env.entry("DEVIN_PERMISSION_MODE".to_string())
            .or_insert_with(|| "bypass".to_string());

        let mut child_cmd = Command::new(&devin_bin);
        child_cmd
            .args(&acp_args)
            .envs(&env)
            .current_dir(&workspace_cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            // Windows may need shell resolution
            // tokio::process::Command doesn't have .shell() — the Node version uses shell:true
            // which spawns via cmd.exe. For now, just try directly.
        }

        let mut child = child_cmd.spawn().map_err(|e| {
            let msg = if e.to_string().contains("os error 2") || e.to_string().contains("not found") {
                format!(
                    "Devin CLI not found: {}. Install via https://cli.devin.ai or set CLI_DEVIN_BIN env var.",
                    devin_bin
                )
            } else {
                format!("Devin CLI spawn error: {}", e)
            };
            anyhow::anyhow!(msg)
        })?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(64);

        // Spawn the ACP state machine
        let prompt_text_clone = prompt_text.clone();
        let model_clone = model.clone();
        let workspace_cwd_clone = workspace_cwd.clone();

        tokio::spawn(async move {
            let mut stdin = stdin;
            let mut stdout_reader = BufReader::new(stdout);
            let mut id_counter: u64 = 1;
            let mut init_done = false;
            let mut session_created = false;
            let mut prompt_sent = false;
            let mut child: Child = child;
            let mut role_emitted = false;
            let mut total_text = String::new();
            let mut finished = false;
            let mut line_buf = String::new();

            // Send initialize
            {
                let id = id_counter;
                id_counter += 1;
                let msg = rpc("initialize", serde_json::json!({
                    "protocolVersion": "0.3",
                    "clientInfo": {"name": "derouter", "version": "1.0"},
                    "capabilities": {},
                }), Some(id));
                let _ = stdin.write_all(msg.as_bytes()).await;
            }

            loop {
                line_buf.clear();
                let n = match stdout_reader.read_line(&mut line_buf).await {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }

                let line = line_buf.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                let msg: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                if finished {
                    break;
                }

                // Initialize response → send session/new
                if !init_done && msg.get("result").is_some() && msg.get("method").is_none() {
                    init_done = true;
                    let id = id_counter;
                    id_counter += 1;
                    let rpc_msg = rpc("session/new", serde_json::json!({
                        "cwd": workspace_cwd_clone,
                        "mcpServers": [],
                        "model": model_clone.clone(),
                    }), Some(id));
                    let _ = stdin.write_all(rpc_msg.as_bytes()).await;
                    continue;
                }

                // session/new response → send session/prompt
                if init_done && !session_created && msg.get("result").is_some() && msg.get("method").is_none() {
                    let res = msg.get("result").unwrap();
                    if let Some(sid) = res.get("sessionId").and_then(|v| v.as_str()) {
                        session_created = true;
                        prompt_sent = true;
                        let id = id_counter;
                        id_counter += 1;
                        let rpc_msg = rpc("session/prompt", serde_json::json!({
                            "sessionId": sid,
                            "prompt": [{"type": "text", "text": prompt_text_clone}],
                        }), Some(id));
                        let _ = stdin.write_all(rpc_msg.as_bytes()).await;
                        continue;
                    } else {
                        let err_chunk = serde_json::json!({
                            "error": {"message": "Devin ACP: session/new returned no sessionId", "type": "devin_cli_error"},
                        });
                        let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk)))).await;
                        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                        finished = true;
                        break;
                    }
                }

                // session/prompt response (final result after streaming)
                if session_created && prompt_sent && msg.get("result").is_some() && msg.get("method").is_none() {
                    if !role_emitted {
                        let res = msg.get("result").unwrap();
                        let content = extract_result_text(res);
                        if !content.is_empty() {
                            // Emit role chunk
                            let role_chunk = serde_json::json!({
                                "id": response_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": &model_clone,
                                "choices": [{
                                    "index": 0,
                                    "delta": {"role": "assistant", "content": ""},
                                    "finish_reason": null,
                                }],
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk)))).await;
                            role_emitted = true;
                            // Emit content
                            total_text.push_str(&content);
                            let content_chunk = serde_json::json!({
                                "id": response_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": &model_clone,
                                "choices": [{
                                    "index": 0,
                                    "delta": {"content": content},
                                    "finish_reason": null,
                                }],
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", content_chunk)))).await;
                        }
                        let stop_reason = res.get("stopReason").and_then(|v| v.as_str()).unwrap_or("");
                        if !stop_reason.is_empty() && stop_reason != "cancelled" {
                            let finish_chunk = serde_json::json!({
                                "id": response_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": &model_clone,
                                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                                "usage": {
                                    "prompt_tokens": (prompt_text_clone.len() / 4) as u64,
                                    "completion_tokens": (total_text.len() / 4) as u64,
                                    "total_tokens": ((prompt_text_clone.len() + total_text.len()) / 4) as u64,
                                },
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", finish_chunk)))).await;
                            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                            finished = true;
                            break;
                        }
                    }
                    continue;
                }

                // Permission requests → auto-approve
                if msg.get("method").and_then(|v| v.as_str()) == Some("session/request_permission") {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                        let options = msg
                            .get("params")
                            .and_then(|p| p.get("options"))
                            .and_then(|v| v.as_array());
                        let allow = options
                            .and_then(|opts| {
                                opts.iter().find(|o| {
                                    o.get("kind")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_lowercase().contains("allow"))
                                        .unwrap_or(false)
                                })
                            })
                            .or_else(|| options.and_then(|opts| opts.first()));
                        if let Some(allow_opt) = allow {
                            let option_id = allow_opt
                                .get("optionId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("allow");
                            let response = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {"outcome": {"outcome": "selected", "optionId": option_id}},
                            });
                            let _ = stdin
                                .write_all(format!("{}\n", response.to_string()).as_bytes())
                                .await;
                        }
                    }
                    continue;
                }

                // Agent stopped notification
                let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                if method == "_cognition.ai/agent_stopped" || method == "$/agent_stopped" {
                    let cause = msg
                        .get("params")
                        .and_then(|p| p.get("cause"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if cause == "error" {
                        let err_text = msg
                            .get("params")
                            .and_then(|p| {
                                p.get("errorMessage")
                                    .or_else(|| p.get("message"))
                                    .or_else(|| p.get("error"))
                            })
                            .and_then(|v| v.as_str())
                            .unwrap_or("Devin agent error")
                            .to_string();
                        let err_chunk = serde_json::json!({
                            "error": {"message": err_text, "type": "devin_cli_error"},
                        });
                        let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk)))).await;
                    }
                    let finish_chunk = serde_json::json!({
                        "id": response_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": &model_clone,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {
                            "prompt_tokens": (prompt_text_clone.len() / 4) as u64,
                            "completion_tokens": (total_text.len() / 4) as u64,
                            "total_tokens": ((prompt_text_clone.len() + total_text.len()) / 4) as u64,
                        },
                    });
                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", finish_chunk)))).await;
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                    finished = true;
                    break;
                }

                // Streaming notifications (session/update)
                if method == "session/update" || method == "$/update" {
                    let params = match msg.get("params") {
                        Some(p) => p,
                        None => continue,
                    };
                    let update = params.get("update").unwrap_or(&serde_json::Value::Null);
                    let type_val = update
                        .get("sessionUpdate")
                        .and_then(|v| v.as_str())
                        .or_else(|| params.get("type").and_then(|v| v.as_str()))
                        .unwrap_or("");

                    let content_field = update
                        .get("content")
                        .filter(|v| !v.is_null())
                        .or_else(|| params.get("content"));
                    let delta_text = if let Some(cf) = content_field {
                        if let Some(s) = cf.as_str() {
                            s.to_string()
                        } else if let Some(t) = cf.get("text").and_then(|v| v.as_str()) {
                            t.to_string()
                        } else {
                            params
                                .get("delta")
                                .and_then(|v| v.as_str())
                                .or_else(|| params.get("text").and_then(|v| v.as_str()))
                                .unwrap_or("")
                                .to_string()
                        }
                    } else {
                        String::new()
                    };

                    match type_val {
                        "agent_message_chunk" | "message_delta" | "text_delta" | "content_delta" => {
                            if !delta_text.is_empty() {
                                if !role_emitted {
                                    let role_chunk = serde_json::json!({
                                        "id": response_id,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": &model_clone,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {"role": "assistant", "content": ""},
                                            "finish_reason": null,
                                        }],
                                    });
                                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", role_chunk)))).await;
                                    role_emitted = true;
                                }
                                total_text.push_str(&delta_text);
                                let content_chunk = serde_json::json!({
                                    "id": response_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": &model_clone,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {"content": delta_text},
                                        "finish_reason": null,
                                    }],
                                });
                                let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", content_chunk)))).await;
                            }
                        }
                        "agent_thought_chunk" => {
                            // Internal reasoning — not surfaced to client
                        }
                        "message_stop" | "stop" | "done" => {
                            let finish_chunk = serde_json::json!({
                                "id": response_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": &model_clone,
                                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                                "usage": {
                                    "prompt_tokens": (prompt_text_clone.len() / 4) as u64,
                                    "completion_tokens": (total_text.len() / 4) as u64,
                                    "total_tokens": ((prompt_text_clone.len() + total_text.len()) / 4) as u64,
                                },
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", finish_chunk)))).await;
                            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                            finished = true;
                            break;
                        }
                        "error" => {
                            let err_text = params
                                .get("message")
                                .or_else(|| params.get("error"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("Devin ACP error")
                                .to_string();
                            let err_chunk = serde_json::json!({
                                "error": {"message": err_text, "type": "devin_cli_error"},
                            });
                            let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk)))).await;
                            let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                            finished = true;
                            break;
                        }
                        _ => {}
                    }
                    continue;
                }

                // Error responses
                if let Some(err) = msg.get("error") {
                    let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                    let message = err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error")
                        .to_string();
                    let err_chunk = serde_json::json!({
                        "error": {"message": format!("Devin ACP error {}: {}", code, message), "type": "devin_cli_error"},
                    });
                    let _ = tx.send(Ok(Bytes::from(format!("data: {}\n\n", err_chunk)))).await;
                    let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
                    finished = true;
                    break;
                }
            }

            // Close stdin → devin will exit
            let _ = stdin.shutdown().await;

            // Kill child if still running
            let _ = child.kill().await;

            // Ensure [DONE] is emitted
            if !finished {
                let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
            }
        });

        // Spawn a stderr reader (just drains it)
        let _stderr_child = tokio::spawn(async move {
            let mut stderr_reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match stderr_reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
            }
        });

        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        let boxed: Box<
            dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin,
        > = Box::new(stream);

        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: boxed,
        })
    }
}
