import { NextResponse } from "next/server";
import { getApiKeyForAuth } from "@/lib/localDb";
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/usage/key/models?key=<apikey>
 * Public, like the rest of /api/usage/key/*: a key holder asks which models their
 * own key can call, split into text and image, so the /usage page can offer a try-it
 * panel without a login. Combos only, nothing here touches the network.
 *
 * 404 (generic) when the key is unknown, so existence is not leaked.
 */
export async function GET(request) {
  try {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return NextResponse.json({ error: "Not Found" }, { status: 404, headers: NO_STORE });

    const auth = await getApiKeyForAuth(key);
    if (!auth?.key) return NextResponse.json({ error: "Not Found" }, { status: 404, headers: NO_STORE });

    // null = every model the key's own settings allow; the same value the /v1
    // handlers enforce, so the list never offers a model the call would refuse.
    const allowedModels = auth.resolved?.allowedModels ?? null;
    const [text, image] = await Promise.all([
      buildModelsList(["llm"], { allowedModels }).catch(() => []),
      buildModelsList(["image"], { allowedModels }).catch(() => []),
    ]);
    const ids = (list) => list.map((model) => ({ id: model.id, name: model.name || model.id }));
    return NextResponse.json({ text: ids(text), image: ids(image) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Not Found" }, { status: 404, headers: NO_STORE });
  }
}
