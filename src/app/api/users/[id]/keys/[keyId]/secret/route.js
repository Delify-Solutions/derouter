import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { revealKeySecretSync } from "@/lib/billing/adminActions.js";
import { hitLimit } from "@/lib/auth/actionLimiter";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
// An admin copies a key a few times to test with it; a stolen admin session
// draining every customer's key does it thousands of times. The bucket is the
// admin identity, so without SSO every password session shares one "admin:admin"
// bucket: the limit is per operator, not per browser.
const SECRET_LIMIT = { limit: 30, windowMs: 60_000 };

/**
 * POST /api/users/[id]/keys/[keyId]/secret — hand one customer key to the admin
 * console so the admin can copy it and test with it (spec admin-user-management).
 *
 * POST, not GET: a link prefetch or a cached response must never carry the
 * secret. Every reveal writes a `key_revealed` entry to the account's audit log
 * (admin `Nhật ký` tab), so it shows who copied which key and when.
 *
 * Never log the response: it is the secret.
 */
export async function POST(request, { params }) {
  const { id, keyId } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const actor = await getAdminActor(request);
  const gate = hitLimit(`admin-key-secret:${actor}`, SECRET_LIMIT);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Thao tác quá nhanh, thử lại sau" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const db = await getAdapter();
  const secret = db.transaction(() => revealKeySecretSync(db, id, keyId, { actor }));
  if (!secret) {
    return NextResponse.json({ error: "Không tìm thấy API key" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ secret }, { headers: NO_STORE });
}
