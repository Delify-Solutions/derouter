import { NextResponse } from "next/server";
import { getUserByEmail, normalizeEmail } from "@/lib/localDb";
import { loadAccountSettings, sendVerificationEmail } from "@/lib/users/register";
import { checkLimits, getClientIp } from "@/lib/auth/actionLimiter.js";

// "Check your email" — one response for every input, so the endpoint cannot be
// used to learn whether an address has an account.
const OK = { ok: true, message: "If the address needs verification, a new link is on its way" };

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const HOUR_MS = 60 * 60 * 1000;
// Per-email is the tight one (it protects the recipient's inbox); per-IP is looser
// because one office or NAT shares an address.
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

  // The per-email bucket is checked for EVERY request that carries an address,
  // whether or not an account exists, so a probe cannot distinguish the two cases
  // by the rate-limit response alone.
  const limits = [{ bucket: `resend:ip:${getClientIp(request)}`, limit: IP_LIMIT, windowMs: HOUR_MS }];
  if (email) limits.unshift({ bucket: `resend:email:${email}`, limit: EMAIL_LIMIT, windowMs: HOUR_MS });

  const gate = checkLimits(limits);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Bạn đã yêu cầu gửi lại quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  if (!email) return NextResponse.json(OK, { headers: NO_STORE });

  try {
    const user = await getUserByEmail(email);
    if (user && user.status === "unverified") {
      const settings = await loadAccountSettings();
      await sendVerificationEmail({ user, request, settings, replace: true });
    }
  } catch (error) {
    console.error("[public/resend-verification] failed:", error?.message || error);
  }

  return NextResponse.json(OK, { headers: NO_STORE });
}
