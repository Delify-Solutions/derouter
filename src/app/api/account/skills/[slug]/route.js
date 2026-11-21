import { NextResponse } from "next/server";
import { getSkillBySlug } from "@/lib/db/repos/skillsRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

// GET /api/account/skills/{slug} — one published skill with its body.
// The detail panel fetches this when the customer asks to read or copy the file
// rather than download it.
export async function GET(request, { params }) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { slug } = await params;
    const skill = await getSkillBySlug(slug, { publishedOnly: true });
    if (!skill) return NextResponse.json({ error: "Không tìm thấy skill" }, { status: 404 });
    return NextResponse.json({ skill }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được skill" }, { status: 500 });
  }
}
