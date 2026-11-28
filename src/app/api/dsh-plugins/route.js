import { NextResponse } from "next/server";
import {
  listPlugins,
  createPlugin,
  pluginInputError,
} from "@/lib/db/repos/dshPluginsRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

// GET /api/dsh-plugins — every plugin the admin has, published or not.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const audience = searchParams.get("audience");
    if (audience) filter.audience = audience;
    const published = searchParams.get("published");
    if (published === "1" || published === "true") filter.isPublished = true;
    if (published === "0" || published === "false") filter.isPublished = false;

    const plugins = await listPlugins(filter);
    return NextResponse.json({ plugins }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách plugin" }, { status: 500 });
  }
}

// POST /api/dsh-plugins — publish a plugin row.
export async function POST(request) {
  const denied = await requirePagePermission(request, "dsh-plugins", "edit");
  if (denied) return denied;
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
    const problem = pluginInputError(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const actor = await getAdminActor(request);
    const created = await createPlugin(body, { createdBy: actor });
    return NextResponse.json({ ok: true, ...created }, { status: 201 });
  } catch (error) {
    const message = error?.message || "Không tạo được plugin";
    const status = /đã được dùng|không được|tối đa|Slug|hợp lệ/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
