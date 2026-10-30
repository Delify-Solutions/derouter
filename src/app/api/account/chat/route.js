import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { ensureChatKey } from "@/lib/account/chatKey";
import { handleChat } from "@/sse/handlers/chat.js";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";
import { initTranslators } from "open-sse/translator/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const MAX_IMAGES = 4;
const MAX_MESSAGES = 100;

function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
}

/** Only the fields the chat page sends; everything else a client invents is dropped. */
function chatPayload(body) {
  const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : null;
  if (!body.model || !messages?.length) return null;
  const payload = { model: String(body.model), messages, stream: body.stream !== false };
  if (Number.isFinite(Number(body.temperature))) payload.temperature = Number(body.temperature);
  if (Number.isInteger(body.max_tokens) && body.max_tokens > 0) payload.max_tokens = body.max_tokens;
  return payload;
}

function imagePayload(body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!body.model || !prompt) return null;
  const payload = { model: String(body.model), prompt };
  if (typeof body.size === "string" && /^\d{2,5}x\d{2,5}$/.test(body.size)) payload.size = body.size;
  const n = Math.floor(Number(body.n));
  if (Number.isFinite(n) && n > 0) payload.n = Math.min(n, MAX_IMAGES);
  if (Number.isInteger(body.seed)) payload.seed = body.seed;
  if (Number.isInteger(body.num_inference_steps) && body.num_inference_steps > 0) {
    payload.num_inference_steps = body.num_inference_steps;
  }
  if (Array.isArray(body.condition_images)) {
    const urls = body.condition_images.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, 4);
    if (urls.length) payload.condition_images = urls;
  }
  if (body.response_format === "url" || body.response_format === "b64_json") {
    payload.response_format = body.response_format;
  }
  return payload;
}

/**
 * POST /api/account/chat — the customer's web chat.
 * `{ type: "chat", model, messages, stream? }` or `{ type: "image", model, prompt, ... }`.
 *
 * Forwards to the same handlers `/v1/chat/completions` and `/v1/images/generations`
 * use, authenticated with the customer's own key, so every rule and charge of the
 * public API applies. The upstream Response (JSON or SSE) is returned untouched.
 */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const isImage = body?.type === "image";
  const payload = isImage ? imagePayload(body || {}) : chatPayload(body || {});
  if (!payload) return badRequest(isImage ? "Cần chọn model và nhập mô tả ảnh" : "Cần chọn model và nhập tin nhắn");

  let secret;
  try {
    secret = await ensureChatKey(session.userId);
  } catch {
    return NextResponse.json({ error: "Không chuẩn bị được key cho chat" }, { status: 500, headers: NO_STORE });
  }
  if (!secret) {
    return NextResponse.json({ error: "Chat đang bị tắt cho tài khoản này" }, { status: 403, headers: NO_STORE });
  }

  const path = isImage ? "/v1/images/generations" : "/v1/chat/completions";
  const inner = new Request(new URL(path, request.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  await ensureInitialized();
  return isImage ? handleImageGeneration(inner) : handleChat(inner);
}
