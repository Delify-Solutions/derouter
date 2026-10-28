import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getApiKeyById, deleteApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function DELETE(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Key id is required" }, { status: 400, headers: NO_STORE });
  }

  const key = await getApiKeyById(id);
  // A key that belongs to someone else is reported as missing, not forbidden:
  // the id space is not a directory.
  if (!key || key.userId !== session.userId) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }

  const deleted = await deleteApiKey(id);
  if (!deleted) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
