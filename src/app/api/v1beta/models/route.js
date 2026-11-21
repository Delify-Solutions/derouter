import { PROVIDER_MODELS } from "@/shared/constants/models";
import { extractApiKey } from "@/lib/auth/apiKeyExtract.js";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { hideUpstreamModelsEnabled, isCustomerKeySync } from "@/lib/models/customerModels.js";
import { geminiCatalogModels, geminiComboModels } from "@/lib/models/geminiModelList.js";
import { buildModelsList, resolveKeyScopeForModels } from "@/app/api/v1/models/route.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format.
 *
 * A customer key (hideUpstreamModels on) gets the combos it may call, scoped
 * exactly like /v1/models; everyone else gets the built-in provider catalog
 * (spec model-privacy "Customer catalogs list only what the customer can call").
 */
export async function GET(request) {
  try {
    const apiKey = extractApiKey(request);
    if (apiKey && hideUpstreamModelsEnabled(await getSettings()) && isCustomerKeySync(await getAdapter(), apiKey)) {
      const scope = await resolveKeyScopeForModels(request);
      if (scope.response) return scope.response;
      const combos = await buildModelsList(["llm"], { allowedModels: scope.allowedModels });
      return Response.json({ models: geminiComboModels(combos) });
    }
    return Response.json({ models: geminiCatalogModels(PROVIDER_MODELS) });
  } catch {
    return Response.json({ error: { message: "Failed to list models" } }, { status: 500 });
  }
}
