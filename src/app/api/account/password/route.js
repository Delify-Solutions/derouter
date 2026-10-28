import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { resolveAccountUser, getUserTokenFromRequest } from "@/lib/auth/userSession";
import {
  getUserById,
  getUserByEmailWithPassword,
  updateUser,
  revokeOtherUserSessions,
} from "@/lib/localDb";
import { validatePassword } from "@/lib/users/register";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword) {
    return NextResponse.json({ error: "Current password is required" }, { status: 400, headers: NO_STORE });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400, headers: NO_STORE });
  }

  const user = await getUserByEmailWithPassword(session.email);
  if (!user || user.id !== session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 400, headers: NO_STORE });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await updateUser(user.id, { passwordHash });

  // Keep the session that made the change, drop every other one: a password
  // change should evict whoever else is holding a copy of the old credential.
  await revokeOtherUserSessions(user.id, getUserTokenFromRequest(request));

  const refreshed = await getUserById(user.id);
  return NextResponse.json({ ok: true, user: refreshed ? { id: refreshed.id, email: refreshed.email } : null }, {
    headers: NO_STORE,
  });
}
