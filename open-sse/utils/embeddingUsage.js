/**
 * Which usage an embeddings request records (change hardening-wave1).
 *
 * The upstream's own count wins when it is exact (input tokens only, total equal
 * to input). Several upstreams report nothing usable: the Gemini adapter always
 * answers zeros, and some OpenAI-compatible or self-hosted servers leave out
 * `total_tokens`. Recording nothing served those requests for free, so the
 * fallback is an estimate from the input, flagged `estimated` like a chat
 * estimate.
 */
import { estimateOutputTokens, MEDIA_ITEM_TOKENS } from "./usageTracking.js";

function exactUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.estimated === true) return null;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const totalTokens = raw.total_tokens ?? promptTokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0 || completionTokens !== 0 || totalTokens !== promptTokens) return null;
  return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens };
}

/**
 * Tokens in an embeddings `input`: a string, an array of strings, an array of
 * token ids, or an array of token-id arrays (the OpenAI shapes). A multimodal
 * item (an object with text) counts its text; one without text (an image,
 * audio) counts as one flat media item, as the chat estimate does.
 */
export function estimateEmbeddingInputTokens(input) {
  if (typeof input === "string") return estimateOutputTokens(input);
  if (!Array.isArray(input)) return 0;
  if (input.length > 0 && input.every((v) => Number.isInteger(v))) return input.length;
  let total = 0;
  for (const item of input) {
    if (typeof item === "string") total += estimateOutputTokens(item);
    else if (Array.isArray(item) && item.every((v) => Number.isInteger(v))) total += item.length;
    else if (item && typeof item === "object") {
      total += typeof item.text === "string" ? estimateOutputTokens(item.text) : MEDIA_ITEM_TOKENS;
    }
  }
  return total;
}

/**
 * @param {object|null} raw usage the upstream reported (normalized by the adapter)
 * @param {unknown} input the request's `input`
 * @returns {{ tokens: {prompt_tokens:number, completion_tokens:0, total_tokens:number}, estimated: boolean } | null}
 *          null only when there is nothing to bill (no input text at all)
 */
export function embeddingUsage(raw, input) {
  const exact = exactUsage(raw);
  if (exact) return { tokens: exact, estimated: false };
  const estimate = estimateEmbeddingInputTokens(input);
  if (!(estimate > 0)) return null;
  return { tokens: { prompt_tokens: estimate, completion_tokens: 0, total_tokens: estimate }, estimated: true };
}
