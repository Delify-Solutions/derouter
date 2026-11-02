/**
 * Generated text carried by one parsed stream chunk, in any of the wire formats the router
 * reads (OpenAI chat, Anthropic, OpenAI Responses, Gemini). Used only to keep a bounded
 * RETAINED copy for logs and to size the billing estimate when an upstream reports no usage;
 * it never changes what is forwarded.
 *
 * Tool-call names and arguments count as output (they are generated tokens), so a reply that
 * is only a tool call is not mistaken for an empty one.
 *
 * @param {object} chunk - parsed JSON of one SSE data line
 * @returns {{ content: string, thinking: string, tool: string }}
 */
export function chunkText(chunk) {
  const out = { content: "", thinking: "", tool: "" };
  if (!chunk || typeof chunk !== "object") return out;

  // Anthropic
  const d = chunk.delta;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    if (typeof d.text === "string") out.content += d.text;
    if (typeof d.thinking === "string") out.thinking += d.thinking;
    if (typeof d.partial_json === "string") out.tool += d.partial_json;
  }
  if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
    out.tool += String(chunk.content_block.name || "");
  }

  // OpenAI chat: every choice (n > 1 streams carry one choice per chunk, but a chunk may hold several)
  for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;
    if (typeof delta.content === "string") out.content += delta.content;
    if (typeof delta.reasoning_content === "string") out.thinking += delta.reasoning_content;
    else if (typeof delta.reasoning === "string") out.thinking += delta.reasoning;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (typeof tc?.function?.name === "string") out.tool += tc.function.name;
        if (typeof tc?.function?.arguments === "string") out.tool += tc.function.arguments;
      }
    }
  }

  // OpenAI Responses: *.delta events carry the generated string in `delta`.
  if (typeof chunk.type === "string" && chunk.type.startsWith("response.") && typeof chunk.delta === "string") {
    if (chunk.type === "response.output_text.delta") out.content += chunk.delta;
    else if (chunk.type.includes("reasoning")) out.thinking += chunk.delta;
    else if (chunk.type.includes("function_call_arguments") || chunk.type.includes("custom_tool_call")) out.tool += chunk.delta;
  }

  // Gemini (also Antigravity's { response: { candidates } } envelope)
  const parts = (chunk.candidates || chunk.response?.candidates)?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part?.text === "string") {
        if (part.thought === true) out.thinking += part.text; else out.content += part.text;
      }
      if (part?.functionCall) {
        try { out.tool += `${part.functionCall.name || ""}${JSON.stringify(part.functionCall.args || {})}`; } catch { /* skip */ }
      }
    }
  }

  return out;
}

/**
 * All generated text in a complete (non-streamed) response body, in any of the supported
 * wire formats. Used only to size the billing estimate when the upstream reported no usage.
 * @param {object} body - parsed JSON response body
 * @returns {string}
 */
export function bodyText(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const add = (v) => { if (typeof v === "string" && v) parts.push(v); };
  const json = (v) => { try { if (v !== undefined && v !== null) add(typeof v === "string" ? v : JSON.stringify(v)); } catch { /* skip */ } };

  // OpenAI chat
  for (const choice of Array.isArray(body.choices) ? body.choices : []) {
    const m = choice?.message || {};
    if (typeof m.content === "string") add(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) add(p?.text);
    add(m.reasoning_content);
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) { add(tc?.function?.name); json(tc?.function?.arguments); }
    add(choice?.text);
  }
  // Anthropic
  if (Array.isArray(body.content)) {
    for (const b of body.content) {
      add(b?.text); add(b?.thinking);
      if (b?.type === "tool_use") { add(b.name); json(b.input); }
    }
  }
  // OpenAI Responses
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      for (const c of Array.isArray(item?.content) ? item.content : []) add(c?.text);
      for (const s of Array.isArray(item?.summary) ? item.summary : []) add(s?.text);
      if (item?.type === "function_call") { add(item.name); json(item.arguments); }
    }
  }
  // Gemini
  const cands = body.candidates || body.response?.candidates;
  for (const cand of Array.isArray(cands) ? cands : []) {
    for (const p of cand?.content?.parts || []) {
      add(p?.text);
      if (p?.functionCall) { add(p.functionCall.name); json(p.functionCall.args); }
    }
  }
  return parts.join("");
}
