// Token usage of a Gemini-native response (`generateContent` JSON or the
// `streamGenerateContent` SSE), for requests that bypass the translator path and
// therefore never pass through `chatCore`'s own usage extraction.
//
// Relative imports only: `node --test` loads this module directly.

/**
 * The `usageMetadata` of a Gemini-native body, as `{ prompt_tokens,
 * completion_tokens }` — or null when the body carries none (an error body, a
 * truncated stream). In a stream the LAST usageMetadata is the final tally.
 *
 * @param {string} text the whole response body
 * @returns {{prompt_tokens: number, completion_tokens: number}|null}
 */
export function extractGeminiNativeUsage(text) {
  if (typeof text !== "string" || !text) return null;

  const candidates = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      for (const part of Array.isArray(parsed) ? parsed : [parsed]) candidates.push(part);
    } catch {
      // fall through to the SSE reading below
    }
  }
  if (candidates.length === 0) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        candidates.push(JSON.parse(payload));
      } catch {
        // a partial line: the next chunk of the stream carries the rest
      }
    }
  }

  let usage = null;
  for (const part of candidates) {
    const meta = part?.usageMetadata;
    if (!meta || typeof meta !== "object") continue;
    const prompt = Number(meta.promptTokenCount);
    const total = Number(meta.totalTokenCount);
    // Thinking/audio output is billed as output: everything beyond the prompt.
    const completion = Number.isFinite(total) && Number.isFinite(prompt)
      ? Math.max(0, total - prompt)
      : Number(meta.candidatesTokenCount);
    if (!Number.isSafeInteger(prompt) || prompt < 0) continue;
    if (!Number.isSafeInteger(completion) || completion < 0) continue;
    usage = { prompt_tokens: prompt, completion_tokens: completion };
    // promptTokenCount already includes the cached part; reporting it lets it be priced at the
    // cached rate instead of the full input rate.
    const cached = Number(meta.cachedContentTokenCount);
    if (Number.isSafeInteger(cached) && cached > 0 && cached <= prompt) usage.cached_tokens = cached;
  }
  if (!usage || (usage.prompt_tokens === 0 && usage.completion_tokens === 0)) return null;
  return usage;
}
