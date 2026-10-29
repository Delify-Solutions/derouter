import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById, listUserSessions } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { insertAuditSync } from "@/lib/billing/audit.js";
import { validateReason } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET — every open session of the account. */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ sessions: await listUserSessions(id) }, { headers: NO_STORE });
}

/**
 * DELETE — revoke ALL of the account's sessions.
 *
 * Used both as "log this account out everywhere" (support) and as the second half of
 * a suspension, which the status action already does on its own.
 */
export async function DELETE(request, { params }) {
  const { id } = await params;
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

  const revoked = db.transaction(() => {
    const at = new Date().toISOString();
    const res = db.run(`UPDATE userSessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL`, [at, id]);
    const count = res?.changes ?? 0;
    insertAuditSync(db, {
      userId: id,
      actor,
      action: "sessions_revoked",
      reason,
      details: { revokedSessions: count },
    });
    return count;
  });

  return NextResponse.json({ revokedSessions: revoked }, { headers: NO_STORE });
}
