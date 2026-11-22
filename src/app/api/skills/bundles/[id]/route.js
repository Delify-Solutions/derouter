import { NextResponse } from "next/server";
import {
  getBundleById,
  updateBundle,
  deleteBundle,
  bundleInputError,
} from "@/lib/db/repos/skillBundlesRepo.js";

export const dynamic = "force-dynamic";

/** The JSON object in the request body, or null when it is missing, malformed or not an object. */
async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// GET /api/skills/bundles/{id} — one bundle, for the admin edit form.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const bundle = await getBundleById(id);
    if (!bundle) return NextResponse.json({ error: "Không tìm thấy bundle" }, { status: 404 });
    return NextResponse.json({ bundle }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được bundle" }, { status: 500 });
  }
}

// PATCH /api/skills/bundles/{id} — change any subset of the fields.
export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    if (!body) return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });

    const current = await getBundleById(id);
    if (!current) return NextResponse.json({ error: "Không tìm thấy bundle" }, { status: 404 });

    const merged = { ...current, ...body, slug: String(body.slug ?? "").trim() || current.slug };
    const problem = bundleInputError(merged);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const updated = await updateBundle(id, body);
    if (!updated) return NextResponse.json({ error: "Không tìm thấy bundle" }, { status: 404 });
    return NextResponse.json({ ok: true, ...updated });
  } catch (error) {
    const message = error?.message || "Không cập nhật được bundle";
    const status = /đã được dùng|không được|tối đa|Slug|không hợp lệ/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE /api/skills/bundles/{id} — remove the bundle row. Detaches, never
// cascades: every skill that pointed at it keeps existing with no bundle.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteBundle(id);
    if (!removed) return NextResponse.json({ error: "Không tìm thấy bundle" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Không xoá được bundle" }, { status: 500 });
  }
}
