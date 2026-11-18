import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getUserById } from "@/lib/localDb";
import { insertAuditSync } from "@/lib/billing/audit.js";
import { isLocalImageUserSync, setLocalImageUserSync } from "@/lib/storage/localImages.js";
import { storageViewSync } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PUT /api/users/[id]/storage/local `{ enabled }` — admin-only (dashboardGuard):
 * keep this customer's generated images on the router's disk instead of any CDN.
 */
export async function PUT(request, { params }) {
  const { id } = await params;
  if (!(await getUserById(id))) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (typeof input?.enabled !== "boolean") {
    return NextResponse.json({ error: "Thiếu enabled" }, { status: 400, headers: NO_STORE });
  }
  const actor = await getAdminActor(request);
  const db = await getAdapter();
  // Read and write in one transaction: two concurrent toggles audit once.
  db.transaction(() => {
    if (isLocalImageUserSync(db, id) === input.enabled) return;
    setLocalImageUserSync(db, id, input.enabled);
    insertAuditSync(db, { userId: id, actor, action: input.enabled ? "storage_local_on" : "storage_local_off" });
  });
  return NextResponse.json(storageViewSync(db, id), { headers: NO_STORE });
}
