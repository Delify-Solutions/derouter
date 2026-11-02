import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getApiKeyById, deleteApiKey, updateApiKey } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveKeyPlanInputSync } from "@/lib/db/repos/accountPlansRepo.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH /api/account/keys/[id] — body `{ planId }`: pin the key to one plan, or send
 * `null` / "all" to let any plan pay for it. Takes effect on the key's next request.
 */
export async function PATCH(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { id } = await params;
  const key = id ? await getApiKeyById(id) : null;
  if (!key || key.userId !== session.userId) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }
  if (!body || !Object.prototype.hasOwnProperty.call(body, "planId")) {
    return NextResponse.json({ error: "planId is required" }, { status: 400, headers: NO_STORE });
  }

  const db = await getAdapter();
  const binding = resolveKeyPlanInputSync(db, session.userId, body.planId);
  if (!binding.ok) {
    return NextResponse.json({ error: binding.error }, { status: 400, headers: NO_STORE });
  }

  const updated = await updateApiKey(id, { planId: binding.planId });
  if (!updated) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }
  await recordActivity(request, {
    userId: session.userId,
    action: "key_update",
    details: { keyId: id, name: key.name ?? null, planId: updated.planId ?? null },
  });
  return NextResponse.json({ ok: true, planId: updated.planId ?? null }, { headers: NO_STORE });
}

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
  await recordActivity(request, { userId: session.userId, action: "key_delete", details: { keyId: id, name: key.name ?? null } });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
