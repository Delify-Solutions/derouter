import { NextResponse } from "next/server";
import { listGuardEventsSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";

export const dynamic = "force-dynamic";

/**
 * GET — the bot's latest 100 guard events, newest first, owner only
 * (spec business-guard "Guard event log").
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;
  return NextResponse.json({ events: listGuardEventsSync(scope.db, id, 100) }, { headers: NO_STORE });
}
