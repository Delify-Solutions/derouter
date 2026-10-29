import { NextResponse } from "next/server";
import { getUserByEmail, normalizeEmail } from "@/lib/localDb";
import { loadAccountSettings, sendResetEmail } from "@/lib/users/register";
import { checkLimits, getClientIp } from "@/lib/auth/actionLimiter.js";

// Always answers the same way: a reset request must not reveal whether the
// address exists.
const OK = { ok: true, message: "If that address has an account, a reset link is on its way" };

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const HOUR_MS = 60 * 60 * 1000;
// Same shape as resend-verification: tight per address, looser per client IP.
const EMAIL_LIMIT = 3;
const IP_LIMIT = 10;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(OK, { headers: NO_STORE });
  }

  const email = normalizeEmail(body?.email);

  // The per-email limit applies whether or not the account exists, so a flood
  // cannot be aimed at an address and a probe cannot learn from the 429 either.
  const limits = [{ bucket: `forgot:ip:${getClientIp(request)}`, limit: IP_LIMIT, windowMs: HOUR_MS }];
  if (email) limits.unshift({ bucket: `forgot:email:${email}`, limit: EMAIL_LIMIT, windowMs: HOUR_MS });

  const gate = checkLimits(limits);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Bạn đã yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  if (!email) return NextResponse.json(OK, { headers: NO_STORE });

  try {
    const user = await getUserByEmail(email);
    if (user) {
      const settings = await loadAccountSettings();
      await sendResetEmail({ user, request, settings });
    }
  } catch (error) {
    console.error("[public/forgot-password] failed:", error?.message || error);
  }

  return NextResponse.json(OK, { headers: NO_STORE });
}
