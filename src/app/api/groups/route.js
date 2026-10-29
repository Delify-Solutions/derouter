import { NextResponse } from "next/server";
import {
  getKeyGroups,
  createKeyGroup,
  getGroupMemberCounts,
  toBool,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    // memberCount / isDefault drive the groups page (the `Mặc định` badge and the
    // "protected" hint), so they ship with the list instead of N follow-up calls.
    const [groups, { counts, defaultGroupId }] = await Promise.all([getKeyGroups(), getGroupMemberCounts()]);
    const enriched = groups.map((group) => {
      const meta = counts.get(group.id);
      return {
        ...group,
        memberCount: meta?.memberCount ?? 0,
        // The resolved default id is authoritative: a default group with no members
        // has no count row, and it must still be labelled `Mặc định`.
        isDefault: meta?.isDefault === true || group.id === defaultGroupId,
      };
    });
    return NextResponse.json({ groups: enriched }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const group = await createKeyGroup({
      name: body.name,
      isActive: toBool(body.isActive),
      allowedModels: body.allowedModels ?? null,
      priceOverrides: body.priceOverrides ?? null,
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
