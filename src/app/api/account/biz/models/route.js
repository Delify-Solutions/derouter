import { NextResponse } from "next/server";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/biz/models — the business models a customer may pick for their
 * bot (`{ id, label }`). The admin owns the list; this is the customer-safe subset
 * of it, so the bot forms do not need the admin settings page.
 */
export async function GET(request) {
  const scope = await withBot(request, { requireBot: false });
  if (scope.response) return scope.response;
  return NextResponse.json({ models: scope.business.businessModels }, { headers: NO_STORE });
}
