import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, createProviderConnection } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

/**
 * A name that does not already belong to another connection under this provider.
 * createProviderConnection's own dedup (connectionsRepo.js) merges a new apikey
 * connection onto an existing one sharing the same name instead of inserting a
 * row — so a second clone of the same source must not collide with the first.
 */
function uniqueCloneName(baseName, existingNames) {
  const taken = new Set(existingNames);
  let candidate = `${baseName} (sao chép)`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${baseName} (sao chép ${n})`;
    n += 1;
  }
  return candidate;
}

/**
 * POST /api/providers/[id]/clone — duplicate one Compatible connection (endpoint,
 * API key, model config) into a brand new, independent connection under the same
 * node, so the admin can use it as a starting point without touching the original.
 *
 * Scoped to Compatible (OpenAI/Anthropic-compatible) providers only: those are the
 * ones an admin defines themselves (custom endpoint + models), closest to what was
 * asked for. The real API key never crosses the wire to the browser — it is read
 * decrypted server-side (getProviderConnectionById already does this) and handed
 * straight to createProviderConnection, which re-encrypts it before it ever
 * reaches SQLite; the response strips every secret field same as every other
 * provider endpoint.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const source = await getProviderConnectionById(id);
    if (!source) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (!isOpenAICompatibleProvider(source.provider) && !isAnthropicCompatibleProvider(source.provider)) {
      return NextResponse.json({ error: "Only Compatible provider connections can be cloned" }, { status: 400 });
    }

    const siblings = await getProviderConnections({ provider: source.provider });
    const name = uniqueCloneName(source.name || "Connection", siblings.map((c) => c.name).filter(Boolean));

    const clone = await createProviderConnection({
      provider: source.provider,
      authType: source.authType,
      name,
      apiKey: source.apiKey || "",
      globalPriority: source.globalPriority ?? null,
      defaultModel: source.defaultModel ?? null,
      providerSpecificData: source.providerSpecificData ? { ...source.providerSpecificData } : undefined,
      isActive: source.isActive ?? true,
      testStatus: "unknown",
    });

    const result = { ...clone };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to clone connection" }, { status: 500 });
  }
}
