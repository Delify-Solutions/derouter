import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession, setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { changeOwnPassword } from "@/lib/auth/adminUsers";

// Self-service password change for whichever admin account is signed in (spec
// admin-accounts "Self-service password change") — any account, not only Super
// Admin's existing PATCH /api/settings flow (kept, unchanged, for the Super
// Admin's own default-password path).
export async function POST(request) {
  try {
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (!session?.adminUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword) {
      return NextResponse.json({ error: "Vui lòng nhập mật khẩu hiện tại" }, { status: 400 });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json({ error: "Mật khẩu mới tối thiểu 8 ký tự" }, { status: 400 });
    }

    await changeOwnPassword(session.adminUserId, { currentPassword, newPassword });

    // changeOwnPassword revokes every session for this account (including the
    // current one) via sessionsValidAfter; re-issue a fresh cookie immediately so
    // the caller who just changed their own password is not logged out by it.
    await setDashboardAuthCookie(cookieStore, request, {
      adminUserId: session.adminUserId,
      username: session.username,
      role: session.role,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error?.code === "wrong_password" ? 400 : error?.code === "invalid_password" ? 400 : 500;
    return NextResponse.json({ error: error.message || "Đổi mật khẩu thất bại" }, { status });
  }
}
