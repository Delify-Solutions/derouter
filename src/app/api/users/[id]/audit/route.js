import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { listAuditSync } from "@/lib/billing/audit.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/users/[id]/audit?page — the account's audit log, newest first. */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  // A deleted user's audit trail is the one thing that survives them; allow reading
  // it by id so support can still answer "who deleted this account".
  const db = await getAdapter();
  const exists = user || Number(db.get(`SELECT COUNT(*) AS n FROM userAuditLog WHERE userId = ?`, [id])?.n ?? 0) > 0;
  if (!exists) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const page = Number(request.nextUrl.searchParams.get("page")) || 1;
  return NextResponse.json(listAuditSync(db, id, { page, pageSize: 50 }), { headers: NO_STORE });
}
