import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { requirePagePermission } from "@/lib/auth/adminAccess";

// GET /api/providers/[id]/reveal-key - Decrypted secret for one connection, shown
// to the admin on demand (never included in the list/detail GET responses).
//
// Gated on "edit" (not "view"): revealing a decrypted upstream credential is at
// least as sensitive as editing the connection, same level the analogous
// customer-key reveal (POST /api/users/[id]/keys/[keyId]/secret) requires — a
// member scoped to view-only on "providers" must not be able to extract a live
// secret through this route just because the page itself is viewable.
export async function GET(request, { params }) {
  const denied = await requirePagePermission(request, "providers", "edit");
  if (denied) return denied;
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const secret = connection.authType === "cookie"
      ? connection.providerSpecificData?.cookie || ""
      : connection.apiKey || "";

    return NextResponse.json({ apiKey: secret });
  } catch {
    return NextResponse.json({ error: "Failed to reveal key" }, { status: 500 });
  }
}
