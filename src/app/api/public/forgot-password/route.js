import { NextResponse } from "next/server";
import { getUserByEmail, normalizeEmail } from "@/lib/localDb";
import { loadAccountSettings, sendResetEmail } from "@/lib/users/register";

// Always answers the same way: a reset request must not reveal whether the
// address exists.
const OK = { ok: true, message: "If that address has an account, a reset link is on its way" };

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const RATE_LIMIT_MS = 60_000;
if (!global._forgotPasswordLast) global._forgotPasswordLast = new Map();
const lastSent = global._forgotPasswordLast;

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
    if (user) {
      const settings = await loadAccountSettings();
      await sendResetEmail({ user, request, settings });
    }
  } catch (error) {
    console.log("[public/forgot-password] failed:", error?.message || error);
  }

  return NextResponse.json(OK, { headers: NO_STORE });
}
