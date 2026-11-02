import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getApiKeys, createApiKey, getKeysLastUsedAt } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getAdapter } from "@/lib/db/driver.js";
import { listBindablePlansSync, resolveKeyPlanInputSync } from "@/lib/db/repos/accountPlansRepo.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { fireAndForget, messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const db = await getAdapter();
  const held = listBindablePlansSync(db, session.userId);
  const heldIds = new Set(held.map((plan) => plan.id));
  // A pinned plan may have lapsed since: its name still comes from the plans table
  // so the row can say which plan the key waits for.
  const pinnedNames = new Map(
    db.all(`SELECT id, name FROM plans`).map((plan) => [plan.id, plan.name])
  );

  const owned = (await getApiKeys()).filter((key) => key.userId === session.userId);
  // Best effort: a failed lookup leaves "last used" blank instead of failing the list.
  let lastUsed = {};
  try {
    lastUsed = await getKeysLastUsedAt(owned);
  } catch {
    lastUsed = {};
  }
  const keys = owned.map((key) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    isActive: key.isActive,
    createdAt: key.createdAt,
    lastUsedAt: lastUsed[key.id] ?? null,
    groupId: key.groupId ?? null,
    // null = the key may be paid by any plan; otherwise plans.id it is pinned to.
    planId: key.planId ?? null,
    planName: key.planId ? pinnedNames.get(key.planId) ?? null : null,
    // False when the pinned plan has no live purchase: the key cannot pay until
    // the plan is renewed or the key is moved.
    planHeld: key.planId ? heldIds.has(key.planId) : true,
    // Never the full secret in the list: it is sent only on an explicit show,
    // copy or open-usage press (POST /api/account/keys/{id}/secret).
  }));

  return NextResponse.json(
    { keys, plans: held.map(({ id, name, code, rpm, tpm }) => ({ id, name, code, rpm, tpm })) },
    { headers: NO_STORE }
  );
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

  const db = await getAdapter();
  const binding = resolveKeyPlanInputSync(db, session.userId, body?.planId);
  if (!binding.ok) {
    return NextResponse.json({ error: binding.error }, { status: 400, headers: NO_STORE });
  }

  try {
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, { userId: session.userId, planId: binding.planId });
    await recordActivity(request, {
      userId: session.userId,
      action: "key_create",
      details: { keyId: apiKey.id, name: apiKey.name, planId: apiKey.planId ?? null },
    });
    fireAndForget(notifyCustomer(session.userId, "security", messages.apiKeyCreated({ name: apiKey.name })));
    return NextResponse.json(
      {
        key: {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          isActive: apiKey.isActive,
          createdAt: apiKey.createdAt,
          planId: apiKey.planId ?? null,
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
