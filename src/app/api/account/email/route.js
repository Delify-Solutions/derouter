import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/localDb";
import { checkLimits } from "@/lib/auth/actionLimiter.js";
import { resolveBaseUrl, siteNameOf } from "@/lib/users/register";
import { sendMail, buildEmailChangeConfirmEmail, buildEmailChangeNoticeEmail } from "@/lib/mail/mailer";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { maskEmail } from "@/lib/affiliate/mask.js";
import { fireAndForget, messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";
import {
  EmailChangeError,
  validateNewEmailSync,
  createEmailChangeSync,
  dropEmailChangeSync,
  pendingEmailChangeSync,
  cancelEmailChangeSync,
} from "@/lib/users/emailChange.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const HOUR_MS = 60 * 60 * 1000;
// Requests and wrong passwords share one budget per account (design D1).
const REQUEST_LIMIT = 5;

function json(body, status = 200, extra = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return {};
  }
}

/** GET /api/account/email — the current address and the pending change, if any. */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, 401);
  const db = await getAdapter();
  return json({ email: session.email, pending: pendingEmailChangeSync(db, session.userId) });
}

/**
 * POST /api/account/email — `{ newEmail, currentPassword }`: mail a confirmation
 * link to the new address (spec customer-portal "Change email by confirmation
 * link"). The address changes only when that link is opened.
 */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) return json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Dữ liệu không hợp lệ" }, 400);
  }
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  if (!currentPassword) return json({ error: "Nhập mật khẩu hiện tại" }, 400);

  const bucket = `email-change:${session.userId}`;
  const gate = checkLimits([{ bucket, limit: REQUEST_LIMIT, windowMs: HOUR_MS }]);
  if (!gate.allowed) {
    return json(
      { error: `Bạn đã thử đổi email quá nhiều lần. Thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      429,
      { "Retry-After": String(gate.retryAfterSec) }
    );
  }

  const db = await getAdapter();
  const row = db.get(`SELECT passwordHash FROM users WHERE id = ?`, [session.userId]);
  if (!row) return json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, 401);
  if (!(await bcrypt.compare(currentPassword, row.passwordHash))) {
    return json({ error: "Mật khẩu hiện tại không đúng" }, 400);
  }

  let issued;
  try {
    issued = db.transaction(() => {
      const newEmail = validateNewEmailSync(db, session.userId, body?.newEmail);
      return createEmailChangeSync(db, session.userId, newEmail);
    });
  } catch (error) {
    if (error instanceof EmailChangeError) return json({ error: error.message, reason: error.reason }, error.status);
    return json({ error: "Không tạo được yêu cầu đổi email" }, 500);
  }

  const settings = await loadSettings();
  const siteName = siteNameOf(settings);
  const base = resolveBaseUrl(request, settings);
  const link = `${base}/confirm-email?token=${encodeURIComponent(issued.token)}`;
  const sent = await sendMail({ to: issued.newEmail, ...buildEmailChangeConfirmEmail({ newEmail: issued.newEmail, link, siteName }) });
  if (!sent.ok) {
    // A link nobody receives must not sit pending (design D1).
    dropEmailChangeSync(db, issued.id);
    console.error(`[account/email] confirmation mail not delivered (${sent.reason}) for user ${session.userId}`);
    return json(
      {
        error: sent.reason === "smtp_not_configured"
          ? "Hệ thống chưa cấu hình gửi email nên chưa đổi email được. Liên hệ hỗ trợ."
          : "Chưa gửi được email xác nhận. Thử lại sau ít phút.",
      },
      503
    );
  }

  // The old address and the linked Telegram learn about the request.
  fireAndForget(sendMail({ to: session.email, ...buildEmailChangeNoticeEmail({ newEmail: issued.newEmail, stage: "requested", siteName }) }));
  fireAndForget(notifyCustomer(session.userId, "security", messages.emailChangeRequested({ newEmail: issued.newEmail })));
  await recordActivity(request, {
    userId: session.userId,
    action: "email_change_requested",
    details: { newEmail: maskEmail(issued.newEmail) },
  });

  return json({ ok: true, pending: { newEmail: issued.newEmail, expiresAt: issued.expiresAt } });
}

/** DELETE /api/account/email — cancel the pending change. */
export async function DELETE(request) {
  const session = await resolveAccountUser(request);
  if (!session) return json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, 401);
  const db = await getAdapter();
  const cancelled = cancelEmailChangeSync(db, session.userId);
  return json({ ok: true, cancelled });
}
