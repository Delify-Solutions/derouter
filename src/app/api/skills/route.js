import { NextResponse } from "next/server";
import {
  listSkills,
  createSkill,
  skillInputError,
} from "@/lib/db/repos/skillsRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";

// GET /api/skills — every skill the admin has, with or without a body.
// Bodies are omitted here: the admin list only needs the metadata, and the edit
// form fetches the one row it is about to change.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {};
    const audience = searchParams.get("audience");
    if (audience) filter.audience = audience;
    const category = searchParams.get("category");
    if (category) filter.category = category;
    const published = searchParams.get("published");
    if (published === "1" || published === "true") filter.isPublished = true;
    if (published === "0" || published === "false") filter.isPublished = false;

    const [skills, categories] = await Promise.all([
      listSkills(filter),
      listSkills({}).then((rows) => {
        // Category labels derived from the rows, not a fixed enum: an admin who
        // types a new category gets a new tab without a schema change.
        const counted = new Map();
        for (const row of rows) {
          if (!row.category) continue;
          counted.set(row.category, (counted.get(row.category) || 0) + 1);
        }
        return [...counted.entries()]
          .map(([name, count]) => ({ category: name, count }))
          .sort((a, b) => a.category.localeCompare(b.category));
      }),
    ]);

    return NextResponse.json(
      { skills, categories },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách skill" }, { status: 500 });
  }
}

// POST /api/skills — publish a new skill.
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
    const problem = skillInputError(body);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const actor = await getAdminActor(request);
    const created = await createSkill(body, { createdBy: actor });
    return NextResponse.json({ ok: true, ...created }, { status: 201 });
  } catch (error) {
    // Duplicate slug arrives as a thrown Error from the repo, already in
    // Vietnamese: surface it as a 400 rather than a 500.
    const message = error?.message || "Không tạo được skill";
    const status = /đã được dùng|không được|tối đa|Slug/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
