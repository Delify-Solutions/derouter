import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp, adminIpBucket } from "@/lib/auth/loginLimiter";
import { verifyAdminCredentials, updateAdminAccount } from "@/lib/auth/adminUsers";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

// The pre-session counterpart to POST /api/auth/change-password: used only for
// the forced "set a new password before reaching any dashboard page" step (spec
// admin-accounts "Forced change on first login"). No cookie exists yet — proving
// the current (temporary) password IS the authentication, exactly like login
// itself, so it shares the same IP lockout bucket.
export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const bucket = adminIpBucket(ip);
    const lock = checkLock(bucket.key);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { username, currentPassword, newPassword } = await request.json();
    const result = await verifyAdminCredentials(username, currentPassword);

    if (result.disabled) {
      recordFail(bucket.key, { maxFails: bucket.maxFails });
      return NextResponse.json({ error: "Tài khoản này đã bị vô hiệu hoá." }, { status: 403 });
    }
    if (!result.ok) {
      recordFail(bucket.key, { maxFails: bucket.maxFails });
      return NextResponse.json({ error: "Sai tên đăng nhập hoặc mật khẩu." }, { status: 401, headers: NO_STORE_HEADERS });
    }
    if (!result.account.mustChangePassword) {
      // This endpoint only exists to satisfy a pending forced reset — an account
      // with nothing pending must go through the normal login + self-service
      // change-password flow instead.
      return NextResponse.json({ error: "Tài khoản này không cần đổi mật khẩu." }, { status: 400 });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json({ error: "Mật khẩu mới tối thiểu 8 ký tự" }, { status: 400 });
    }

    recordSuccess(bucket.key);
    const account = await updateAdminAccount(result.account.id, { newPassword, mustChangePassword: false });

    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request, {
      adminUserId: account.id,
      username: account.username,
      role: account.role,
    });

    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
