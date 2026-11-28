import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getUserById } from "@/lib/localDb";
import { insertAuditSync } from "@/lib/billing/audit.js";
import { deleteStorageSync, getStorageRowSync, saveAndTestStorage, storageViewSync } from "@/lib/storage/userStorage.js";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const NOT_FOUND = { error: "Không tìm thấy người dùng" };

// Admin-only (dashboardGuard): view and set a customer's image storage.

export async function GET(request, { params }) {
  const { id } = await params;
  if (!(await getUserById(id))) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  return NextResponse.json(storageViewSync(await getAdapter(), id), { headers: NO_STORE });
}

export async function PUT(request, { params }) {
  const denied = await requirePagePermission(request, "users", "edit");
  if (denied) return denied;
  const { id } = await params;
  if (!(await getUserById(id))) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  let input;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const actor = await getAdminActor(request);
  const db = await getAdapter();
  const result = await saveAndTestStorage(db, id, input || {}, { actor });
  // Audited whenever the row was written, whatever the test that followed said.
  if (result.saved) {
    const row = getStorageRowSync(db, id);
    insertAuditSync(db, {
      userId: id,
      actor,
      action: "storage_set",
      details: { provider: row?.provider, bucket: row?.bucket, endpoint: row?.endpoint, secretChanged: Boolean(input?.secretAccessKey) },
    });
  }
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}

export async function DELETE(request, { params }) {
  const denied = await requirePagePermission(request, "users", "delete");
  if (denied) return denied;
  const { id } = await params;
  if (!(await getUserById(id))) return NextResponse.json(NOT_FOUND, { status: 404, headers: NO_STORE });
  const db = await getAdapter();
  if (deleteStorageSync(db, id)) {
    insertAuditSync(db, { userId: id, actor: await getAdminActor(request), action: "storage_removed" });
  }
  return NextResponse.json(storageViewSync(db, id), { headers: NO_STORE });
}
