import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { deleteStorageSync, saveAndTestStorage, storageViewSync, SYSTEM_STORAGE_ID } from "@/lib/storage/userStorage.js";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// Admin-only (dashboardGuard): the system image storage, used for customers who
// have no usable storage of their own while it is enabled and its test passed.

export async function GET() {
  return NextResponse.json(storageViewSync(await getAdapter(), SYSTEM_STORAGE_ID), { headers: NO_STORE });
}

export async function PUT(request) {
  const denied = await requirePagePermission(request, "storage", "edit");
  if (denied) return denied;
  let input;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const actor = await getAdminActor(request);
  const result = await saveAndTestStorage(await getAdapter(), SYSTEM_STORAGE_ID, input || {}, { actor });
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}

export async function DELETE(request) {
  const denied = await requirePagePermission(request, "storage", "delete");
  if (denied) return denied;
  const db = await getAdapter();
  deleteStorageSync(db, SYSTEM_STORAGE_ID);
  return NextResponse.json(storageViewSync(db, SYSTEM_STORAGE_ID), { headers: NO_STORE });
}
