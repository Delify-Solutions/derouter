import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { insertAuditSync } from "@/lib/billing/audit.js";
import { validateReason } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Load a key that belongs to this user, or null. */
function loadKey(db, userId, keyId) {
  return db.get(`SELECT id, name, isActive FROM apiKeys WHERE id = ? AND userId = ?`, [keyId, userId]);
}

/**
 * PATCH /api/users/[id]/keys/[keyId] — enable or disable a customer key.
 *
 * Body `{ isActive, reason }`. Effective on the next request: `validateApiKey` reads
 * `isActive` on every call, so nothing has to be invalidated.
 */
export async function PATCH(request, { params }) {
  const { id, keyId } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const reason = validateReason(body?.reason);
  if (!reason) {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body?.isActive !== "boolean") {
    return NextResponse.json({ error: "Thiếu trạng thái bật/tắt" }, { status: 400, headers: NO_STORE });
  }

  const actor = await getAdminActor(request);
  const db = await getAdapter();

  const outcome = db.transaction(() => {
    const key = loadKey(db, id, keyId);
    if (!key) return null;
    db.run(`UPDATE apiKeys SET isActive = ?, updatedAt = ? WHERE id = ?`, [
      body.isActive ? 1 : 0,
      new Date().toISOString(),
      keyId,
    ]);
    insertAuditSync(db, {
      userId: id,
      actor,
      action: body.isActive ? "key_enabled" : "key_disabled",
      reason,
      details: {
        keyId,
        keyName: key.name ?? null,
        before: { isActive: key.isActive === 1 || key.isActive === true },
        after: { isActive: body.isActive },
      },
    });
    return { keyId, isActive: body.isActive };
  });

  if (!outcome) {
    return NextResponse.json({ error: "Không tìm thấy API key" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json(outcome, { headers: NO_STORE });
}

/** DELETE — remove the key. The secret stops working immediately. */
export async function DELETE(request, { params }) {
  const { id, keyId } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }

  const reason = validateReason(body?.reason);
  if (!reason) {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }

  const actor = await getAdminActor(request);
  const db = await getAdapter();

  const outcome = db.transaction(() => {
    const key = loadKey(db, id, keyId);
    if (!key) return null;
    db.run(`DELETE FROM apiKeys WHERE id = ?`, [keyId]);
    insertAuditSync(db, {
      userId: id,
      actor,
      action: "key_deleted",
      reason,
      details: { keyId, keyName: key.name ?? null },
    });
    return { keyId, deleted: true };
  });

  if (!outcome) {
    return NextResponse.json({ error: "Không tìm thấy API key" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json(outcome, { headers: NO_STORE });
}
