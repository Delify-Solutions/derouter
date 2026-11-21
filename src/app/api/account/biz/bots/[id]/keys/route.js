import { NextResponse } from "next/server";
import { createApiKey } from "@/lib/db/repos/apiKeysRepo.js";
import { MAX_KEYS_PER_BOT } from "@/lib/db/repos/bizBotsRepo.js";
import { badRequest, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { BOT_CHAT_KEY_NAME } from "@/lib/account/chatKey";

export const dynamic = "force-dynamic";

/** A key row as the bot's key list shows it: never the secret. */
function publicKey(row) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/** GET /api/account/biz/bots/[id]/keys — prefixes only, never a secret. */
export async function GET(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;
  // The playground's own key ("Chat thử") is infrastructure, not something the
  // customer manages here (spec business-bots "Playground").
  const rows = scope.db.all(
    `SELECT * FROM apiKeys WHERE botId = ? AND name != ? ORDER BY createdAt ASC`,
    [id, BOT_CHAT_KEY_NAME]
  );
  return NextResponse.json({ keys: rows.map(publicKey) }, { headers: NO_STORE });
}

/**
 * POST /api/account/biz/bots/[id]/keys — create one bot key. The secret is
 * returned ONCE here; afterwards only the secret endpoint hands it out.
 *
 * A bot key is a normal customer key owned by the bot's owner with `botId` set;
 * it is never pinned to a plan, whatever the caller sends.
 */
export async function POST(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  let body = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    body = {};
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Key chatbot";
  if (name.length > 80) return badRequest("Tên key tối đa 80 ký tự");
  // "Chat thử" is the playground's own key: it is hidden from this list, so a
  // customer key under that name would be invisible AND would be picked up by the
  // playground instead of a real key.
  if (name === BOT_CHAT_KEY_NAME) return badRequest("Tên này dành riêng cho chat thử của bot");

  // Only the keys the customer can SEE count against the limit; the hidden
  // playground key would otherwise cost them one of their ten.
  const count = Number(
    scope.db.get(`SELECT COUNT(*) AS n FROM apiKeys WHERE botId = ? AND name != ?`, [id, BOT_CHAT_KEY_NAME])?.n
  ) || 0;
  if (count >= MAX_KEYS_PER_BOT) return badRequest(`Mỗi bot tối đa ${MAX_KEYS_PER_BOT} key`);

  const machineId = await getConsistentMachineId();
  const created = await createApiKey(name, machineId, { userId: scope.session.userId, botId: id });
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_key_create",
    details: { botId: id, keyId: created.id, name: created.name },
  });
  return NextResponse.json(
    { key: publicKey(created), secret: created.key },
    { status: 201, headers: NO_STORE }
  );
}
