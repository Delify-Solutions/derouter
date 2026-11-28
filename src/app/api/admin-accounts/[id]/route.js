import { NextResponse } from "next/server";
import {
  findAdminAccountById,
  updateAdminAccount,
  deleteAdminAccount,
} from "@/lib/auth/adminUsers";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const STATUSES = new Set(["active", "disabled"]);

/**
 * PATCH /api/admin-accounts/[id] — display name, status (enable/disable), and/or
 * a forced password reset (`newPassword` sets `mustChangePassword` true). The
 * `super_admin` account can never be edited here (adminUsers.js refuses it).
 */
export async function PATCH(request, { params }) {
  const denied = await requirePagePermission(request, "admin-accounts", "edit");
  if (denied) return denied;
  const { id } = await params;

  const existing = await findAdminAccountById(id);
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy tài khoản" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  if (body?.status !== undefined && !STATUSES.has(body.status)) {
    return NextResponse.json({ error: "Trạng thái không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (body?.newPassword !== undefined && (typeof body.newPassword !== "string" || body.newPassword.length < 8)) {
    return NextResponse.json({ error: "Mật khẩu mới tối thiểu 8 ký tự" }, { status: 400, headers: NO_STORE });
  }

  try {
    const account = await updateAdminAccount(id, {
      displayName: body?.displayName,
      status: body?.status,
      newPassword: body?.newPassword,
    });
    return NextResponse.json({ account }, { headers: NO_STORE });
  } catch (error) {
    const status = error?.code === "super_admin_protected" ? 403 : 400;
    return NextResponse.json({ error: error.message || "Không lưu được tài khoản" }, { status, headers: NO_STORE });
  }
}

/**
 * DELETE /api/admin-accounts/[id] — `{ confirmUsername }` must repeat the
 * account's username (spec "Deleting an account SHALL require typing its
 * username back, same confirmation pattern as deleting a customer account").
 */
export async function DELETE(request, { params }) {
  const denied = await requirePagePermission(request, "admin-accounts", "delete");
  if (denied) return denied;
  const { id } = await params;

  const existing = await findAdminAccountById(id);
  if (!existing) {
    return NextResponse.json({ error: "Không tìm thấy tài khoản" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nhập lại tên đăng nhập để xác nhận xoá" }, { status: 400, headers: NO_STORE });
  }
  const confirmUsername = typeof body?.confirmUsername === "string" ? body.confirmUsername.trim() : "";
  if (confirmUsername.toLowerCase() !== existing.username.toLowerCase()) {
    return NextResponse.json(
      { error: "Tên đăng nhập nhập vào không khớp với tài khoản cần xoá" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    await deleteAdminAccount(id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    const status = error?.code === "super_admin_protected" ? 403 : 400;
    return NextResponse.json({ error: error.message || "Không xoá được tài khoản" }, { status, headers: NO_STORE });
  }
}
