import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearUserCookie, getUserTokenFromRequest } from "@/lib/auth/userSession";
import { revokeSession } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  const token = getUserTokenFromRequest(request);
  if (token) {
    try {
      await revokeSession(token);
    } catch (error) {
      console.log("[public/logout] revoke failed:", error?.message || error);
    }
  }
  const cookieStore = await cookies();
  clearUserCookie(cookieStore);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
