import { NextResponse } from "next/server";
import { deleteApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

/** DELETE /api/account/biz/bots/[id]/keys/[keyId] — revoke one key of this bot. */
export async function DELETE(request, { params }) {
  const { id, keyId } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  // The key must belong to THIS bot: a key of another bot reads as missing.
  const key = scope.db.get(`SELECT id, name FROM apiKeys WHERE id = ? AND botId = ?`, [keyId, id]);
  if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });

  if (!deleteApiKeySync(scope.db, keyId)) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_key_delete",
    details: { botId: id, keyId, name: key.name ?? null },
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
