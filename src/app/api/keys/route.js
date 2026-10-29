import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List ADMIN API keys (design D15).
//
// Customer keys (any row with a userId) are excluded: they belong to an account,
// are managed on that account's page, and their secrets must never appear in an
// admin listing. The count is reported so the operator knows they exist.
export async function GET() {
  try {
    const all = await getApiKeys();
    const keys = all.filter((key) => key.userId == null);
    const customerKeyCount = all.length - keys.length;
    return NextResponse.json({ keys, customerKeyCount });
  } catch {
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key (optionally with limits/group)
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, {
      groupId: body.groupId ?? null,
      rpm: body.rpm ?? null,
      tpm: body.tpm ?? null,
      budgetUsd: body.budgetUsd ?? null,
      resetWindow: body.resetWindow ?? null,
      expiresAt: body.expiresAt ?? null,
      allowedModels: body.allowedModels ?? null,
    });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      groupId: apiKey.groupId,
      rpm: apiKey.rpm,
      tpm: apiKey.tpm,
      budgetUsd: apiKey.budgetUsd,
      resetWindow: apiKey.resetWindow,
      expiresAt: apiKey.expiresAt,
      allowedModels: apiKey.allowedModels,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to create key" }, { status: 400 });
  }
}

