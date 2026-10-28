import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  getApiKeys,
  getKeyGroupById,
  getUserById,
  updateUser,
  deleteUser,
  listUsers,
  deleteApiKey,
  revokeAllUserSessions,
  normalizeEmail,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const VALID_STATUSES = new Set(["unverified", "active", "suspended"]);

export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404, headers: NO_STORE });
  }
  const [group, keys, all] = await Promise.all([getKeyGroupById(user.groupId), getApiKeys(), listUsers()]);
  return NextResponse.json(
    {
      user: {
        ...user,
        groupName: group?.name ?? null,
        keyCount: keys.filter((key) => key.userId === user.id).length,
      },
      total: all.length,
    },
    { headers: NO_STORE }
  );
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  const existing = await getUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "groupId")) {
    const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
    if (groupId) {
      const group = await getKeyGroupById(groupId);
      if (!group) {
        return NextResponse.json({ error: "Group not found" }, { status: 400, headers: NO_STORE });
      }
      patch.groupId = groupId;
    } else {
      // Empty string clears the group; the user's keys then inherit nothing.
      patch.groupId = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "");
    if (!VALID_STATUSES.has(status)) {
      return NextResponse.json(
        { error: `Status must be one of: ${[...VALID_STATUSES].join(", ")}` },
        { status: 400, headers: NO_STORE }
      );
    }
    patch.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    patch.displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  }
  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400, headers: NO_STORE });
    }
    const clash = (await listUsers()).find((user) => user.email === email && user.id !== id);
    if (clash) {
      return NextResponse.json({ error: "Another user already has this email" }, { status: 409, headers: NO_STORE });
    }
    patch.email = email;
  }

  // Password reset is a separate concern from the profile patch above: it is
  // hashed, it invalidates every session, and it must not be possible to set it
  // through a generic field assignment.
  let newPasswordHash = null;
  if (Object.prototype.hasOwnProperty.call(body, "password")) {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Mật khẩu phải có ít nhất 8 ký tự" },
        { status: 400, headers: NO_STORE }
      );
    }
    newPasswordHash = await bcrypt.hash(password, 10);
  }

  if (Object.keys(patch).length === 0 && !newPasswordHash) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400, headers: NO_STORE });
  }

  const updated = newPasswordHash
    ? await updateUser(id, { ...patch, passwordHash: newPasswordHash })
    : await updateUser(id, patch);

  // A reset password must not leave the old session (and whoever was holding it)
  // signed in.
  if (newPasswordHash) {
    await revokeAllUserSessions(id);
  }

  // Suspension must take effect immediately, not when the JWT expires.
  if (patch.status && patch.status !== "active") {
    await revokeAllUserSessions(id);
  }

  return NextResponse.json({ user: updated }, { headers: NO_STORE });
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  const existing = await getUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404, headers: NO_STORE });
  }

  // Delete in dependency order: keys first (a key row outliving its owner would
  // still authenticate against the LLM surface), then sessions, then the user.
  const keys = (await getApiKeys()).filter((key) => key.userId === id);
  for (const key of keys) {
    await deleteApiKey(key.id);
  }
  await revokeAllUserSessions(id);
  const deleted = await deleteUser(id);
  if (!deleted) {
    return NextResponse.json({ error: "User not found" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, deletedKeys: keys.length }, { headers: NO_STORE });
}
