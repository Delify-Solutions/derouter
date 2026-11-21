import { NextResponse } from "next/server";
import { getSkillBySlug, incrementSkillDownload } from "@/lib/db/repos/skillsRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

/**
 * Content-Disposition for a download. The filename comes from a row the admin
 * controls, so it is sanitised here rather than trusted: no path separators, no
 * quotes, no control characters. Anything stripped falls back to SKILL.md.
 */
function safeFileName(input) {
  const raw = String(input ?? "").trim();
  const cleaned = raw
    .replace(/[/\\]/g, "")           // a filename, not a path
    .replace(/["\r\n\t]/g, "")       // header-injection characters
    .replace(/[^\x20-\x7e]/g, "")      // a header value is ASCII; anything else makes Headers throw
    .replace(/^\.+/, "")             // no leading dots ("..")
    .slice(0, 120);
  return cleaned || "SKILL.md";
}

// GET /api/account/skills/{slug}/download — the markdown file itself.
//
// The body is returned as an attachment so the browser saves it instead of
// rendering it, and the count is incremented best-effort: a customer's download
// must not fail because a counter did not update.
export async function GET(request, { params }) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { slug } = await params;
    const skill = await getSkillBySlug(slug, { publishedOnly: true });
    if (!skill) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });

    incrementSkillDownload(skill.id).catch(() => {});

    const fileName = safeFileName(skill.fileName);
    return new NextResponse(skill.body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Skill-Slug": skill.slug,
        "X-Skill-Version": skill.version || "",
      },
    });
  } catch {
    return NextResponse.json({ error: "Không tải được skill" }, { status: 500 });
  }
}
