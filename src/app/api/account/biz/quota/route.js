import { NextResponse } from "next/server";
import { quotaSync } from "@/lib/db/repos/bizBotsRepo.js";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/biz/quota — the quota line the customer area renders:
 * `{ hasBusinessPlan, maxBots, botCount, maxKbBytes, kbBytesUsed }`
 * (spec business-bots "Business quota comes from live business purchases").
 */
export async function GET(request) {
  const scope = await withBot(request, { requireBot: false });
  if (scope.response) return scope.response;
  return NextResponse.json(quotaSync(scope.db, scope.session.userId), { headers: NO_STORE });
}
