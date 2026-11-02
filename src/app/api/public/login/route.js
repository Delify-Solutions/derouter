import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getUserByEmailWithPassword } from "@/lib/localDb";
import { startUserSession } from "@/lib/auth/userSession";
import { checkLocks, recordFails, recordSuccess, getClientIp, userIpBucket, userAccountBucket } from "@/lib/auth/loginLimiter";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function tooMany(retryAfter) {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${retryAfter}s.`, retryAfter },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(retryAfter) } }
  );
}

export async function POST(request) {
  const ip = getClientIp(request);
  const ipLock = checkLocks([userIpBucket(ip)]);
  if (ipLock.locked) return tooMany(ipLock.retryAfter);

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

  // Failures count per client AND per account. A correct password clears only the
  // account bucket: signing in to your own account must not wipe the failures this
  // client piled up against someone else's (or against the admin login).
  const buckets = [userIpBucket(ip), userAccountBucket(email)];
  const accountBucket = buckets[1].key;
  const lock = checkLocks(buckets);
  if (lock.locked) return tooMany(lock.retryAfter);

  const fail = (message, status = 401) => {
    const { remainingBeforeLock } = recordFails(buckets);
    const postLock = checkLocks(buckets);
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
  if (!passwordOk) {
    // A wrong password on a real account is the signal worth keeping for abuse
    // checks; unknown emails are not logged (no account to attach them to).
    await recordActivity(request, { userId: user.id, action: "login_failed" });
    return fail("Invalid email or password");
  }

  if (user.status === "unverified") {
    // Correct credentials, so this is not a lockout-triggering failure.
    recordSuccess(accountBucket);
    return NextResponse.json(
      { error: "Verify your email first", code: "unverified" },
      { status: 403, headers: NO_STORE }
    );
  }
  if (user.status === "suspended") {
    recordSuccess(accountBucket);
    await recordActivity(request, { userId: user.id, action: "login_blocked", details: { status: "suspended" } });
    return NextResponse.json(
      { error: "This account is suspended", code: "suspended" },
      { status: 403, headers: NO_STORE }
    );
  }
  if (user.status !== "active") {
    recordSuccess(accountBucket);
    return NextResponse.json(
      { error: "This account is not active", code: "inactive" },
      { status: 403, headers: NO_STORE }
    );
  }

  recordSuccess(accountBucket);
  await recordActivity(request, { userId: user.id, action: "login" });

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
