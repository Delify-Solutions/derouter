import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, canonicalizeUsage, logUsage, pickRecordedUsage, COLORS } from "./usageTracking.js";
import { chunkText, bodyText } from "./chunkText.js";
import { extractUsageFromResponse } from "../handlers/chatCore/requestDetail.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

// Length of the generated text/tool output in one chunk (0 for a bare finish/usage chunk).
function chunkTextLength(parsed) {
  const t = chunkText(parsed);
  return t.content.length + t.thinking.length + t.tool.length;
}

// Retained-copy cap. A live stream keeps accumulatedContent / accumulatedThinking
// / the partial-line `buffer` for logging and usage estimation, so a long
// completion would otherwise pin its whole text in memory per connection. The
// bytes streamed to the client are unaffected — only these copies are capped,
// keeping the head (enough for prompt-echo / early-content heuristics) and the
// tail (enough for finish heuristics and recent content).
const MAX_BUFFER_BYTES = Number(process.env.STREAM_MAX_BUFFER_BYTES || 4 * 1024 * 1024);
const KEEP_HEAD_BYTES = 64 * 1024;

function truncateMiddle(s, maxBytes) {
  if (s.length <= maxBytes) return s;
  // Clamp the head so the result is never longer than maxBytes: a configured cap
  // below KEEP_HEAD_BYTES would otherwise make the tail slice negative and hand
  // back the entire (uncapped) string.
  const headBytes = Math.max(0, Math.min(KEEP_HEAD_BYTES, maxBytes));
  const tailBytes = Math.max(0, maxBytes - headBytes);
  return s.slice(0, headBytes) + (tailBytes > 0 ? s.slice(-tailBytes) : "");
}

// How long a held terminal event (see holdsFinish) waits for the upstream's trailing usage chunk
// before it is released with the best usage known. An upstream that sends no usage, no [DONE] and
// keeps the socket open would otherwise hold it until the 360 s stall timeout and then lose it.
export const FINISH_HOLD_RELEASE_MS = 1500;

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 * @param {boolean} options.compat - legacy compatibility shims on (setting compatNormalization).
 *   Off (default) = strict transparency: in passthrough mode the upstream's SSE lines reach the
 *   client byte for byte, and usage is only OBSERVED on the side.
 * @param {boolean} options.suppressUsageChunk - the router asked the upstream for usage
 *   (stream_options.include_usage) but the client did not: the usage-only chunk is withheld
 *   from the client, so it receives what the upstream would have sent it unprompted.
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    compat = false,
    suppressUsageChunk = false,
    clientFormat = sourceFormat,
    finishHoldMs = FINISH_HOLD_RELEASE_MS
  } = options;

  let buffer = "";
  // What the UPSTREAM reported, merged across chunks and read only from the raw upstream
  // chunks. This alone is recorded and billed. `state.usage` belongs to the translators (they
  // reshape it for the client, e.g. folding cache tokens into prompt_tokens) and is never
  // merged with it: doing so double-counted the cached part of a Claude prompt.
  let upstreamUsage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model }
    : null;

  let totalContentLength = 0;
  // Character classes of everything generated, for the billing estimate (see usageTracking).
  const contentStats = { ascii: 0, wide: 0 };
  let accumulatedContent = "";
  let accumulatedThinking = "";
  // Retained copies are capped (see MAX_BUFFER_BYTES); when a cap trips we record
  // it so the finalized usage object can carry the loss instead of hiding it.
  // These caps only ever bound the LOG copies kept in this closure: the bytes forwarded to
  // the client are enqueued from the chunk itself and the recorded/billed usage comes from
  // upstreamUsage, so neither is affected by truncation.
  let truncated = false;
  let retainedOriginalLength = 0;

  const appendAccumulated = (field, text) => {
    retainedOriginalLength += text.length;
    if (field === "thinking") {
      accumulatedThinking += text;
      if (accumulatedThinking.length > MAX_BUFFER_BYTES) {
        truncated = true;
        accumulatedThinking = truncateMiddle(accumulatedThinking, MAX_BUFFER_BYTES);
      }
      return;
    }
    accumulatedContent += text;
    if (accumulatedContent.length > MAX_BUFFER_BYTES) {
      truncated = true;
      accumulatedContent = truncateMiddle(accumulatedContent, MAX_BUFFER_BYTES);
    }
  };
  const capBuffer = () => {
    if (buffer.length > MAX_BUFFER_BYTES) {
      truncated = true;
      buffer = truncateMiddle(buffer, MAX_BUFFER_BYTES);
    }
  };
  const countGenerated = (text) => {
    totalContentLength += text.length;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) contentStats.ascii++; else contentStats.wide++;
    }
  };

  // Observe one parsed upstream chunk: generated text (for the retained copy and the
  // estimate) and the usage the upstream reported. Never alters the chunk.
  const observeChunk = (parsed) => {
    const t = chunkText(parsed);
    if (t.content) { countGenerated(t.content); appendAccumulated("content", t.content); }
    if (t.thinking) { countGenerated(t.thinking); appendAccumulated("thinking", t.thinking); }
    if (t.tool) countGenerated(t.tool);
    const extracted = extractUsage(parsed);
    if (extracted) upstreamUsage = mergeUsage(upstreamUsage, extracted);
  };

  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;

  // Passthrough bookkeeping
  let doneForwarded = false;      // a [DONE] line already reached the client (one-[DONE] guarantee)
  let swallowBlank = false;       // a data line was withheld: drop the blank line that ended its event
  const finishedChoices = new Set(); // choice indices whose finish_reason chunk already reached the client (n > 1 streams have several)
  let clientSawUsage = false;     // a forwarded chunk carried usage
  // A provider can answer a streamed request with one JSON document instead of SSE (it ignored
  // `stream`, or the client never asked for it). The bytes are forwarded as they came; a
  // bounded copy is read once at the end so the usage in it is still recorded and billed.
  let docMode = null;             // null = undecided, true = JSON document, false = SSE
  let docText = "";
  let docOverflow = false;
  // Translate bookkeeping (OpenAI chat upstream -> another client format)
  let pendingFinish = null;       // finish chunk held back until the trailing usage chunk arrives
  let holdTimer = null;           // releases the held finish if no usage chunk / [DONE] / end arrives
  const clearHoldTimer = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  let earlyUsage = null;          // usage that arrived in a usage-only chunk BEFORE the finish chunk
  let finishReleased = false;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  // `reason` is "complete" for a normal end and "aborted" for a client cancel, an upstream
  // error or a stall (stream.abortFinalize, wired in pipeWithDisconnect).
  const finalizeStream = (reason = "complete") => {
    if (finalized) return;
    finalized = true;
    clearHoldTimer();

    if (docMode === true && !docOverflow && docText) {
      try {
        const doc = JSON.parse(docText);
        const reported = extractUsageFromResponse(doc);
        if (reported) upstreamUsage = mergeUsage(upstreamUsage, canonicalizeUsage(reported));
        const text = bodyText(doc);
        if (text) { countGenerated(text); appendAccumulated("content", text); }
      } catch { /* not a JSON document after all: nothing to observe */ }
    }

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    // 1. what the upstream reported. 2. for providers whose raw chunks extractUsage cannot
    // read (Kiro, CommandCode...) the usage their translator built from them. 3. only when
    // the upstream gave nothing at all and something was actually generated: a flagged
    // estimate (billing only; it was never shown to the client).
    let finalUsage = upstreamUsage;
    if (!hasValidUsage(finalUsage) && !isPassthrough && hasValidUsage(state?.usage)) finalUsage = state.usage;
    finalUsage = pickRecordedUsage({
      real: finalUsage,
      estimate: () => (totalContentLength > 0
        ? estimateUsage(body, contentStats, FORMATS.OPENAI) // internal shape: never sent to a client
        : null),
    }) || finalUsage;

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: reason === "complete" ? "200 OK" : "ABORTED" }).catch(() => { });
    }

    if (onStreamComplete) {
      // Never let the cap silently drop content: the completed usage/meta object
      // carries the truncation marker and the pre-truncation retained length.
      const reportedUsage = truncated
        ? {
            ...(finalUsage && typeof finalUsage === "object" ? finalUsage : {}),
            _truncated: true,
            _originalLength: retainedOriginalLength,
          }
        : finalUsage;
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, reportedUsage, ttftAt);
    }
  };

  // ── Passthrough: same format in and out ───────────────────────────────────
  // Returns the text to forward for one upstream line, or null to withhold it. `eol` is the
  // line terminator that followed it ("" for an unterminated tail at flush).
  //
  // Strict mode (compat off) forwards every line exactly as received. The only lines that are
  // withheld are ones that would not exist had the client talked to the upstream directly:
  //   - the usage-only chunk the router itself asked for when the client did not,
  //   - a second finish chunk repeating one already delivered (a protocol violation some
  //     gateways commit, which gave clients two finish chunks with different usage),
  //   - a second [DONE] (the one-[DONE] guarantee).
  let passthroughTerminal = false;
  const passthroughLine = (line, trimmed, eol) => {
    passthroughTerminal = false;
    if (docMode === null && trimmed) docMode = trimmed[0] === "{" || trimmed[0] === "[";
    if (docMode === true) {
      if (!docOverflow) {
        docText += line + eol;
        if (docText.length > MAX_BUFFER_BYTES) { docOverflow = true; docText = ""; }
      }
      return line + eol;
    }
    if (swallowBlank) {
      swallowBlank = false;
      if (trimmed === "") return null;
    }
    if (!trimmed.startsWith("data:")) return line + eol;

    const withheld = () => { swallowBlank = true; return null; };
    // Legacy normalisation of the data prefix ("data:{...}" -> "data: {...}").
    const framed = (text) => (compat && text.startsWith("data:") && !text.startsWith("data: ") ? "data: " + text.slice(5) : text) + eol;
    const payload = trimmed.slice(5).trim();

    if (payload === "[DONE]") {
      if (doneForwarded) return withheld();
      doneForwarded = true;
      return framed(line);
    }

    let parsed = null;
    try { parsed = JSON.parse(payload); } catch { /* not JSON */ }
    if (!parsed || typeof parsed !== "object") {
      // Compat only: plain-text errors (HTML, rate-limit text) inside an SSE stream used to be
      // dropped because they break downstream JSON decoders. Strict forwards them: the client
      // would have received the same bytes from the upstream directly.
      return compat ? withheld() : line + eol;
    }

    observeChunk(parsed);
    passthroughTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);

    let rewritten = false;
    if (compat) rewritten = normalizeLegacyChunk(parsed);

    if (Array.isArray(parsed.choices)) {
      const hasUsage = hasValidUsage(parsed.usage);
      // The router asked for usage; the client did not.
      if (suppressUsageChunk && parsed.choices.length === 0 && parsed.usage) return withheld();
      const finishing = parsed.choices.filter((c) => c?.finish_reason);
      if (finishing.length > 0) {
        const emptyDelta = !chunkTextLength(parsed);
        const carriesNewUsage = hasUsage && !clientSawUsage && !suppressUsageChunk;
        // A repeat only when every finishing choice here was already finished (per choice index).
        const repeated = finishing.every((c) => finishedChoices.has(c.index ?? 0));
        if (repeated && emptyDelta && !carriesNewUsage) return withheld();
        for (const c of finishing) finishedChoices.add(c.index ?? 0);
      }
      if (hasUsage) clientSawUsage = true;
      // Compat only: drop chunks with nothing in them (legacy hasValuableContent filter).
      if (compat && !hasValuableContent(parsed, FORMATS.OPENAI)) return withheld();
    }

    if (rewritten) return `data: ${JSON.stringify(parsed)}${eol}`;
    return framed(line);
  };

  // Compat only: the legacy per-chunk repairs. Returns true when the chunk was changed.
  const normalizeLegacyChunk = (parsed) => {
    let changed = fixInvalidId(parsed);
    // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
    if (parsed.choices !== undefined) {
      if (!parsed.object) { parsed.object = "chat.completion.chunk"; changed = true; }
      if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); changed = true; }
    }
    // Strip Azure-specific non-standard fields from streaming chunks
    if (parsed.prompt_filter_results !== undefined) {
      delete parsed.prompt_filter_results;
      changed = true;
    }
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice.content_filter_results !== undefined) {
          delete choice.content_filter_results;
          changed = true;
        }
        // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
        // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in every streaming
        // delta; @ai-sdk/openai-compatible checks `delta.tool_calls != null`, so an empty array
        // causes premature `reasoning-end` on every chunk.
        if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
          delete choice.delta.tool_calls;
          changed = true;
        }
      }
    }
    return changed;
  };

  // ── Translate: OpenAI chat upstream -> another client format ──────────────
  // An OpenAI stream reports usage in a chunk AFTER the finish_reason chunk. The target
  // formats need usage inside their terminal event (Anthropic message_delta, Responses
  // response.completed), so the finish chunk is held until the usage chunk, [DONE] or the end
  // of the stream arrives, then translated once with the real usage attached.
  const holdsFinish = mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI && sourceFormat !== FORMATS.OPENAI;

  const stream = new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      // Only the leftover partial line is *retained* between chunks — completed
      // lines are emitted by the loop below. A provider that never terminates a
      // line (no "\n" at all) would otherwise pin the entire response here; past
      // MAX_BUFFER_BYTES there is no SSE event boundary to parse anyway, so the
      // middle is dropped and `truncated` records the loss instead of the process
      // growing without bound.
      buffer = lines.pop() || "";
      capBuffer();

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: forward, observe usage on the side
        if (mode === STREAM_MODE.PASSTHROUGH) {
          const output = passthroughLine(line, trimmed, "\n");
          if (output !== null) {
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (passthroughTerminal) finalizeStream();
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          emitHeldFinish(controller);

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        observeChunk(parsed);

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          // keepNulls: `usage: null` etc. are the upstream's own fields; only compat drops them.
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat, { keepNulls: !compat });
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;

        if (holdsFinish && Array.isArray(parsed.choices)) {
          const finish = parsed.choices[0]?.finish_reason;
          if (pendingFinish) {
            // A chunk after the held finish: usage-only, a repeated finish, or (unexpected) more output.
            if (hasValidUsage(parsed.usage) && !hasValidUsage(pendingFinish.usage)) pendingFinish.usage = parsed.usage;
            if (parsed.choices.length === 0 || finish) {
              if (hasValidUsage(pendingFinish.usage)) emitHeldFinish(controller);
              continue;
            }
            emitHeldFinish(controller);
          } else if (finishReleased && (finish || parsed.choices.length === 0)) {
            continue; // a repeat of the finish chunk, or a trailing usage chunk, after the terminal event
          } else if (!finish && parsed.choices.length === 0) {
            // A usage-only chunk before the finish chunk: keep it for the finish.
            if (hasValidUsage(parsed.usage)) earlyUsage = parsed.usage;
            continue;
          } else if (finish && !hasValidUsage(parsed.usage) && earlyUsage) {
            parsed.usage = earlyUsage;
            finishReleased = true;
          } else if (finish && !hasValidUsage(parsed.usage)) {
            pendingFinish = parsed;
            // Release it on its own if nothing else ever arrives. Idempotent with every other
            // release path: emitHeldFinish clears the timer and ignores an empty slot.
            clearHoldTimer();
            holdTimer = setTimeout(() => {
              holdTimer = null;
              try { emitHeldFinish(controller); } catch { /* the stream already ended */ }
            }, finishHoldMs);
            holdTimer.unref?.();
            continue;
          } else if (finish) {
            finishReleased = true;
          }
        }

        emitTranslated(controller, parsed);
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        // Not capped: this tail is emitted to the client below, so it must survive
        // intact. The string is discarded when flush returns.
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            // An unterminated last line: same rules as any other line, no terminator added.
            const output = passthroughLine(buffer, buffer.trim(), "");
            if (output !== null) {
              reqLogger?.appendConvertedChunk?.(output);
              controller.enqueue(sharedEncoder.encode(output));
            }
          }

          // Compat only: some OpenAI-style clients (e.g. OpenClaw) hang without the closing
          // sentinel when an upstream omits it. Strict mode forwards the stream as the
          // upstream ended it. [DONE] is an OpenAI-chat convention: never added to Anthropic,
          // Responses or Gemini-family streams (Gemini clients reject it with 400).
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          const wantsDone = clientFormat == null || clientFormat === FORMATS.OPENAI;
          if (compat && wantsDone && !doneForwarded && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
            doneForwarded = true;
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same observation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            observeChunk(parsed);
            if (holdsFinish && Array.isArray(parsed.choices) && pendingFinish) {
              if (hasValidUsage(parsed.usage) && !hasValidUsage(pendingFinish.usage)) pendingFinish.usage = parsed.usage;
            } else {
              emitTranslated(controller, parsed);
            }
          }
        }

        emitHeldFinish(controller);

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finalizeStream();
      } catch (error) {
        console.error("Error in flush:", error);
        finalizeStream();
      }
    }
  });

  // A client cancel, an upstream error or a stall never reaches flush(): the pipe calls this so
  // what is known (usage the upstream already reported, else a flagged estimate for output that
  // was delivered) is still recorded. Nothing is invented for a stream that produced nothing.
  stream.abortFinalize = () => finalizeStream("aborted");
  return stream;

  // Hoisted helpers that need `controller` ---------------------------------

  // Translate one parsed upstream chunk into the client format and enqueue it.
  function emitTranslated(controller, parsed) {
    const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

    // Log OpenAI intermediate chunks (if available)
    if (translated?._openaiIntermediate) {
      for (const item of translated._openaiIntermediate) {
        const openaiOutput = formatSSE(item, FORMATS.OPENAI);
        reqLogger?.appendOpenAIChunk?.(openaiOutput);
      }
    }

    if (translated?.length > 0) {
      for (const item of translated) {
        if (item === null || item === undefined) continue;
        // Filter empty chunks the translation produced
        if (!hasValuableContent(item, sourceFormat)) continue;

        // Usage in the translated terminal event is exactly what the translator built from the
        // upstream's own figures. No estimate and no margin is ever added for the client; an
        // Anthropic message_delta without upstream usage carries the zeroed placeholder the
        // translator emits (the protocol requires the field).
        const output = formatSSE(item, sourceFormat);
        reqLogger?.appendConvertedChunk?.(output);
        controller.enqueue(sharedEncoder.encode(output));
        sseEmittedCount++;
      }
    }
  }

  // Release a held finish chunk (with whatever usage arrived) through the translator.
  function emitHeldFinish(controller) {
    clearHoldTimer();
    if (!pendingFinish) return;
    const held = pendingFinish;
    pendingFinish = null;
    finishReleased = true;
    emitTranslated(controller, held);
  }
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, options = {}) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    compat: options.compat === true,
    finishHoldMs: Number.isFinite(options.finishHoldMs) ? options.finishHoldMs : FINISH_HOLD_RELEASE_MS
  });
}

/**
 * Same-format stream: forwards the upstream's lines untouched and observes usage on the side.
 * @param {object} options
 * @param {string} options.clientFormat - the (identical) client/upstream format
 * @param {boolean} options.compat - legacy shims on (setting compatNormalization)
 * @param {boolean} options.suppressUsageChunk - withhold the usage-only chunk the router asked for
 */
export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, options = {}) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    clientFormat: options.clientFormat ?? null,
    compat: options.compat === true,
    suppressUsageChunk: options.suppressUsageChunk === true
  });
}
