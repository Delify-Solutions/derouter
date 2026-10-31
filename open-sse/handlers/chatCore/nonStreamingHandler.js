import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { filterUsageForFormat, claudeUsageFromOpenAI } from "../../utils/usageTracking.js";
import { toOpenAIUsage, responsesUsageFromChat } from "../../translator/concerns/usage.js";
import { createErrorResult } from "../../utils/error.js";
import { applyEstimatedCache } from "../../utils/cacheEstimator.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine, usageOrEstimate } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

// Upper bound for reading a whole (non-streaming) provider body. Without it a
// provider that answers 200 and then trickles bytes forever pins the request
// (and its concurrency slot) indefinitely.
export const DEFAULT_BODY_TIMEOUT_MS = 600000;

/**
 * Settle `pending` no later than `ms`, or as soon as `signal` aborts.
 *
 * `response.json()` / `.text()` (and a stream reader) have no timeout of their
 * own: the connect timer in executors/base.js is cleared once headers arrive,
 * so the body itself was unbounded. Racing the read against a deadline bounds
 * it; `onAbort` releases the underlying body so the socket is not leaked.
 *
 * @param {Promise<any>} pending - In-flight read
 * @param {AbortSignal|null} signal - Combined request/body signal (may be null)
 * @param {number} ms - Read deadline
 * @param {Function|null} onAbort - Cancels the underlying body on abort
 * @returns {Promise<any>}
 */
export async function guardWithTimeout(pending, signal, ms = DEFAULT_BODY_TIMEOUT_MS, onAbort = null) {
  const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_BODY_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  // The loser of the race must not surface as an unhandled rejection.
  pending.catch(() => { });

  if (combined.aborted) {
    try { onAbort?.(); } catch { /* already consumed */ }
    throw combined.reason instanceof Error ? combined.reason : new Error(`upstream body read aborted after ${timeoutMs}ms`);
  }

  let onAbortListener;
  const aborted = new Promise((_, reject) => {
    onAbortListener = () => {
      try { onAbort?.(); } catch { /* already consumed */ }
      const reason = combined.reason;
      reject(reason instanceof Error ? reason : new Error(`upstream body read aborted after ${timeoutMs}ms`));
    };
    combined.addEventListener("abort", onAbortListener, { once: true });
  });

  try {
    return await Promise.race([pending, aborted]);
  } finally {
    combined.removeEventListener("abort", onAbortListener);
  }
}

/**
 * Read a provider Response body with a hard deadline and abort propagation.
 *
 * @param {Response} response - Upstream provider response
 * @param {AbortSignal|null} signal - Combined request/body signal (may be null)
 * @param {number} ms - Body read deadline
 * @param {"text"|"json"} mode - Read mode
 * @returns {Promise<any>} Parsed JSON or body text
 */
export async function readBodyWithTimeout(response, signal, ms = DEFAULT_BODY_TIMEOUT_MS, mode = "text") {
  const pending = mode === "json" ? response.json() : response.text();
  return guardWithTimeout(pending, signal, ms, () => {
    // Release the socket; the pending read() otherwise stays open until the
    // provider finishes (or the process dies).
    response.body?.cancel?.();
  });
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: claudeUsageFromOpenAI(usage),
  };
}

/**
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape. Used when a Responses-format client (e.g. Codex)
 * is routed to a Chat Completions upstream and `stream:false` — the streaming
 * path already emits Responses events, but the JSON path returned a raw
 * `chat.completion` body, so tool_calls were invisible to Responses clients.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  const status = choice.finish_reason === "tool_calls" ? "completed" : (choice.finish_reason === "stop" ? "completed" : (choice.finish_reason || "completed"));

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    background: false,
    error: null,
    output,
    usage: responsesUsageFromChat(usage) || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null, { compat = false } = {}) {
  if (targetFormat === sourceFormat) return responseBody;
  // Provider responded in OpenAI Chat Completions shape but the client speaks
  // Responses API — convert so tool_calls/text surface as Responses `output`.
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return openAICompletionToResponses(responseBody, customToolNames);
  }
  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
    return openAICompletionToClaudeMessage(responseBody);
  }
  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      // promptTokenCount already includes the cached part and excludes thinking tokens, which
      // are output: same mapping as the streaming translator (toOpenAIUsage "gemini").
      result.usage = toOpenAIUsage(usage, "gemini");
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Compat only: stripping markdown code fences (kimi wraps JSON in ```json...```) edits
        // the model's text; strict mode returns it exactly as the upstream produced it.
        const raw = block.text ?? "";
        const text = compat ? raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "") : raw;
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      // Anthropic input_tokens EXCLUDES cache_read/cache_creation; OpenAI prompt_tokens includes
      // them, with the cached part also reported in prompt_tokens_details.
      result.usage = toOpenAIUsage(responseBody.usage, "claude");
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ compat = false, cacheCtx = null, providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, trackDone, appendLog, pxpipe, reqTag, log, requestSignal = null, timeoutMs = DEFAULT_BODY_TIMEOUT_MS }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;
  // The upstream's exact bytes, kept so a same-format reply can be returned untouched.
  let rawText = null;

  if (contentType.includes("text/event-stream")) {
    const sseText = await readBodyWithTimeout(providerResponse, requestSignal, timeoutMs, "text");
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    responseBody = parsed;
  } else {
    try {
      rawText = await readBodyWithTimeout(providerResponse, requestSignal, timeoutMs, "text");
      responseBody = JSON.parse(rawText);
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      // A timeout/abort is not a malformed body — say which it was so the
      // caller (and the usage log) can tell a slow provider from a broken one.
      if (err?.name === "TimeoutError") {
        return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, `Upstream body read timed out after ${timeoutMs}ms from ${provider}`);
      }
      if (err?.name === "AbortError") {
        return createErrorResult(499, "Request aborted");
      }
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  const decloaked = toolNameMap?.size > 0;
  responseBody = decloakToolNames(responseBody, toolNameMap);

  // Same format, strict mode, nothing the router has to rewrite: the client receives the
  // upstream's bytes as they came; the parsed copy is only used to observe usage and for logs.
  const translating = needsTranslation(targetFormat, sourceFormat);
  const passRaw = rawText !== null && !translating && !compat && !decloaked;

  // Recorded/billed usage: the upstream's own figures; a flagged estimate only when it
  // reported none at all (never merged into, or shown in, the client's body).
  // The usage to record. When the combo asked for an estimated cached part, applying it (and
  // remembering the prompt) is a few ms of work on a large prompt, so it runs after the reply is
  // returned (setImmediate) together with the writes that need its result; every write is a
  // fire-and-forget one, so the order does not matter to the client. Without the option nothing
  // is deferred.
  const baseUsage = usageOrEstimate(extractUsageFromResponse(responseBody), body, responseBody);
  let usage = baseUsage;
  const deferUsage = cacheCtx !== null && cacheCtx !== undefined;
  // requestedModel = the original client model string (combo name if bare, no slash).
  // `body.model` here is the rewritten `provider/model` (handleSingleModelChat overrides
  // it before calling handleChatCore), so read the untouched original from clientRawRequest,
  // which handleChat snapshots before any combo expansion.
  const _reqModelRaw = clientRawRequest?.body?.model;
  const requestedModel = _reqModelRaw && typeof _reqModelRaw === "string" && !_reqModelRaw.includes("/") ? _reqModelRaw : null;
  const usageLatencyMs = Date.now() - requestStartTime;
  const recordUsage = () => {
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel, latencyMs: usageLatencyMs, silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: usageLatencyMs } }));
  };
  if (!deferUsage) {
    recordUsage();
  } else {
    // Scheduled right here, before the translation below can throw: a malformed upstream body must
    // never cost the tokens the upstream already consumed (the detail write below is queued after
    // this one, so it sees the usage with the estimated cache applied).
    setImmediate(() => {
      // Nothing here may become an uncaught exception: on any failure record the usage unchanged.
      try { usage = applyEstimatedCache(baseUsage, cacheCtx); } catch { usage = baseUsage; }
      try { recordUsage(); } catch (err) { console.error("[ChatCore] usage record failed:", err?.message); }
    });
  }

  const translatedResponse = translating
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames, { compat })
    : responseBody;
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

  if (!passRaw) {
    // Compat only: some providers return non-standard finish_reason values (e.g. "other")
    // with tool calls; forcing "tool_calls" rewrites a field the upstream chose.
    if (compat && translatedResponse?.choices?.[0]) {
      const choice = translatedResponse.choices[0];
      const msg = choice.message;
      const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCalls && choice.finish_reason !== "tool_calls") {
        choice.finish_reason = "tool_calls";
      }
    }

    // OpenAI-required fields: a translation builds a body that may lack them, so they are
    // filled in; for a same-format reply they are the upstream's to send (compat only).
    if ((translating || compat) && !isClaudeMessageResponse && !isResponsesResponse) {
      if (!translatedResponse.object) translatedResponse.object = "chat.completion";
      if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
    }

    if (compat) {
      // Strip Azure-specific fields
      if (!isClaudeMessageResponse && !isResponsesResponse) {
        delete translatedResponse.prompt_filter_results;
        if (translatedResponse?.choices) {
          for (const choice of translatedResponse.choices) delete choice.content_filter_results;
        }
      }

      // Whitelist the usage fields (drops provider extras such as prompt_cache_hit_tokens).
      // No token is ever added: the legacy +2000 "buffer" is gone.
      if (translatedResponse?.usage) {
        translatedResponse.usage = filterUsageForFormat(translatedResponse.usage, sourceFormat);
      }

      // Strip reasoning_content only when content is non-empty.
      // When content is empty (e.g. thinking models that used all tokens for reasoning),
      // reasoning_content is the only useful output and must be preserved.
      if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
        for (const choice of translatedResponse.choices) {
          if (choice?.message?.reasoning_content && choice.message.content) {
            delete choice.message.reasoning_content;
          }
        }
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  const recordDetail = () => saveRequestDetail(buildRequestDetail({
    provider, model, requestedModel, connectionId, apiKey,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });
  if (deferUsage) {
    setImmediate(() => {
      try { recordDetail(); } catch (err) { console.error("[RequestDetail] Failed to save:", err?.message); }
    });
  } else {
    recordDetail();
  }

  return {
    success: true,
    response: new Response(passRaw ? rawText : JSON.stringify(translatedResponse), {
      headers: { "Content-Type": passRaw ? (contentType || "application/json") : "application/json", "Access-Control-Allow-Origin": "*" }
    })
  };
}
