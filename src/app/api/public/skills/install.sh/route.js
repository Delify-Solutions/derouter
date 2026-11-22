import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { localImageBaseUrl } from "@/lib/storage/localImages.js";
import { buildInstallScript } from "@/lib/skills/installScript.js";
import { listPublishedBundles } from "@/lib/db/repos/skillBundlesRepo.js";

export const dynamic = "force-dynamic";

// GET /api/public/skills/install.sh — the one-line installer.
//
// Public on purpose: it contains no secret, and a customer pipes it into sh
// before they have shown the server anything. The key is checked by the
// catalogue and file endpoints the script then calls.
//
// Every published bundle's engine data is baked into this one shared script
// (there is no per-customer variant): --engine then fetches and registers
// whichever of those a given machine's agents can use, same as every skill
// already does through the catalogue.
export async function GET(request) {
  let settings = null;
  try {
    settings = await getSettings();
  } catch {
    /* the origin falls back to the forwarded host */
  }
  let bundles = [];
  try {
    bundles = await listPublishedBundles();
  } catch {
    /* no bundle published yet, or the table isn't there on an old DB: --engine
       just has nothing to do, same as before bundles existed */
  }
  const origin = localImageBaseUrl(request, settings);
  return new NextResponse(buildInstallScript(origin, bundles), {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
