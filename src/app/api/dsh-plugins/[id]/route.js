import { NextResponse } from "next/server";
import {
  getPluginById,
  updatePlugin,
  deletePlugin,
  pluginInputError,
} from "@/lib/db/repos/dshPluginsRepo.js";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

// GET /api/dsh-plugins/{id} — one plugin, for the admin edit form.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const plugin = await getPluginById(id);
    if (!plugin) return NextResponse.json({ error: "Không tìm thấy plugin" }, { status: 404 });
    return NextResponse.json({ plugin }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được plugin" }, { status: 500 });
  }
}

// PATCH /api/dsh-plugins/{id} — change any subset of the fields.
export async function PATCH(request, { params }) {
  const denied = await requirePagePermission(request, "dsh-plugins", "edit");
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
    }

    const current = await getPluginById(id);
    if (!current) return NextResponse.json({ error: "Không tìm thấy plugin" }, { status: 404 });

    // Merge before validating: a patch that touches only the summary must not fail
    // because the package name is absent from the payload.
    const merged = { ...current, ...body, slug: body.slug ?? current.slug };
    const problem = pluginInputError(merged);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const updated = await updatePlugin(id, body);
    if (!updated) return NextResponse.json({ error: "Không tìm thấy plugin" }, { status: 404 });
    return NextResponse.json({ ok: true, ...updated });
  } catch (error) {
    const message = error?.message || "Không cập nhật được plugin";
    const status = /đã được dùng|không được|tối đa|Slug|hợp lệ/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE /api/dsh-plugins/{id}
export async function DELETE(request, { params }) {
  const denied = await requirePagePermission(request, "dsh-plugins", "delete");
  if (denied) return denied;
  try {
    const { id } = await params;
    const removed = await deletePlugin(id);
    if (!removed) return NextResponse.json({ error: "Không tìm thấy plugin" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Không xoá được plugin" }, { status: 500 });
  }
}
