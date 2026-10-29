import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById, revokeSessionById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { insertAuditSync } from "@/lib/billing/audit.js";
import { validateReason } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** DELETE — revoke ONE session. Scoped to the account, so a foreign id is a 404. */
export async function DELETE(request, { params }) {
  const { id, sessionId } = await params;
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
  const revoked = await revokeSessionById(id, sessionId);
  if (!revoked) {
    return NextResponse.json({ error: "Không tìm thấy phiên đăng nhập" }, { status: 404, headers: NO_STORE });
  }

  const db = await getAdapter();
  insertAuditSync(db, {
    userId: id,
    actor,
    action: "session_revoked",
    reason,
    details: { sessionId },
  });

  return NextResponse.json({ revoked: true }, { headers: NO_STORE });
}
