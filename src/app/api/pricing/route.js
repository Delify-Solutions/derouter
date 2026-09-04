import { NextResponse } from "next/server";
import {
  getPricing, updatePricing, resetPricing, resetAllPricing,
  getComboPricing, updateComboPricing, resetComboPricing, resetAllComboPricing,
} from "@/lib/localDb.js";
import { getDefaultPricing } from "open-sse/providers/pricing.js";

const VALID_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

function validatePricingFields(pricing, label) {
  if (typeof pricing !== "object" || pricing === null) {
    return `Invalid pricing for ${label}`;
  }
  for (const [key, value] of Object.entries(pricing)) {
    if (!VALID_FIELDS.includes(key)) return `Invalid pricing field: ${key} for ${label}`;
    if (typeof value !== "number" || isNaN(value) || value < 0) {
      return `Invalid pricing value for ${key} in ${label}: must be non-negative number`;
    }
  }
  return null;
}

/**
 * GET /api/pricing
 * Get current pricing configuration. Query ?combo=1 returns combo-level pricing
 * (flat { comboName: {...} }); otherwise returns merged per-pool pricing.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url || "http://x");
    if (searchParams.get("combo")) {
      return NextResponse.json(await getComboPricing());
    }
    // ?defaults=1 → built-in PROVIDER_PRICING only (no user overrides). Used by the
    // pricing table to mark which rows are editable user overrides vs built-in.
    if (searchParams.get("defaults")) {
      return NextResponse.json(getDefaultPricing());
    }
    return NextResponse.json(await getPricing());
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return NextResponse.json({ error: "Failed to fetch pricing" }, { status: 500 });
  }
}

/**
 * PATCH /api/pricing
 * Combo-level pricing: body = { combo: { <comboName>: { input, output, cached, reasoning, cache_creation } } }
 * Per-pool pricing (legacy): body = { provider: { model: { ... } } }
 * The combo field is mutually exclusive with provider fields.
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Invalid pricing data format" }, { status: 400 });
    }

    // Combo-level pricing
    if (body.combo && typeof body.combo === "object") {
      const data = {};
      for (const [name, pricing] of Object.entries(body.combo)) {
        const err = validatePricingFields(pricing, `combo ${name}`);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
        data[name] = pricing;
      }
      const updated = await updateComboPricing(data);
      return NextResponse.json(updated);
    }

    // Per-pool pricing (legacy path)
    for (const [provider, models] of Object.entries(body)) {
      if (typeof models !== "object" || models === null) {
        return NextResponse.json({ error: `Invalid pricing for provider: ${provider}` }, { status: 400 });
      }
      for (const [model, pricing] of Object.entries(models)) {
        const err = validatePricingFields(pricing, `${provider}/${model}`);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
    }
    const updatedPricing = await updatePricing(body);
    return NextResponse.json(updatedPricing);
  } catch (error) {
    console.error("Error updating pricing:", error);
    return NextResponse.json({ error: "Failed to update pricing" }, { status: 500 });
  }
}

/**
 * DELETE /api/pricing
 * Reset pricing. ?combo=<name> resets one combo; ?combo=all resets all combo pricing.
 * ?provider=xxx&model=yyy resets a pooled model (legacy). No params resets all per-pool.
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const combo = searchParams.get("combo");
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (combo) {
      if (combo === "all") await resetAllComboPricing();
      else await resetComboPricing(combo);
      return NextResponse.json(await getComboPricing());
    }

    if (provider && model) await resetPricing(provider, model);
    else if (provider) await resetPricing(provider);
    else await resetAllPricing();
    return NextResponse.json(await getPricing());
  } catch (error) {
    console.error("Error resetting pricing:", error);
    return NextResponse.json({ error: "Failed to reset pricing" }, { status: 500 });
  }
}

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET_DEFAULTS() {
  try {
    const defaultPricing = getDefaultPricing();
    return NextResponse.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}