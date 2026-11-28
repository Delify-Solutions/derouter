import { NextResponse } from "next/server";
import { installPxpipe } from "@/lib/pxpipe/install.js";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { runHealthCheck } from "@/lib/pxpipe/service.js";
import { requireAnyPagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";
// npm install can legitimately take minutes on a cold cache.
export const maxDuration = 300;

// Install (or repair — same operation, reinstalls @latest) then re-run the health check.
export async function POST(request) {
  const denied = await requireAnyPagePermission(request, ["pxpipe", "token-saver"], "edit");
  if (denied) return denied;
  try {
    const info = await installPxpipe();
    unloadPxpipe(); // drop any previously-loaded version so health loads the fresh one
    const health = await runHealthCheck();
    return NextResponse.json({ ...info, health });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
