import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";
import { requirePagePermission } from "@/lib/auth/adminAccess";

// Shutdown app to release file locks for manual update
export async function POST(request) {
  const denied = await requirePagePermission(request, "profile", "edit");
  if (denied) return denied;
  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
