import { NextResponse } from "next/server";
import { getSkillBySlug, incrementSkillDownload } from "@/lib/db/repos/skillsRepo.js";
import { resolveSkillKey, SKILL_KEY_DENIED } from "@/lib/skills/skillKey.js";

export const dynamic = "force-dynamic";

// GET /api/public/skills/file/{slug} — the skill's markdown, for the installer.
// Same visibility rule as the account download: published and customer-audience
// only, so an internal or draft skill is a 404 here too. Counts as a download.
export async function GET(request, { params }) {
  try {
    if (!(await resolveSkillKey(request))) {
      return NextResponse.json(SKILL_KEY_DENIED, { status: 401 });
    }
    const { slug } = await params;
    const skill = await getSkillBySlug(slug, { publishedOnly: true });
    if (!skill) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });

    incrementSkillDownload(skill.id).catch(() => {});
    return new NextResponse(skill.body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Skill-Version": skill.version || "",
      },
    });
  } catch {
    return NextResponse.json({ error: "Không tải được skill" }, { status: 500 });
  }
}
