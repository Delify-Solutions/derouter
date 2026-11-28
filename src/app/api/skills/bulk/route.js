import { NextResponse } from "next/server";
import { importSkills, patchSkills, deleteSkills, MAX_IMPORT_ITEMS } from "@/lib/db/repos/skillsRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

// POST /api/skills/bulk — add several skills in one request.
// Body: { items: [skill payload, …], mode: "skip" | "update" }.
// Answers 200 with a result per item even when some fail: the page shows each row's
// outcome, and a bad row never blocks the others.
export async function POST(request) {
  const denied = await requirePagePermission(request, "customer-skills", "edit");
  if (denied) return denied;
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* answered below */
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  if (body.items.length === 0) {
    return NextResponse.json({ error: "Chưa có skill nào để thêm" }, { status: 400 });
  }
  if (body.items.length > MAX_IMPORT_ITEMS) {
    return NextResponse.json({ error: `Mỗi lần thêm tối đa ${MAX_IMPORT_ITEMS} skill` }, { status: 400 });
  }
  const mode = body.mode === "update" ? "update" : "skip";

  try {
    const actor = await getAdminActor(request);
    const results = await importSkills(body.items, { mode, createdBy: actor });
    const count = (action) => results.filter((r) => r.action === action).length;
    return NextResponse.json({
      results,
      created: count("created"),
      updated: count("updated"),
      skipped: count("skipped"),
      failed: count("error"),
    });
  } catch {
    return NextResponse.json({ error: "Không thêm được skill" }, { status: 500 });
  }
}

// PATCH /api/skills/bulk — apply the same change to several skills.
// Body: { ids: [...], patch: { targets?, isPublished?, audience?, category? } }.
export async function PATCH(request) {
  const denied = await requirePagePermission(request, "customer-skills", "edit");
  if (denied) return denied;
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* answered below */
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.ids) || !body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  try {
    const results = await patchSkills(body.ids, body.patch);
    return NextResponse.json({
      results,
      updated: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (error) {
    const message = error?.message || "Không cập nhật được skill";
    return NextResponse.json({ error: message }, { status: /Chưa chọn|Không có gì|tối đa/.test(message) ? 400 : 500 });
  }
}

// DELETE /api/skills/bulk — delete several skills at once.
// Body: { ids: [...] }.
export async function DELETE(request) {
  const denied = await requirePagePermission(request, "customer-skills", "delete");
  if (denied) return denied;
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* answered below */
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.ids)) {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400 });
  }
  try {
    const results = await deleteSkills(body.ids);
    return NextResponse.json({
      results,
      deleted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (error) {
    const message = error?.message || "Không xoá được skill";
    return NextResponse.json({ error: message }, { status: /Chưa chọn|tối đa/.test(message) ? 400 : 500 });
  }
}
