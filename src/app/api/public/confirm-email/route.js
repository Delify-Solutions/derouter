import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/localDb";
import { siteNameOf } from "@/lib/users/register";
import { sendMail, buildEmailChangeNoticeEmail } from "@/lib/mail/mailer";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { maskEmail } from "@/lib/affiliate/mask.js";
import { fireAndForget, messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";
import { confirmEmailChangeSync } from "@/lib/users/emailChange.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const ERRORS = {
  invalid: { status: 400, error: "Liên kết không hợp lệ hoặc đã hết hạn. Hãy yêu cầu đổi email lại trong trang Tài khoản." },
  taken: { status: 409, error: "Email này vừa được dùng cho một tài khoản khác nên không đổi được. Hãy chọn email khác." },
  no_user: { status: 404, error: "Không tìm thấy tài khoản" },
};

/**
 * POST /api/public/confirm-email — `{ token }` from the link mailed to the new
 * address (spec customer-portal "Change email by confirmation link"). Public: the
 * link may be opened on a device that is not signed in. POST, called by the
 * /confirm-email page, so a mail scanner prefetching the link cannot use it.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(ERRORS.invalid, { status: 400, headers: NO_STORE });
  }
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 200) {
    return NextResponse.json({ error: ERRORS.invalid.error }, { status: 400, headers: NO_STORE });
  }

  const db = await getAdapter();
  let result;
  try {
    result = db.transaction(() => confirmEmailChangeSync(db, token));
  } catch {
    return NextResponse.json({ error: "Không đổi được email" }, { status: 500, headers: NO_STORE });
  }
  if (!result.ok) {
    const failure = ERRORS[result.reason] || ERRORS.invalid;
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: NO_STORE });
  }

  let settings = {};
  try {
    settings = await getSettings();
  } catch {
    settings = {};
  }
  const siteName = siteNameOf(settings);
  fireAndForget(sendMail({ to: result.oldEmail, ...buildEmailChangeNoticeEmail({ newEmail: result.newEmail, stage: "changed", siteName }) }));
  fireAndForget(notifyCustomer(result.userId, "security", messages.emailChanged({ newEmail: result.newEmail })));
  await recordActivity(request, {
    userId: result.userId,
    action: "email_changed",
    details: { from: maskEmail(result.oldEmail), to: maskEmail(result.newEmail) },
  });

  return NextResponse.json({ ok: true, email: result.newEmail }, { headers: NO_STORE });
}
