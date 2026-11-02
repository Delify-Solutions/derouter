import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import {
  createUser,
  isValidEmailShape,
  normalizeEmail,
} from "@/lib/localDb";
import { notifyAdminNewUser } from "@/lib/notify/telegram";
import { checkLimits, getClientIp } from "@/lib/auth/actionLimiter.js";
import { startUserSession } from "@/lib/auth/userSession";
import {
  loadAccountSettings,
  sendVerificationEmail,
  validatePassword,
} from "@/lib/users/register";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const GENERIC_DUPLICATE = "Registration unavailable for this address";

// 5 signups per hour per client IP. Generous for a shared office, tight enough
// that a script cannot farm accounts.
const REGISTER_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

function fail(message, status, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: NO_STORE });
}

export async function POST(request) {
  // Rate limit BEFORE any work: an over-limit attempt must not create a user, hash
  // a password or send mail.
  const ip = getClientIp(request);
  const gate = checkLimits([{ bucket: `register:ip:${ip}`, ...REGISTER_LIMIT }]);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Bạn đã thử đăng ký quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(gate.retryAfterSec / 60)} phút.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body", 400);
  }

  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";

  const settings = await loadAccountSettings();
  if (settings.publicSignupEnabled !== true) {
    return fail("Public signup is disabled on this instance", 403);
  }

  if (!isValidEmailShape(email)) return fail("Enter a valid email address", 400);
  const passwordError = validatePassword(password);
  if (passwordError) return fail(passwordError, 400);

  let passwordHash;
  try {
    passwordHash = await bcrypt.hash(password, 10);
  } catch {
    return fail("Could not create the account", 500);
  }

  let user;
  try {
    user = await createUser({
      email,
      passwordHash,
      displayName: displayName || null,
    });
  } catch (error) {
    // UNIQUE(email) is the only expected conflict. The message is deliberately
    // generic and identical for every cause, so the response cannot be read as
    // "this address exists" versus "the write failed".
    const message = String(error?.message || "");
    if (/unique|constraint/i.test(message)) {
      return fail(GENERIC_DUPLICATE, 409);
    }
    console.error("[public/register] create failed:", message);
    return fail("Could not create the account", 500);
  }

  const needsVerification = user.status === "unverified";
  if (needsVerification) {
    // `next` is optional and validated downstream; an invalid value is simply not
    // carried into the mail.
    await sendVerificationEmail({ user, request, settings, next: body?.next ?? null });
  }

  // Without email verification the new account is already active, so sign the
  // visitor in now instead of telling them to check an inbox that will stay
  // empty. Only `active` qualifies: any other status still goes through login.
  let signedIn = false;
  if (user.status === "active") {
    try {
      await startUserSession(await cookies(), request, user, { ip });
      signedIn = true;
    } catch (error) {
      console.error("[public/register] auto sign-in failed:", error?.message || error);
    }
  }

  notifyAdminNewUser({
    email: user.email,
    groupId: user.groupId,
    siteName: settings.siteName,
  }).catch(() => {});

  return NextResponse.json(
    {
      ok: true,
      // Never includes the user id or status: registration responses must not be
      // usable to probe account existence. `signedIn` only mirrors the instance's
      // verification setting for a brand-new account.
      signedIn,
      // Lets the form tell "check your inbox" apart from "account ready, sign in"
      // (the latter only when auto sign-in itself failed).
      verificationSent: needsVerification,
      message: needsVerification
        ? "Check your email for the verification link"
        : "Account created. You can sign in now.",
    },
    { headers: NO_STORE }
  );
}
