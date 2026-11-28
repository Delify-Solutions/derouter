import { NextResponse } from "next/server";
import {
  listAdminAccounts,
  createAdminAccount,
  setAdminPermissions,
  isValidUsername,
} from "@/lib/auth/adminUsers";
import { PAGE_KEYS } from "@/lib/auth/adminPages";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/admin-accounts — every account plus its permission matrix. */
export async function GET() {
  try {
    const accounts = await listAdminAccounts();
    const { getAdminPermissions } = await import("@/lib/auth/adminUsers");
    const withMatrix = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        permissions: account.role === "super_admin" ? null : await getAdminPermissions(account.id),
      }))
    );
    return NextResponse.json({ accounts: withMatrix, pageKeys: PAGE_KEYS }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Không tải được danh sách tài khoản" }, { status: 500, headers: NO_STORE });
  }
}

function validateMatrixInput(matrix) {
  if (matrix === undefined) return null;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) return "Ma trận quyền không hợp lệ";
  for (const key of Object.keys(matrix)) {
    if (!PAGE_KEYS.includes(key)) return `Trang không hợp lệ: ${key}`;
  }
  return null;
}

/**
 * POST /api/admin-accounts — create a `member` account with a temporary password
 * and (optionally) its full permission matrix in one request (spec admin-accounts
 * "Create a collaborator").
 */
export async function POST(request) {
  const denied = await requirePagePermission(request, "admin-accounts", "edit");
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (!isValidUsername(username)) {
    return NextResponse.json(
      { error: "Tên đăng nhập phải dài 3-32 ký tự, chỉ gồm chữ/số/_/-" },
      { status: 400, headers: NO_STORE }
    );
  }
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 8) {
    return NextResponse.json({ error: "Mật khẩu tạm thời tối thiểu 8 ký tự" }, { status: 400, headers: NO_STORE });
  }
  const matrixError = validateMatrixInput(body?.permissions);
  if (matrixError) return NextResponse.json({ error: matrixError }, { status: 400, headers: NO_STORE });

  try {
    const account = await createAdminAccount({
      username,
      password,
      displayName: typeof body?.displayName === "string" ? body.displayName.trim() : "",
      role: "member",
    });
    if (body?.permissions) {
      await setAdminPermissions(account.id, body.permissions);
    }
    return NextResponse.json({ account }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const status = error?.code === "username_taken" ? 409 : 400;
    return NextResponse.json({ error: error.message || "Không tạo được tài khoản" }, { status, headers: NO_STORE });
  }
}
