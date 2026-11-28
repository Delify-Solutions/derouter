import { NextResponse } from "next/server";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";
import { requireAnyPagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

// "Stop" in library mode = drop the in-process module; requests fail open to
// uncompressed passthrough until it is started again.
export async function POST(request) {
  const denied = await requireAnyPagePermission(request, ["pxpipe", "token-saver"], "edit");
  if (denied) return denied;
  try {
    const wasLoaded = unloadPxpipe();
    return NextResponse.json({ stopped: wasLoaded, ...getPxpipeStatus() });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
