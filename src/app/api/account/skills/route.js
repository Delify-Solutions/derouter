import { NextResponse } from "next/server";
import { listPublishedSkills, listSkillCategories } from "@/lib/db/repos/skillsRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

// GET /api/account/skills — the skills this customer may take.
//
// Only published, customer-audience rows reach here, and bodies stay out of the
// list: the catalogue is metadata, the body is what /download returns. An
// internal skill is not "hidden by the page" — it never leaves the repository.
export async function GET(request) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const [skills, categories] = await Promise.all([
      listPublishedSkills(),
      listSkillCategories(),
    ]);
    return NextResponse.json(
      { skills, categories },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách skill" }, { status: 500 });
  }
}
