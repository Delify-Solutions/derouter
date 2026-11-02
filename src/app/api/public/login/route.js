import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getUserByEmailWithPassword } from "@/lib/localDb";
import { startUserSession } from "@/lib/auth/userSession";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  const ip = getClientIp(request);
  const lock = checkLock(ip);
  if (lock.locked) {
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(lock.retryAfter) } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400, headers: NO_STORE });
  }

  const fail = (message, status = 401) => {
    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    const headers = postLock.locked
      ? { ...NO_STORE, "Retry-After": String(postLock.retryAfter) }
      : NO_STORE;
    return NextResponse.json(
      {
        error: message,
        ...(postLock.locked ? { retryAfter: postLock.retryAfter } : { remainingBeforeLock }),
      },
      { status: postLock.locked ? 429 : status, headers }
    );
  };

  const user = await getUserByEmailWithPassword(email);
  // Compare against a dummy hash when the address is unknown so the timing of
  // "no such user" and "wrong password" stays comparable.
  if (!user) {
    await bcrypt.compare(password, "$2a$10$CwTycUXWue0Thq9StjUM0uJ8U2yq0M0kM1uJ0m9r3xs7C6OvFJ8yG");
    return fail("Invalid email or password");
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) return fail("Invalid email or password");

  if (user.status === "unverified") {
    // Correct credentials, so this is not a lockout-triggering failure.
    recordSuccess(ip);
    return NextResponse.json(
      { error: "Verify your email first", code: "unverified" },
      { status: 403, headers: NO_STORE }
    );
  }
  if (user.status === "suspended") {
    recordSuccess(ip);
    return NextResponse.json(
      { error: "This account is suspended", code: "suspended" },
      { status: 403, headers: NO_STORE }
    );
  }
  if (user.status !== "active") {
    recordSuccess(ip);
    return NextResponse.json(
      { error: "This account is not active", code: "inactive" },
      { status: 403, headers: NO_STORE }
    );
  }

  recordSuccess(ip);

  // Persists the session row as well, so logout and password reset can revoke it
  // and the account API can require a live row rather than a bare signature.
  await startUserSession(await cookies(), request, user, { ip });

  return NextResponse.json(
    {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        groupId: user.groupId ?? null,
      },
    },
    { headers: NO_STORE }
  );
}
