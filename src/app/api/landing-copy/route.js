import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { LANDING_COPY_DEFAULTS, mergeLandingCopy } from "@/lib/db/repos/contentRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Landing copy lives in the settings blob under `landingCopy`. Kept separate
 * from /api/settings so a copy edit cannot accidentally mass-assign an unrelated
 * setting, and so this endpoint's contract is exactly "these string fields".
 */
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json(
      { copy: mergeLandingCopy(settings.landingCopy), fields: LANDING_COPY_DEFAULTS },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được nội dung" }, { status: 500, headers: NO_STORE });
  }
}

export async function PATCH(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  // Whitelist by shape: only keys the renderer knows, only strings (plus the one
  // boolean). Anything else is dropped rather than stored, so a typo in the admin
  // form cannot silently add dead data that survives every future save.
  const next = {};
  const incoming = body?.copy && typeof body.copy === "object" ? body.copy : {};
  for (const key of Object.keys(LANDING_COPY_DEFAULTS)) {
    if (key === "bannerEnabled") {
      if (incoming[key] !== undefined) next[key] = Boolean(incoming[key]);
      continue;
    }
    if (typeof incoming[key] === "string") next[key] = incoming[key];
  }

  try {
    const settings = await getSettings();
    const merged = mergeLandingCopy({ ...(settings.landingCopy || {}), ...next });
    await updateSettings({ landingCopy: merged });
    return NextResponse.json({ copy: merged }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không lưu được nội dung" }, { status: 500, headers: NO_STORE });
  }
}
