import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { publicLoginSettings } from "@/lib/auth/publicSettings.js";

// Public (no session; see dashboardGuard): the login flags only, no host names.
export async function GET() {
  try {
    return NextResponse.json(publicLoginSettings(await getSettings()));
  } catch {
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}
