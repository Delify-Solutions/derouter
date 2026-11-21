// Guarded reply texts and the two wire formats a business answer can take
// (spec business-guard "Guarded replies", "Response formats").
//
// A guarded reply is free: it is produced by the pipeline itself, never by the
// model, so it carries zero usage. The category travels in `X-Guard-Category` so a
// client can tell WHY it was blocked without parsing Vietnamese prose.

/** Every guarded reply text for a category. `null` means "the model answers". */
export function guardedReplyText(category, { bot, business }) {
  switch (category) {
    case "sovereignty":
      return `${business.sovereigntyAnswer}\n\nTôi là trợ lý của ${bot.companyName}, bạn cần hỗ trợ gì về sản phẩm hoặc dịch vụ của chúng tôi?`;
    case "political":
    case "injection":
      return business.politicalRefusal;
    case "offtopic":
    case "strict_no_context":
      return bot.refusalMessage;
    default:
      return null;
  }
}

function completionId() {
  return `chatcmpl-biz-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function guardHeaders(category, extra = {}) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    ...extra,
  };
  if (category) headers["X-Guard-Category"] = String(category);
  return headers;
}

/**
 * OpenAI `chat.completion` with the final text.
 *
 * @param {{ text:string, model:string, category?:string, usage?:object, id?:string, created?:number }} args
 */
export function jsonReply({ text, model, category = null, usage = null, id = null, created = null }) {
  const body = {
    id: id ?? completionId(),
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: String(text ?? "") },
        finish_reason: "stop",
      },
    ],
    // A guarded reply never touched a model: zero usage, never a null block.
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: guardHeaders(category, { "Content-Type": "application/json" }),
  });
}

/** Split text into content chunks of at most `size` characters, on word boundaries. */
export function splitForStream(text, size = 40) {
  const value = String(text ?? "");
  const pieces = [];
  let rest = value;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * The OpenAI SSE chunk sequence: role chunk, content chunks, stop chunk, `[DONE]`.
 *
 * @param {{ text:string, model:string, category?:string, usage?:object, id?:string, created?:number }} args
 */
export function sseReply({ text, model, category = null, usage = null, id = null, created = null }) {
  const chunkId = id ?? completionId();
  const createdAt = created ?? Math.floor(Date.now() / 1000);
  const base = { id: chunkId, object: "chat.completion.chunk", created: createdAt, model: model ?? null };
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    ...splitForStream(text).map((piece) => ({
      ...base,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: guardHeaders(category, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }),
  });
}

/** Format a final text in whichever shape the client asked for. */
export function formatReply({ text, model, stream = false, category = null, usage = null }) {
  return stream ? sseReply({ text, model, category, usage }) : jsonReply({ text, model, category, usage });
}

/**
 * Read the final text out of a non-streaming upstream Response the router produced.
 * Returns null when the body is not a completion this pipeline can check.
 *
 * The body is read ONCE and never handed on: a `Response` whose stream was
 * consumed cannot be forwarded, and forwarding it would be exactly the unguarded
 * path the spec forbids.
 */
export async function readCompletionText(response) {
  const raw = await response.text().catch(() => "");
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? null;
  if (typeof content === "string") return { data, text: content };
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
    return { data, text: joined };
  }
  return { data, text: null };
}
