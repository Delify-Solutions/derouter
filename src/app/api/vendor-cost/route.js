import { NextResponse } from "next/server";
import { requirePagePermission } from "@/lib/auth/adminAccess";
import {
  getVendorCost, getVendorCostForModel, setVendorCostForModel, resetVendorCost,
} from "@/lib/db/repos/vendorCostRepo.js";

const RATE_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateRate(rate, label) {
  if (typeof rate !== "object" || rate === null) return `Invalid vendor-cost rate for ${label}`;
  for (const [key, value] of Object.entries(rate)) {
    if (!RATE_FIELDS.includes(key)) return `Invalid vendor-cost field: ${key} for ${label}`;
    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
      return `Invalid vendor-cost value for ${key} in ${label}: must be a non-negative number`;
    }
  }
  return null;
}

/**
 * GET /api/vendor-cost?provider=xxx&model=yyy
 * The raw vendor-cost record ({ rate, offPeak? }) for one (provider, model) pair, or
 * { record: null } when none is set.
 *
 * GET /api/vendor-cost?provider=xxx (no model)
 * Every vendor-cost record set for that provider: { records: { model: record } } — used
 * by the Providers page to mark which already-added models have one set.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    if (!provider) {
      return NextResponse.json({ error: "provider required" }, { status: 400 });
    }
    if (!model) {
      const all = await getVendorCost();
      return NextResponse.json({ records: all[provider] || {} });
    }
    const record = await getVendorCostForModel(provider, model);
    return NextResponse.json({ record });
  } catch (error) {
    console.error("Error fetching vendor cost:", error);
    return NextResponse.json({ error: "Failed to fetch vendor cost" }, { status: 500 });
  }
}

/**
 * PATCH /api/vendor-cost
 * body: { provider, model, rate: {...}, offPeak?: { rate: {...}, start: "HH:MM", end: "HH:MM" } }
 * Sets (or replaces) the vendor-cost record for exactly one (provider, model) pair. Never
 * touches pricingRepo / customer billing.
 */
export async function PATCH(request) {
  const denied = await requirePagePermission(request, "providers", "edit");
  if (denied) return denied;
  try {
    const body = await request.json();
    const { provider, model, rate, offPeak } = body || {};
    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model required" }, { status: 400 });
    }
    const rateErr = validateRate(rate, `${provider}/${model}`);
    if (rateErr) return NextResponse.json({ error: rateErr }, { status: 400 });

    let cleanOffPeak;
    if (offPeak != null) {
      if (typeof offPeak !== "object") {
        return NextResponse.json({ error: "Invalid offPeak" }, { status: 400 });
      }
      const offPeakErr = validateRate(offPeak.rate, `${provider}/${model} (off-peak)`);
      if (offPeakErr) return NextResponse.json({ error: offPeakErr }, { status: 400 });
      if (!TIME_RE.test(offPeak.start) || !TIME_RE.test(offPeak.end)) {
        return NextResponse.json({ error: "offPeak.start and offPeak.end must be HH:MM" }, { status: 400 });
      }
      cleanOffPeak = { rate: offPeak.rate, start: offPeak.start, end: offPeak.end };
    }

    const record = { rate, ...(cleanOffPeak ? { offPeak: cleanOffPeak } : {}) };
    await setVendorCostForModel(provider, model, record);
    return NextResponse.json({ record });
  } catch (error) {
    console.error("Error updating vendor cost:", error);
    return NextResponse.json({ error: "Failed to update vendor cost" }, { status: 500 });
  }
}

/**
 * DELETE /api/vendor-cost?provider=xxx&model=yyy
 * Clears the vendor-cost record for one (provider, model) pair.
 */
export async function DELETE(request) {
  const denied = await requirePagePermission(request, "providers", "delete");
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model required" }, { status: 400 });
    }
    await resetVendorCost(provider, model);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error resetting vendor cost:", error);
    return NextResponse.json({ error: "Failed to reset vendor cost" }, { status: 500 });
  }
}
