import { NextResponse } from "next/server";
import { listPublishedPlugins, incrementPluginInstall } from "@/lib/db/repos/dshPluginsRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

// GET /api/account/dsh-plugins — the DSH plugins this customer may install.
//
// Published, customer-audience rows only. Unlike a skill, a plugin is not a file the
// customer's browser downloads: the page shows the install command and the customer
// runs it themselves, so nothing here streams source.
export async function GET(request) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const plugins = await listPublishedPlugins();
    return NextResponse.json({ plugins }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách plugin" }, { status: 500 });
  }
}

// POST /api/account/dsh-plugins — count a "copy install command" click.
// Body: { slug }. Best-effort analytics: a failed count never fails the request.
export async function POST(request) {
  try {
    const session = await resolveAccountUser(request);
    if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    if (!slug) return NextResponse.json({ error: "Thiếu slug" }, { status: 400 });

    const plugins = await listPublishedPlugins();
    const match = plugins.find((plugin) => plugin.slug === slug);
    if (!match) return NextResponse.json({ error: "Không tìm thấy plugin" }, { status: 404 });

    await incrementPluginInstall(match.id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Không ghi nhận được" }, { status: 500 });
  }
}
