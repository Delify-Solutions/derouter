import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { localImageBaseUrl } from "@/lib/storage/localImages.js";
import { buildInstallScript } from "@/lib/skills/installScript.js";

export const dynamic = "force-dynamic";

// GET /api/public/skills/install.sh — the one-line installer.
//
// Public on purpose: it contains no secret, and a customer pipes it into sh
// before they have shown the server anything. The key is checked by the
// catalogue and file endpoints the script then calls.
export async function GET(request) {
  let settings = null;
  try {
    settings = await getSettings();
  } catch {
    /* the origin falls back to the forwarded host */
  }
  const origin = localImageBaseUrl(request, settings);
  return new NextResponse(buildInstallScript(origin), {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
