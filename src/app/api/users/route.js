import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getKeyGroups, getKeyGroupById } from "@/lib/db/repos/keyGroupsRepo.js";
import { createUser, deleteUser, normalizeEmail, getUserByEmail } from "@/lib/db/repos/userRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { listUsersAdmin } from "@/lib/db/repos/adminUsersRepo.js";
import { validatePassword } from "@/lib/users/register";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/users — the admin users list (spec admin-user-management "Users list").
 *
 * Query: `q`, `groupId`, `status`, `planState`, `sort`, `dir`, `page`, `pageSize`.
 * Returns `{ users, total, page, pageSize }`, where every user already carries the
 * aggregates the table renders (queued plans, available credit, 30-day spend, last
 * API use). All of them come from set-based sub-selects in the repo, never one query
 * per row.
 */
export async function GET(request) {
  try {
    const params = request.nextUrl.searchParams;
    const result = await listUsersAdmin({
      q: params.get("q") || "",
      groupId: params.get("groupId") || "",
      status: params.get("status") || "",
      planState: params.get("planState") || "",
      sort: params.get("sort") || "createdAt",
      dir: params.get("dir") || "desc",
      page: Number(params.get("page")) || 1,
      pageSize: Number(params.get("pageSize")) || 50,
    });

    // Groups ship with the list so the filter and the create form have their
    // options without a second round trip.
    let groups = [];
    try {
      groups = (await getKeyGroups()).map((group) => ({
        id: group.id,
        name: group.name,
        isActive: group.isActive,
      }));
    } catch {
      groups = [];
    }

    return NextResponse.json({ ...result, groups }, { headers: NO_STORE });
  } catch (error) {
    console.error("[users] list failed:", error?.message || error);
    return NextResponse.json({ error: "Không tải được danh sách người dùng" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/users — admin creates an account.
 *
 * The public signup flow exists, but an operator needs to add a customer without
 * that customer receiving mail (no SMTP relay configured, or an account arranged
 * out of band). Creating one here skips verification and marks the account active:
 * the admin vouches for the address, and leaving it "unverified" would lock the
 * customer out until mail is set up.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Email không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  // The SAME policy as public signup (10–200 characters): a weaker password set by
  // an admin would quietly become the weakest account in the system, and one rule
  // in one place is the only way the two paths cannot drift apart.
  const passwordError = validatePassword(password);
  if (passwordError) {
    // The validator owns the wording, so every path states the same rule.
    return NextResponse.json({ error: passwordError }, { status: 400, headers: NO_STORE });
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: "Email này đã có tài khoản" }, { status: 409, headers: NO_STORE });
  }

  // The same rule PATCH enforces: a customer may only be created into an ACTIVE
  // group. Accepting an unknown or inactive id here would produce an account whose
  // keys resolve no group — every request 403 — until the next boot repaired it.
  const requestedGroupId = typeof body?.groupId === "string" ? body.groupId.trim() : "";
  if (requestedGroupId) {
    const group = await getKeyGroupById(requestedGroupId);
    if (!group || !group.isActive) {
      return NextResponse.json(
        { error: "Nhóm không tồn tại hoặc đã ngừng hoạt động" },
        { status: 400, headers: NO_STORE }
      );
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({
      email,
      passwordHash,
      displayName: typeof body?.displayName === "string" ? body.displayName.trim() || null : null,
      groupId: requestedGroupId || undefined,
      // Verified by the admin's word, not by mail.
      status: "active",
    });
    return NextResponse.json({ user }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không tạo được tài khoản" },
      { status: 400, headers: NO_STORE }
    );
  }
}

// ── Bulk delete ─────────────────────────────────────────────────────────────

/** One request may delete at most this many accounts. */
export const BULK_DELETE_MAX = 50;

/**
 * DELETE /api/users — delete several accounts at once
 * (spec admin-user-management "Bulk delete").
 *
 * Body `{ userIds: string[], confirmEmails?: Record<id, email>, reason }`.
 *
 * The single-account route asks for the account's email as confirmation. Repeating
 * that for 50 rows is unusable, and dropping it entirely would make a mis-click
 * irreversible, so the bulk form asks for `reason` instead (also required by every
 * other audited action) and reports exactly which accounts were removed. Each
 * deletion goes through `deleteUser`, so the cascade and the audit row are the same
 * as the single-row path — there is no second delete implementation.
 *
 * The loop is not one transaction on purpose: `deleteUser` opens its own, and a
 * failure on row 7 must leave rows 1–6 deleted (the report says which succeeded)
 * rather than pretend nothing happened.
 */
export async function DELETE(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const reason = String(body?.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }

  const raw = Array.isArray(body?.userIds) ? body.userIds : [];
  // De-duplicated: the same id twice must not produce two audit entries or a second
  // "already gone" error.
  const userIds = [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (!userIds.length) {
    return NextResponse.json({ error: "Chưa chọn tài khoản nào" }, { status: 400, headers: NO_STORE });
  }
  if (userIds.length > BULK_DELETE_MAX) {
    return NextResponse.json(
      { error: `Mỗi lần xoá tối đa ${BULK_DELETE_MAX} tài khoản` },
      { status: 400, headers: NO_STORE }
    );
  }

  const actor = await getAdminActor(request);
  const deleted = [];
  const missing = [];
  const failed = [];

  for (const id of userIds) {
    try {
      const result = await deleteUser(id, { actor, reason });
      if (result?.deleted) deleted.push({ id, email: result.email });
      else missing.push(id);
    } catch (error) {
      // Keep going: one bad row must not strand the rest of the selection.
      failed.push({ id, error: error?.message || "Không xoá được" });
    }
  }

  return NextResponse.json(
    { deleted, missing, failed, reason },
    { headers: NO_STORE }
  );
}
