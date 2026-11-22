import { NextResponse } from "next/server";
import { listPublishedSkills } from "@/lib/db/repos/skillsRepo.js";
import { listPublishedBundles } from "@/lib/db/repos/skillBundlesRepo.js";
import { resolveSkillKey, SKILL_KEY_DENIED } from "@/lib/skills/skillKey.js";

export const dynamic = "force-dynamic";

// A tab, CR or LF would break the one-line-per-skill format the shell script reads,
// and any other control character (an ESC sequence) would reach the customer's
// terminal when the script lists the catalogue.
const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
// `read` with a tab IFS merges empty fields, so an empty one is sent as "-".
const field = (value) => oneLine(value) || "-";

// GET /api/public/skills/catalog — what this key's owner may install, as
// tab-separated lines: slug, file name, version, agents (a comma list, or "all"),
// name, bundle slug (or "-" for a standalone skill).
//
// Plain text rather than JSON so the installer needs nothing but curl and sh.
// Only published, customer-audience skills are ever listed (skillsRepo). The
// bundle column is what `--bundle <slug>` expands into its member skills with,
// instead of the customer typing every one of them.
export async function GET(request) {
  try {
    if (!(await resolveSkillKey(request))) {
      return NextResponse.json(SKILL_KEY_DENIED, { status: 401 });
    }
    const [skills, bundles] = await Promise.all([listPublishedSkills(), listPublishedBundles()]);
    const bundleSlugById = new Map(bundles.map((b) => [b.id, b.slug]));
    const lines = skills.map((skill) =>
      [
        skill.slug,
        skill.fileName,
        field(skill.version),
        skill.allAgents ? "all" : skill.targets.join(","),
        oneLine(skill.name),
        field(skill.bundleId ? bundleSlugById.get(skill.bundleId) : null),
      ].join("\t")
    );
    return new NextResponse(lines.length ? `${lines.join("\n")}\n` : "", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách skill" }, { status: 500 });
  }
}
