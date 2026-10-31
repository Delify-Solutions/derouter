// OpenAI -> Gemini response conversion for the /v1beta route. Kept out of the route file (a Next
// route may only export HTTP handlers) and free of app imports so `node --test` can load it.

// How long the Gemini terminal chunk waits for the upstream's trailing usage chunk (ms).
export const GEMINI_FINISH_HOLD_MS = 1500;

/** Map OpenAI finish_reason => Gemini finishReason */
export const FINISH_REASON_MAP = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  content_filter: "SAFETY",
};

/**
 * Gemini usageMetadata from an OpenAI usage object. Gemini reports thinking tokens apart from
 * the candidates (candidatesTokenCount excludes them); OpenAI's completion_tokens includes
 * reasoning, so the reasoning part is moved to thoughtsTokenCount rather than counted twice.
 * promptTokenCount includes the cached part, which cachedContentTokenCount repeats.
 */
export function geminiUsageFromOpenAI(usage) {
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const reasoning = Math.min(usage.completion_tokens_details?.reasoning_tokens || 0, completion);
  const meta = {
    promptTokenCount: prompt,
    candidatesTokenCount: completion - reasoning,
    totalTokenCount: usage.total_tokens || prompt + completion,
  };
  if (reasoning > 0) meta.thoughtsTokenCount = reasoning;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  if (cached > 0) meta.cachedContentTokenCount = cached;
  return meta;
}

/**
 * Transform an OpenAI SSE stream into a Gemini SSE stream.
 *
 * OpenAI SSE format (what handleChat returns):
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Gemini SSE format (what @google/genai SDK expects):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"index":0}]}
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
 *   (stream closes — no [DONE])
 */
export function transformOpenAISSEToGeminiSSE(upstreamResponse, model, { holdMs = GEMINI_FINISH_HOLD_MS } = {}) {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // The Gemini terminal chunk carries usageMetadata, but an OpenAI stream reports usage in a
  // chunk AFTER the finish chunk. The finish chunk is held until that usage chunk (or the end
  // of the stream) so the client sees the upstream's real figures, never an estimate.
  let pendingFinish = null;
  let finishSent = false;
  let carry = "";
  let holdTimer = null;
  const sendChunk = (controller, geminiChunk) => {
    controller.enqueue(encoder.encode("data: " + JSON.stringify(geminiChunk) + "\r\n\r\n"));
  };
  // Send the held finish chunk (with whatever usage arrived). Idempotent: every release path
  // (usage chunk, end of stream, the hold timer) goes through here.
  const releaseFinish = (controller) => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!pendingFinish) return;
    sendChunk(controller, pendingFinish);
    pendingFinish = null;
    finishSent = true;
  };

  const handleLine = (line, controller) => {
    if (!line.startsWith("data:")) return;

    const data = line.slice(5).trim();

    // Drop empty lines and the OpenAI [DONE] sentinel.
    // Gemini SSE ends by stream close, no sentinel needed.
    if (!data || data === "[DONE]") return;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      // The usage-only chunk: complete the held finish chunk with it.
      if (parsed.usage && pendingFinish) {
        pendingFinish.usageMetadata = geminiUsageFromOpenAI(parsed.usage);
        releaseFinish(controller);
      }
      return;
    }
    // A finish chunk repeated by the upstream is not forwarded a second time.
    if (choice.finish_reason && (pendingFinish || finishSent)) return;

    const delta = choice.delta || {};

    const parts = [];
    if (delta.reasoning_content) {
      parts.push({ text: delta.reasoning_content, thought: true });
    }
    if (delta.content) {
      parts.push({ text: delta.content });
    }

    // Skip pure role-only deltas with no content and no finish signal
    if (parts.length === 0 && !choice.finish_reason) return;

    const candidate = {
      content: {
        role: "model",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      },
      index: 0,
    };

    if (choice.finish_reason) {
      candidate.finishReason = FINISH_REASON_MAP[choice.finish_reason] || "STOP";
    }

    const geminiChunk = { candidates: [candidate] };

    // Attach usage + modelVersion on the final chunk (when finish_reason is set)
    if (choice.finish_reason) {
      geminiChunk.modelVersion = parsed.model || model;
      if (parsed.usage) {
        geminiChunk.usageMetadata = geminiUsageFromOpenAI(parsed.usage);
        finishSent = true;
      } else {
        pendingFinish = geminiChunk;
        // An upstream that sends no usage and keeps the socket open must not hold the
        // terminal chunk until the stall timeout: release it without usage after a short wait.
        holdTimer = setTimeout(() => {
          holdTimer = null;
          try { releaseFinish(controller); } catch { /* stream already closed */ }
        }, holdMs);
        holdTimer.unref?.();
        return;
      }
    }

    sendChunk(controller, geminiChunk);
  };

  const transformStream = new TransformStream({
    flush(controller) {
      // A final data line that arrived without its trailing newline is still a line.
      const rest = carry + decoder.decode();
      carry = "";
      if (rest) handleLine(rest, controller);
      releaseFinish(controller);
    },
    transform(chunk, controller) {
      // A network chunk can end in the middle of a line: keep the partial line for the next one
      // (it used to be parsed on its own and silently dropped, losing text from the reply).
      const text = carry + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) handleLine(line, controller);
    },
  });

  return new Response(upstreamResponse.body.pipeThrough(transformStream), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
