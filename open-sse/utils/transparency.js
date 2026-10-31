/**
 * Providers the operator added as a custom node: their upstream is whatever the operator pointed
 * the node at, so the router has no registry knowledge of what it requires and, in strict mode,
 * forwards the client's body as sent. Built-in registry providers (e.g. the Anthropic OAuth
 * `claude` provider) keep the request shaping their registry entry was written for.
 */
export function isCustomNodeProvider(provider) {
  return typeof provider === "string"
    && (provider.startsWith("openai-compatible-") || provider.startsWith("anthropic-compatible-"));
}
