import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getKeyGroupById } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { customerModelScopeSync } from "@/lib/billing/customerModels.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/chat/models — what the signed-in customer can chat with: the
 * configured combos their group allows and a live purchase pays for, split into text
 * and image models. Combos only; nothing here touches the network.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const group = session.user.groupId ? await getKeyGroupById(session.user.groupId).catch(() => null) : null;
  // The group's list narrowed by the live purchases' own lists (spec plan-model-access):
  // offering a model no live plan pays for would just produce a 402.
  const db = await getAdapter();
  const allowedModels = customerModelScopeSync(db, session.userId, group?.allowedModels ?? null);

  const [text, image] = await Promise.all([
    buildModelsList(["llm"], { allowedModels }).catch(() => []),
    buildModelsList(["image"], { allowedModels }).catch(() => []),
  ]);
  const ids = (list) => list.map((model) => ({ id: model.id, name: model.name || model.id }));
  return NextResponse.json({ text: ids(text), image: ids(image) }, { headers: NO_STORE });
}
