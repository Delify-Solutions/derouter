import { NextResponse } from "next/server";
import { runHealthCheck } from "@/lib/pxpipe/service.js";
import { requireAnyPagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

async function handle() {
  try {
    const result = await runHealthCheck();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ healthy: false, checks: [], error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  const denied = await requireAnyPagePermission(request, ["pxpipe", "token-saver"], "edit");
  if (denied) return denied;
  return handle();
}

// GET mirrors POST so the card can probe on page load without a mutation call —
// a read-only health check, so it stays reachable with plain `view` permission.
export const GET = handle;
