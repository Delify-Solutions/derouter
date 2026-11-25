import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";

// GET /api/providers/[id]/reveal-key - Decrypted secret for one connection, shown
// to the admin on demand (never included in the list/detail GET responses).
export async function GET(request, { params }) {
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
