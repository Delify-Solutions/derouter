// Router-owned ids for Responses API objects the router itself builds (a
// Responses client served by a Chat Completions, Claude or other non-Responses
// upstream).
//
// These used to be derived from the upstream's own id (`resp_<chunk.id>`), which
// handed every client the provider's id (`resp_gen-…` for OpenRouter,
// `resp_msg_bdrk_…` for Bedrock) and through it the provider (spec
// model-privacy). The router never maps a Responses id back to anything:
// `previous_response_id` is dropped before an upstream call and history is
// rebuilt from the `input` items. So a random id is correct for every caller.
// A native Responses → Responses passthrough keeps the upstream's ids.

/** `resp_<32 hex>`: one per response; item ids are derived from it. */
export function newResponseId() {
  return `resp_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}
