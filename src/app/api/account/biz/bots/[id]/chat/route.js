import { NextResponse } from "next/server";
import { ensureBotChatKey } from "@/lib/account/chatKey";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { badRequest, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";

export const dynamic = "force-dynamic";

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const MAX_MESSAGES = 40;

/** Only the fields the playground sends; everything else a client invents is dropped. */
function chatPayload(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages
        .filter((message) => message && typeof message === "object")
        .slice(-MAX_MESSAGES)
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: typeof message.content === "string" ? message.content : "",
        }))
        .filter((message) => message.content.trim())
    : null;
  if (!messages?.length) return null;
  return { messages, stream: false };
}

/**
 * POST /api/account/biz/bots/[id]/chat — the playground.
 *
 * The conversation goes through the same pipeline as the public API, using a
 * per-bot key named "Chat thử": charges, admission, rate limits and every guard
 * rule therefore apply exactly as they do for a real client.
 */
export async function POST(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const payload = chatPayload(body ?? {});
  if (!payload) return badRequest("Cần nhập tin nhắn");
  // The playground can only ever call the bot's own business model.
  payload.model = scope.bot.modelId;

  let secret;
  try {
    secret = await ensureBotChatKey(scope.session.userId, id);
  } catch {
    return NextResponse.json({ error: "Không chuẩn bị được key cho chat thử" }, { status: 500, headers: NO_STORE });
  }
  if (!secret) {
    return NextResponse.json({ error: "Chat thử đang bị tắt cho bot này" }, { status: 403, headers: NO_STORE });
  }

  const inner = new Request(new URL("/v1/chat/completions", request.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      // Carry the custom server's client-IP stamp so the usage row records the
      // customer's IP like any other request (spec activity-ip-log).
      ...Object.fromEntries(
        ["x-dr-real-ip", "x-dr-peer-token"]
          .map((name) => [name, request.headers.get(name)])
          .filter(([, value]) => value)
      ),
    },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  await ensureInitialized();
  const response = await handleChat(inner);

  // The guard category travels on the header; the console shows "Đã chặn: …".
  const headers = { ...NO_STORE };
  const category = response.headers.get("X-Guard-Category");
  if (category) headers["X-Guard-Category"] = category;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json().catch(() => null);
    return NextResponse.json(data ?? { error: "Không có phản hồi" }, {
      status: response.status,
      headers,
    });
  }
  // SSE from the pipeline (the payload asks for JSON, so this is a pass-through of
  // an upstream error body).
  return new Response(await response.text(), { status: response.status, headers });
}
