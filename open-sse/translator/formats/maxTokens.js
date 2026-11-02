import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @param {number} [ceiling=DEFAULT_MAX_TOKENS] - Upper bound for max_tokens.
 *   Callers with model context (e.g. openai-to-claude) pass the model's real
 *   maxOutput so high-output models (Opus 4.8 = 128000) aren't pre-clamped to
 *   the conservative 64000 default before the model-aware step sees them.
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, ceiling = DEFAULT_MAX_TOKENS) {
  let maxTokens = body.max_tokens || DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using the
  // ceiling which could equal budget_tokens when budget_tokens >= ceiling
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  // Never exceed the ceiling
  if (maxTokens > ceiling) maxTokens = ceiling;

  return maxTokens;
}


/**
 * max_tokens for a request converted FROM another format, honouring the client's own limit.
 *
 * The legacy adjustMaxTokens() raises a small limit to 32000 whenever tools are present and
 * caps it at 64000, i.e. it rewrites the output limit the client chose (and the output the
 * upstream may bill). Strict mode (compatNormalization off) forwards the client's value; only
 * Anthropic, which requires the field, gets a default when the client sent none, and a
 * thinking budget still has to leave room (max_tokens > budget_tokens is an API rule).
 *
 * @param {object} body - source body (OpenAI shape: max_tokens / max_completion_tokens)
 * @param {{ compat?: boolean, ceiling?: number, required?: boolean }} opts
 */
export function resolveMaxTokens(body, { compat = false, ceiling = DEFAULT_MAX_TOKENS, required = false } = {}) {
  if (compat) return adjustMaxTokens(body, ceiling);
  let maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens === undefined || maxTokens === null) {
    if (!required) return undefined;
    maxTokens = DEFAULT_MAX_TOKENS;
  }
  if (required && body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }
  return maxTokens;
}
