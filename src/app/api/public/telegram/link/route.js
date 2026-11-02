import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { checkLimits, getClientIp } from "@/lib/auth/actionLimiter.js";
import { verifyInitData } from "@/lib/telegram/initData.js";
import { consumeLinkTokenSync, LINK_ERROR_TEXT, maskEmail } from "@/lib/db/repos/telegramLinkRepo.js";
import { loadTelegramLinkConfig, NOT_CONFIGURED_TEXT } from "@/lib/telegram/config.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const LINK_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

const STATUS = { invalid_token: 400, telegram_taken: 409, user_not_found: 400 };

function fail(message, status) {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

// POST /api/public/telegram/link { initData } — called by the Mini App page
// inside Telegram, which has no session cookie. Telegram's signature over
// initData (user + start_param token) is the authentication.
export async function POST(request) {
  const gate = checkLimits([{ bucket: `telegram-link:ip:${getClientIp(request)}`, ...LINK_LIMIT }]);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Thử quá nhiều lần. Vui lòng thử lại sau." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const config = await loadTelegramLinkConfig();
  if (!config.configured) return fail(NOT_CONFIGURED_TEXT, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Dữ liệu không hợp lệ", 400);
  }

  const verified = verifyInitData(body?.initData, config.botToken);
  if (!verified.ok) {
    return fail(
      verified.reason === "expired"
        ? "Phiên Telegram đã cũ. Hãy tạo link mới trên trang web."
        : "Không xác thực được dữ liệu từ Telegram. Hãy mở link từ trang web.",
      400
    );
  }
  if (!verified.startParam) return fail(LINK_ERROR_TEXT.invalid_token, 400);

  const db = await getAdapter();
  let result;
  try {
    result = db.transaction(() => consumeLinkTokenSync(db, verified.startParam, verified.user));
  } catch (error) {
    // The partial unique index on users.telegramUserId is the last line of defence.
    if (/UNIQUE/i.test(String(error?.message || ""))) return fail(LINK_ERROR_TEXT.telegram_taken, 409);
    console.error("[telegram/link] link failed:", error?.message || "unknown error");
    return fail("Không liên kết được. Vui lòng thử lại.", 500);
  }
  if (!result.ok) return fail(LINK_ERROR_TEXT[result.reason] || LINK_ERROR_TEXT.invalid_token, STATUS[result.reason] || 400);

  // The request comes from Telegram's in-app browser: its IP is the customer's
  // phone, which is worth keeping next to their web IPs.
  await recordActivity(request, {
    userId: result.userId,
    action: "telegram_link",
    details: { telegramUserId: verified.user.id, telegramUsername: verified.user.username },
  });
  return NextResponse.json(
    { ok: true, email: maskEmail(result.email), telegramUsername: verified.user.username },
    { headers: NO_STORE }
  );
}
