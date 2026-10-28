import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const keys = (await getApiKeys())
    .filter((key) => key.userId === session.userId)
    .map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      isActive: key.isActive,
      createdAt: key.createdAt,
      groupId: key.groupId ?? null,
      // Never the full secret: it is shown once, at creation.
    }));

  return NextResponse.json({ keys }, { headers: NO_STORE });
}

export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400, headers: NO_STORE });
  }
  if (name.length > 80) {
    return NextResponse.json({ error: "Name is too long" }, { status: 400, headers: NO_STORE });
  }

  try {
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, { userId: session.userId });
    return NextResponse.json(
      {
        key: {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          isActive: apiKey.isActive,
          createdAt: apiKey.createdAt,
        },
        // The only time the plaintext value ever leaves the server.
        secret: apiKey.key,
      },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Could not create the key" },
      { status: 400, headers: NO_STORE }
    );
  }
}
