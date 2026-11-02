import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { checkLimits } from "@/lib/auth/actionLimiter.js";
import { messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const TEST_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

const ERROR_TEXT = {
  blocked: "Telegram chưa cho bot nhắn tin cho bạn. Mở bot, bấm Start (Bắt đầu) rồi gửi thử lại.",
  not_linked: "Tài khoản chưa liên kết Telegram.",
  not_configured: "Hệ thống chưa cấu hình bot Telegram. Vui lòng liên hệ admin.",
};

// POST /api/account/telegram/test — send a test message to the linked Telegram.
// Also the way back after the bot was blocked: a delivered test clears the marker.
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const gate = checkLimits([{ bucket: `telegram-test:user:${session.userId}`, ...TEST_LIMIT }]);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Bạn đã gửi thử quá nhiều lần. Vui lòng thử lại sau." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const result = await notifyCustomer(session.userId, "security", messages.test(), { force: true });
  if (result.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
  return NextResponse.json(
    { error: ERROR_TEXT[result.reason] || "Không gửi được tin nhắn. Thử lại sau.", code: result.reason },
    {
      status: result.reason === "blocked" || result.reason === "not_linked" ? 409 : result.reason === "not_configured" ? 503 : 502,
      headers: NO_STORE,
    }
  );
}
