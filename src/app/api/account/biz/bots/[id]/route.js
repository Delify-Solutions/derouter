import { NextResponse } from "next/server";
import { deleteBotSync, getOwnedBotSync, updateBotSync } from "@/lib/db/repos/bizBotsRepo.js";
import { badRequest, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

/** GET /api/account/biz/bots/[id] — one bot of this customer, else 404. */
export async function GET(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;
  return NextResponse.json({ bot: scope.bot }, { headers: NO_STORE });
}

/**
 * PATCH /api/account/biz/bots/[id] — edit. Works after the business plan
 * expires: an existing bot keeps running (spec "Updating or deleting an existing
 * bot SHALL NOT require a live business plan").
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const result = scope.db.transaction(() =>
    updateBotSync(scope.db, id, body ?? {}, { businessModelIds: scope.businessModelIds })
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_bot_update",
    details: { botId: id, name: result.bot.name },
  });
  return NextResponse.json({ bot: result.bot }, { headers: NO_STORE });
}

/** DELETE /api/account/biz/bots/[id] — the bot, its keys, documents, chunks and events. */
export async function DELETE(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  if (!deleteBotSync(scope.db, id)) return NextResponse.json({ error: "Bot not found" }, { status: 404, headers: NO_STORE });
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_bot_delete",
    details: { botId: id, name: scope.bot.name },
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
