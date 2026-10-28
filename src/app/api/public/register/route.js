import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  createUser,
  isValidEmailShape,
  normalizeEmail,
} from "@/lib/localDb";
import { notifyAdminNewUser } from "@/lib/notify/telegram";
import {
  loadAccountSettings,
  sendVerificationEmail,
  validatePassword,
} from "@/lib/users/register";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const GENERIC_DUPLICATE = "Registration unavailable for this address";

function fail(message, status, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status, headers: NO_STORE });
}

export async function POST(request) {
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
    await sendVerificationEmail({ user, request, settings });
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
      // usable to probe account existence.
      message: needsVerification
        ? "Check your email for the verification link"
        : "Account created. You can sign in now.",
    },
    { headers: NO_STORE }
  );
}
