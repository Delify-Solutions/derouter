import { NextResponse } from "next/server";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";
import { requireAnyPagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST(request) {
  const denied = await requireAnyPagePermission(request, ["pxpipe", "token-saver"], "edit");
  if (denied) return denied;
  try {
    unloadPxpipe();
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
