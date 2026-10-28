import { NextResponse } from "next/server";
import { getUserByEmail, normalizeEmail } from "@/lib/localDb";
import { loadAccountSettings, sendVerificationEmail } from "@/lib/users/register";

// "Check your email" — one response for every input, so the endpoint cannot be
// used to learn whether an address has an account.
const OK = { ok: true, message: "If the address needs verification, a new link is on its way" };

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const RATE_LIMIT_MS = 60_000;
// Survives dev hot-reload; a restart simply forgets the throttle.
if (!global._resendVerificationLast) global._resendVerificationLast = new Map();
const lastSent = global._resendVerificationLast;

function prune(now) {
  for (const [email, at] of lastSent) {
    if (now - at > RATE_LIMIT_MS * 10) lastSent.delete(email);
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(OK, { headers: NO_STORE });
  }

  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json(OK, { headers: NO_STORE });

  const now = Date.now();
  prune(now);
  const previous = lastSent.get(email);
  if (previous && now - previous < RATE_LIMIT_MS) {
    return NextResponse.json(OK, { headers: NO_STORE });
  }
  lastSent.set(email, now);

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
