import { NextResponse } from "next/server";
import { listPublishedSkills, listSkillCategories } from "@/lib/db/repos/skillsRepo.js";
import { listPublishedBundles } from "@/lib/db/repos/skillBundlesRepo.js";
import { checkBundleUpdate } from "@/lib/skills/bundleUpdateCheck.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

// GET /api/account/skills — the skills (and the bundles they may belong to) this
// customer may take.
//
// Only published, customer-audience rows reach here, and bodies stay out of the
// list: the catalogue is metadata, the body is what /download returns. An
// internal skill is not "hidden by the page" — it never leaves the repository.
// A bundle is included only when at least one of its skills is actually in this
// list — a bundle published with no published skill of its own has nothing for
// the page to show next to.
export async function GET(request) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const [skills, categories, allBundles] = await Promise.all([
      listPublishedSkills(),
      listSkillCategories(),
      listPublishedBundles(),
    ]);
    const bundleIdsInUse = new Set(skills.map((s) => s.bundleId).filter(Boolean));
    const inUse = allBundles.filter((b) => bundleIdsInUse.has(b.id));
    // Cached per bundle (bundleUpdateCheck.js, 1h), so this never costs a live call
    // on most page loads — only the first one in an hour per bundle does.
    const bundles = await Promise.all(
      inUse.map(async (bundle) => ({ ...bundle, ...(await checkBundleUpdate(bundle)) }))
    );
    return NextResponse.json(
      { skills, categories, bundles },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách skill" }, { status: 500 });
  }
}
