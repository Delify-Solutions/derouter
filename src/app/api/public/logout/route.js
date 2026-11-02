import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearUserCookie, getUserTokenFromRequest, resolveAccountUser } from "@/lib/auth/userSession";
import { revokeSession } from "@/lib/localDb";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  const token = getUserTokenFromRequest(request);
  // Resolved before the session is revoked, so the logout can name its account.
  const session = token ? await resolveAccountUser(request) : null;
  if (session?.userId) await recordActivity(request, { userId: session.userId, action: "logout" });
  if (token) {
    try {
      await revokeSession(token);
    } catch (error) {
      console.error("[public/logout] revoke failed:", error?.message || error);
    }
  }
  const cookieStore = await cookies();
  clearUserCookie(cookieStore);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
