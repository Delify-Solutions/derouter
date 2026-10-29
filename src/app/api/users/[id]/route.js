import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getKeyGroupById, getUserById, deleteUser, normalizeEmail, listUsers } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { validatePassword } from "@/lib/users/register";
import { getUserSummary } from "@/lib/db/repos/adminUsersRepo.js";
import {
  changeGroupSync,
  changeStatusSync,
  changeProfileSync,
  setNoteSync,
  resetPasswordSync,
  validateReason,
} from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/users/[id] — the customer plus the `summary` the detail page opens with
 * (design D18): available credit, debt, 7/30-day spend, key count, open sessions.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const [group, summary] = await Promise.all([getKeyGroupById(user.groupId), getUserSummary(id)]);

  return NextResponse.json(
    {
      user: {
        ...user,
        groupName: group?.name ?? null,
      },
      summary,
    },
    { headers: NO_STORE }
  );
}

/**
 * PATCH /api/users/[id]
 *
 * Accepts `groupId`, `status`, `displayName`, `email`, `adminNote`, `password` and
 * `reason`. Every change except `adminNote` requires a reason of 3–500 characters
 * (spec admin-user-management "Audited admin actions"), and each one writes exactly
 * one audit entry in the same transaction as the change:
 *
 *   groupId     → `group_changed`
 *   status      → `status_changed` (suspended/unverified also revoke all sessions)
 *   email/name  → `profile_changed`
 *   adminNote   → `note_changed`   (no reason needed)
 *   password    → `password_reset` (also revokes all sessions, never logged)
 *
 * Validation happens BEFORE anything is written, so a 400 leaves the account
 * untouched.
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  const existing = await getUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const touchesAccount = ["groupId", "status", "displayName", "email", "password"].some(has);

  // A note-only edit needs no reason; anything that changes what the customer can do
  // does. That asymmetry is deliberate: reading the log later, "why is this account
  // suspended" must be answerable, "who wrote this note" is already on the row.
  if (touchesAccount) {
    if (!validateReason(body.reason)) {
      return NextResponse.json(
        { error: "Lý do phải có từ 3 đến 500 ký tự" },
        { status: 400, headers: NO_STORE }
      );
    }
  } else if (!has("adminNote")) {
    return NextResponse.json({ error: "Không có thay đổi nào" }, { status: 400, headers: NO_STORE });
  }

  // Validate the cheap fields up front so nothing is written for a bad request.
  let nextGroupId = null;
  if (has("groupId")) {
    const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
    if (!groupId) {
      return NextResponse.json({ error: "Chọn một nhóm đang hoạt động cho người dùng" }, { status: 400, headers: NO_STORE });
    }
    nextGroupId = groupId;
  }

  let nextEmail = null;
  if (has("email")) {
    nextEmail = normalizeEmail(body.email);
    if (!nextEmail) {
      return NextResponse.json({ error: "Email không hợp lệ" }, { status: 400, headers: NO_STORE });
    }
    const clash = (await listUsers()).find((user) => user.email === nextEmail && user.id !== id);
    if (clash) {
      return NextResponse.json({ error: "Email này đã thuộc tài khoản khác" }, { status: 409, headers: NO_STORE });
    }
  }

  let passwordHash = null;
  if (has("password")) {
    const password = typeof body.password === "string" ? body.password : "";
    // Same policy as public signup and admin create (account-registration spec);
    // the validator owns the wording.
    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400, headers: NO_STORE });
    }
    passwordHash = await bcrypt.hash(password, 10);
  }

  const actor = await getAdminActor(request);
  const db = await getAdapter();

  // A refusal detected INSIDE the transaction has to throw: returning normally would
  // commit the steps that already ran. The sentinel carries the HTTP-shaped failure
  // out to the catch below.
  class ActionRefused extends Error {
    constructor(failure) {
      super(failure.error);
      this.failure = failure;
    }
  }

  let outcome;
  try {
    outcome = db.transaction(() => {
    const results = {};

    if (has("adminNote")) {
      const note = setNoteSync(db, id, {
        adminNote: body.adminNote,
        actor,
        before: existing.adminNote ?? null,
      });
      if (!note.ok) throw new ActionRefused(note);
      results.adminNote = note.adminNote;
    }

    if (nextGroupId) {
      const group = changeGroupSync(db, id, {
        groupId: nextGroupId,
        reason: body.reason,
        actor,
        before: existing.groupId ?? null,
      });
      if (!group.ok) throw new ActionRefused(group);
      results.groupId = group.groupId;
    }

    if (has("status")) {
      const status = changeStatusSync(db, id, {
        status: String(body.status || ""),
        reason: body.reason,
        actor,
        before: existing.status,
      });
      if (!status.ok) throw new ActionRefused(status);
      results.status = status.status;
    }

    if (has("email") || has("displayName")) {
      const profile = changeProfileSync(db, id, {
        ...(has("email") ? { email: nextEmail } : {}),
        ...(has("displayName") ? { displayName: body.displayName } : {}),
        reason: body.reason,
        actor,
        before: { email: existing.email, displayName: existing.displayName ?? null },
      });
      if (!profile.ok) throw new ActionRefused(profile);
    }

    if (passwordHash) {
      const reset = resetPasswordSync(db, id, {
        passwordHash,
        reason: body.reason,
        actor,
      });
      if (!reset.ok) throw new ActionRefused(reset);
      results.passwordReset = true;
    }

      return { ok: true, results };
    });
  } catch (error) {
    if (error instanceof ActionRefused) {
      // Validation above already covered the obvious 400s, so a refusal here is
      // about state (a missing group, a purchase in the wrong status).
      return NextResponse.json(
        { error: error.failure.error },
        { status: error.failure.status || 400, headers: NO_STORE }
      );
    }
    console.error("[users] patch failed:", error?.message || error);
    return NextResponse.json({ error: "Không cập nhật được tài khoản" }, { status: 500, headers: NO_STORE });
  }

  const updated = await getUserById(id);
  const summary = await getUserSummary(id);
  return NextResponse.json({ user: updated, summary, ...outcome.results }, { headers: NO_STORE });
}

/**
 * DELETE /api/users/[id] — irreversibly remove a customer and all their data.
 *
 * The body must repeat the account's email (case-insensitive). Typing the address
 * is the one confirmation that cannot be clicked through: the cascade removes keys,
 * sessions, purchases, ledger and gift redemptions, and only the order history
 * survives. The transaction lives in `deleteUser`, which also writes the
 * `user_deleted` audit entry with this admin as the actor.
 */
export async function DELETE(request, { params }) {
  const { id } = await params;
  const existing = await getUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Nhập lại email của tài khoản để xác nhận xoá" },
      { status: 400, headers: NO_STORE }
    );
  }

  const confirmEmail = normalizeEmail(body?.confirmEmail);
  if (!confirmEmail || confirmEmail !== normalizeEmail(existing.email)) {
    return NextResponse.json(
      { error: "Email nhập vào không khớp với tài khoản cần xoá" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await deleteUser(id, { actor: await getAdminActor(request) });
  if (!result.deleted) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, deletedKeys: result.keyCount }, { headers: NO_STORE });
}
