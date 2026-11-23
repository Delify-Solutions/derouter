import { NextResponse } from "next/server";
import {
  listBundles,
  createBundle,
  bundleInputError,
} from "@/lib/db/repos/skillBundlesRepo.js";
import { checkBundleUpdate } from "@/lib/skills/bundleUpdateCheck.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";

// GET /api/skills/bundles — every bundle the admin has.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const audience = searchParams.get("audience");
    if (audience) filter.audience = audience;
    const published = searchParams.get("published");
    if (published === "1" || published === "true") filter.isPublished = true;
    if (published === "0" || published === "false") filter.isPublished = false;

    const rows = await listBundles(filter);
    const bundles = await Promise.all(
      rows.map(async (bundle) => ({ ...bundle, ...(await checkBundleUpdate(bundle)) }))
    );
    return NextResponse.json({ bundles }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách bundle" }, { status: 500 });
  }
}

// POST /api/skills/bundles — create one bundle, normally right before importing
// the skill files it groups (see RepoImportModal.js's bundle mode).
export async function POST(request) {
  try {
    let body = null;
    try {
      body = await request.json();
    } catch {
      /* answered below */
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
    }
    const problem = bundleInputError(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const actor = await getAdminActor(request);
    const created = await createBundle(body, { createdBy: actor });
    return NextResponse.json({ ok: true, ...created }, { status: 201 });
  } catch (error) {
    const message = error?.message || "Không tạo được bundle";
    const status = /đã được dùng|không được|tối đa|Slug|không hợp lệ/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
