import { NextResponse } from "next/server";
import {
  getSkillById,
  updateSkill,
  deleteSkill,
  skillInputError,
} from "@/lib/db/repos/skillsRepo.js";

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

// GET /api/skills/{id} — one skill with its body, for the admin edit form.
// `id` is the row id the admin list carries; the customer side addresses by slug.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const skill = await getSkillById(id);
    if (!skill) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });
    return NextResponse.json({ skill }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được skill" }, { status: 500 });
  }
}

// PATCH /api/skills/{id} — change any subset of the fields.
export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await readJson(request);
    if (!body) return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });

    // Merge-then-validate happens inside the repo so a partial patch is
    // validated against the row it produces, not against the patch alone.
    const current = await getSkillById(id);
    if (!current) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });

    const merged = { ...current, ...body, slug: String(body.slug ?? "").trim() || current.slug };
    const problem = skillInputError(merged);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const updated = await updateSkill(id, body);
    if (!updated) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });
    return NextResponse.json({ ok: true, ...updated });
  } catch (error) {
    const message = error?.message || "Không cập nhật được skill";
    const status = /đã được dùng|không được|tối đa|Slug/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE /api/skills/{id} — remove the row. A customer who already downloaded a
// copy keeps it; only the published listing goes away.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteSkill(id);
    if (!removed) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Không xoá được skill" }, { status: 500 });
  }
}
