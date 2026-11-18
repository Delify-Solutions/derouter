import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { deleteStorageSync, saveAndTestStorage, storageViewSync } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const EXPIRED = { error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." };

/** GET /api/account/storage — the customer's image storage (secret never included). */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json(EXPIRED, { status: 401, headers: NO_STORE });
  return NextResponse.json(storageViewSync(await getAdapter(), session.userId), { headers: NO_STORE });
}

/** PUT /api/account/storage — save (a blank secret keeps the stored one), then test it. */
export async function PUT(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json(EXPIRED, { status: 401, headers: NO_STORE });
  let input;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const result = await saveAndTestStorage(await getAdapter(), session.userId, input || {}, { actor: "customer", rateLimit: true });
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}

/** DELETE /api/account/storage — disconnect; image models are refused until a new one is saved. */
export async function DELETE(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json(EXPIRED, { status: 401, headers: NO_STORE });
  const db = await getAdapter();
  deleteStorageSync(db, session.userId);
  return NextResponse.json(storageViewSync(db, session.userId), { headers: NO_STORE });
}
