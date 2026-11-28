import { NextResponse } from "next/server";
import { findAdminAccountById, setAdminPermissions } from "@/lib/auth/adminUsers";
import { PAGE_KEYS } from "@/lib/auth/adminPages";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/admin-accounts/[id]/permissions — replace an account's whole
 * view/edit/delete matrix in one request (spec "the full permission matrix...
 * in one form"). `edit`/`delete` without `view` is rejected client- and
 * server-side (setAdminPermissionsSync).
 */
export async function PUT(request, { params }) {
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
  const matrix = body?.permissions;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return NextResponse.json({ error: "Ma trận quyền không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  for (const key of Object.keys(matrix)) {
    if (!PAGE_KEYS.includes(key)) {
      return NextResponse.json({ error: `Trang không hợp lệ: ${key}` }, { status: 400, headers: NO_STORE });
    }
  }

  try {
    const permissions = await setAdminPermissions(id, matrix);
    return NextResponse.json({ permissions }, { headers: NO_STORE });
  } catch (error) {
    const status = error?.code === "super_admin_protected" ? 403 : error?.code === "edit_without_view" ? 400 : 400;
    return NextResponse.json({ error: error.message || "Không lưu được quyền" }, { status, headers: NO_STORE });
  }
}
