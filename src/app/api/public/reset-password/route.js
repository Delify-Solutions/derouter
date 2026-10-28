import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  consumeVerification,
  getUserById,
  updateUser,
  revokeAllUserSessions,
} from "@/lib/localDb";
import { RESET_PURPOSE, validatePassword } from "@/lib/users/register";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400, headers: NO_STORE });
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400, headers: NO_STORE });
  }

  // Consume first: a used link must not survive a failed hash write.
  const userId = await consumeVerification(token, RESET_PURPOSE);
  if (!userId) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400, headers: NO_STORE }
    );
  }

  const user = await getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 404, headers: NO_STORE });
  }

  let passwordHash;
  try {
    passwordHash = await bcrypt.hash(password, 10);
  } catch {
    return NextResponse.json({ error: "Could not update the password" }, { status: 500, headers: NO_STORE });
  }

  await updateUser(user.id, { passwordHash });
  // Every existing session is now untrusted: a reset is how a user recovers from
  // a compromised password, so the attacker's cookie must die with it.
  await revokeAllUserSessions(user.id);

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
