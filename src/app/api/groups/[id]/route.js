import { NextResponse } from "next/server";
import {
  getKeyGroupById,
  getGroupGuard,
  describeGroupGuard,
  updateKeyGroup,
  deleteKeyGroup,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 409 for a group that customers still depend on. The body carries the numbers so
 * the page can render "<reason> — xem N người dùng" without a second request.
 */
function guardResponse(guard) {
  return NextResponse.json(
    { error: describeGroupGuard(guard), memberCount: guard.memberCount, isDefault: guard.isDefault },
    { status: 409, headers: NO_STORE }
  );
}

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const group = await getKeyGroupById(id);
    if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404, headers: NO_STORE });
    const guard = await getGroupGuard(id);
    return NextResponse.json(
      { group: { ...group, memberCount: guard.memberCount, isDefault: guard.isDefault } },
      { headers: NO_STORE }
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const result = await updateKeyGroup(id, body);
    if (result === null) return NextResponse.json({ error: "Group not found" }, { status: 404, headers: NO_STORE });
    // A refused deactivation returns the guard instead of a row; it is not an
    // exception, because nothing went wrong with the request itself.
    if (result?.ok === false) return guardResponse(result.guard);
    return NextResponse.json({ group: result }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const result = await deleteKeyGroup(id);
    if (result === false) return NextResponse.json({ error: "Group not found" }, { status: 404, headers: NO_STORE });
    if (result?.ok === false) return guardResponse(result.guard);
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500, headers: NO_STORE });
  }
}
