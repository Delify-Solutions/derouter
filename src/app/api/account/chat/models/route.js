import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getKeyGroupById } from "@/lib/localDb";
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/chat/models — what the signed-in customer can chat with: the
 * configured combos their group allows, split into text and image models. Combos
 * only; nothing here touches the network.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const group = session.user.groupId ? await getKeyGroupById(session.user.groupId).catch(() => null) : null;
  const allowedModels = group?.allowedModels ?? null;

  const [text, image] = await Promise.all([
    buildModelsList(["llm"], { allowedModels }).catch(() => []),
    buildModelsList(["image"], { allowedModels }).catch(() => []),
  ]);
  const ids = (list) => list.map((model) => ({ id: model.id, name: model.name || model.id }));
  return NextResponse.json({ text: ids(text), image: ids(image) }, { headers: NO_STORE });
}
