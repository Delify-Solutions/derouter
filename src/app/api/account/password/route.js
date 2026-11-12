import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { resolveAccountUser, getUserTokenFromRequest } from "@/lib/auth/userSession";
import {
  getUserById,
  getUserByEmailWithPassword,
  updateUser,
  revokeOtherUserSessions,
} from "@/lib/localDb";
import { validatePassword } from "@/lib/users/register";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { fireAndForget, messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";
import { checkLimits } from "@/lib/auth/actionLimiter.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
// Attempts per account per hour, counted BEFORE the password is checked so
// parallel requests cannot all slip past: a stolen session must not be able to
// brute-force the password (change account-settings, design D3).
const ATTEMPT_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword) {
    return NextResponse.json({ error: "Nhập mật khẩu hiện tại" }, { status: 400, headers: NO_STORE });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400, headers: NO_STORE });
  }

  const user = await getUserByEmailWithPassword(session.email);
  if (!user || user.id !== session.userId) {
    return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });
  }

  const gate = checkLimits([{ bucket: `password-change:${user.id}`, ...ATTEMPT_LIMIT }]);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Bạn đã thử đổi mật khẩu quá nhiều lần. Thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "Mật khẩu hiện tại không đúng" }, { status: 400, headers: NO_STORE });
  }
  if (currentPassword === newPassword) {
    return NextResponse.json({ error: "Mật khẩu mới phải khác mật khẩu hiện tại" }, { status: 400, headers: NO_STORE });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await updateUser(user.id, { passwordHash });

  // Keep the session that made the change, drop every other one: a password
  // change should evict whoever else is holding a copy of the old credential.
  await revokeOtherUserSessions(user.id, getUserTokenFromRequest(request));
  await recordActivity(request, { userId: user.id, action: "password_change" });
  fireAndForget(notifyCustomer(user.id, "security", messages.passwordChanged()));

  const refreshed = await getUserById(user.id);
  return NextResponse.json({ ok: true, user: refreshed ? { id: refreshed.id, email: refreshed.email } : null }, {
    headers: NO_STORE,
  });
}
