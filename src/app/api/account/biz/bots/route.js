import { NextResponse } from "next/server";
import { createBotSync, listBotsSync } from "@/lib/db/repos/bizBotsRepo.js";
import { badRequest, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";

export const dynamic = "force-dynamic";

/** GET /api/account/biz/bots — this customer's bots, oldest first. */
export async function GET(request) {
  const scope = await withBot(request, { requireBot: false });
  if (scope.response) return scope.response;
  return NextResponse.json({ bots: listBotsSync(scope.db, scope.session.userId) }, { headers: NO_STORE });
}

/**
 * POST /api/account/biz/bots — create one bot.
 * 400 for a field error, 403 when the customer has no live business plan or is
 * over their bot limit (spec business-bots "Bot lifecycle").
 */
export async function POST(request) {
  const scope = await withBot(request, { requireBot: false });
  if (scope.response) return scope.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const result = scope.db.transaction(() =>
    createBotSync(scope.db, scope.session.userId, body ?? {}, {
      businessModelIds: scope.businessModelIds,
    })
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json({ bot: result.bot }, { status: 201, headers: NO_STORE });
}
