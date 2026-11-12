import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import {
  listSupportMessagesSync,
  listSupportThreadsSync,
  markSupportReadSync,
  replyToCustomer,
} from "@/lib/notify/supportChat.js";
import { loadTelegramLinkConfig } from "@/lib/telegram/config.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Admin-only (dashboardGuard: every /api/* outside the public and account prefixes
// needs an admin session).

// GET /api/support/messages — the inbox: one row per account with a conversation.
// GET /api/support/messages?userId=X — that conversation.
// Add `&markRead=1` to mark its customer messages read. Kept separate from the plain
// fetch because the panel polls this endpoint: marking on every poll would keep
// writing the same timestamp every 15 seconds and would hide a message that arrived
// while the admin was not looking at the thread.
export async function GET(request) {
  const db = await getAdapter();
  const config = await loadTelegramLinkConfig();
  const userId = request.nextUrl.searchParams.get("userId");

  if (userId) {
    const marked = request.nextUrl.searchParams.get("markRead") === "1"
      ? markSupportReadSync(db, userId)
      : 0;
    return NextResponse.json(
      {
        configured: config.configured,
        userId,
        messages: listSupportMessagesSync(db, userId),
        markedRead: marked,
      },
      { headers: NO_STORE }
    );
  }

  return NextResponse.json(
    { configured: config.configured, threads: listSupportThreadsSync(db) },
    { headers: NO_STORE }
  );
}

// POST /api/support/messages { userId, text } — answer from the dashboard. The
// message goes to the customer's Telegram chat, exactly like a reply typed in the
// admin chat, so both paths leave the same trail.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const userId = String(body?.userId || "").trim();
  const text = String(body?.text || "").trim();
  if (!userId) return NextResponse.json({ error: "Thiếu tài khoản" }, { status: 400, headers: NO_STORE });
  if (!text) return NextResponse.json({ error: "Nội dung trống" }, { status: 400, headers: NO_STORE });

  const config = await loadTelegramLinkConfig();
  if (!config.botToken) {
    return NextResponse.json({ error: "Chưa cấu hình bot token trong Settings" }, { status: 400, headers: NO_STORE });
  }

  const actor = await getAdminActor(request);
  const { replyToCustomer } = await import("@/lib/notify/supportChat.js");
  // getAdminActor already carries the "admin:" prefix.
  const result = await replyToCustomer({ userId, text, createdBy: actor });
  if (!result.ok) {
    const message =
      result.reason === "not_linked"
        ? "Tài khoản này chưa liên kết Telegram nên không nhận được tin"
        : result.reason === "too_long"
          ? "Nội dung quá dài"
          : "Không gửi được tin qua Telegram";
    return NextResponse.json({ error: message, reason: result.reason }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, messageId: result.messageId }, { status: 201, headers: NO_STORE });
}
