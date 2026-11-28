import { NextResponse } from "next/server";
import { getErrorLogConfig, setErrorLogConfig } from "../../../../lib/db/repos/errorLogsRepo.js";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getErrorLogConfig());
}

// PUT { enabled, storePrompt, retentionDays, maxRows, maxBodyKB } — any subset; values are clamped.
export async function PUT(request) {
  const denied = await requirePagePermission(request, "errors", "edit");
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  return NextResponse.json(await setErrorLogConfig(body));
}
