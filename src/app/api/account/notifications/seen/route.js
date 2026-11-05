import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { markInboxSeenSync } from "@/lib/notify/inbox.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** POST /api/account/notifications/seen — `{ upTo }` (the `asOf` of the list shown): everything up to it is read. */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const upTo = typeof body?.upTo === "string" && !Number.isNaN(Date.parse(body.upTo)) ? new Date(body.upTo).toISOString() : null;
  const db = await getAdapter();
  markInboxSeenSync(db, session.userId, { upTo });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
