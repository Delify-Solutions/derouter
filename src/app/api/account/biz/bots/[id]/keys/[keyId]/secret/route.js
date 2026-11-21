import { NextResponse } from "next/server";
import { getOwnedKeySecret } from "@/lib/account/keySecret";
import { hitLimit } from "@/lib/auth/actionLimiter";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";
const SECRET_HEADERS = { ...NO_STORE, Pragma: "no-cache" };
// Same ceiling as the API key page: a person reveals a key a few times, a script
// draining keys from a stolen session does it thousands of times.
const SECRET_LIMIT = { limit: 60, windowMs: 60_000 };

/**
 * POST /api/account/biz/bots/[id]/keys/[keyId]/secret — the raw key, owner only,
 * no-store, 60 times a minute per customer (spec business-bots "Bot keys").
 */
export async function POST(request, { params }) {
  const { id, keyId } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  const gate = hitLimit(`account-key-secret:${scope.session.userId}`, SECRET_LIMIT);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { ...SECRET_HEADERS, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const key = scope.db.get(`SELECT id FROM apiKeys WHERE id = ? AND botId = ?`, [keyId, id]);
  if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });

  const secret = await getOwnedKeySecret(scope.session.userId, keyId, { allowBotKey: true });
  if (!secret) return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });

  // Never log the response: it is the secret.
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_key_reveal",
    details: { botId: id, keyId },
  });
  return NextResponse.json({ secret }, { headers: SECRET_HEADERS });
}
