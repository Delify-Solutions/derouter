import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { updateComboPricing, resetComboPricing } from "@/lib/db/repos/comboPricingRepo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { pricing, capabilities } = body;

    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }

      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }

    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);

    // Merge capabilities into the combo's JSON meta blob. `capabilities: null`
    // explicitly clears stored capabilities (so /v1/models falls back to the
    // first-model auto-resolve); omitting the key leaves the existing value.
    let metaPatch = undefined;
    if (capabilities !== undefined) {
      const curMeta = prev?.meta && typeof prev.meta === "object" ? prev.meta : {};
      metaPatch = { ...curMeta, capabilities: capabilities || null };
    }
    const combo = await updateCombo(id, metaPatch ? { ...body, meta: metaPatch } : body);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    // Combo-level pricing handling.
    const newName = combo.name || body.name;
    const renamed = prev?.name && newName && newName !== prev.name;
    if (pricing && typeof pricing === "object" && Object.keys(pricing).length > 0) {
      // On rename, clear the old name's pricing first (then set the new name below).
      if (renamed) await resetComboPricing(prev.name);
      await updateComboPricing({ [newName]: pricing });
    } else if (renamed) {
      // Renamed without an explicit pricing payload: migrate the old pricing to the
      // new name so an edit that only touches the name doesn't silently drop prices.
      const { getPricingForCombo } = await import("@/lib/db/repos/comboPricingRepo.js");
      const oldPricing = await getPricingForCombo(prev.name);
      if (oldPricing) {
        await resetComboPricing(prev.name);
        await updateComboPricing({ [newName]: oldPricing });
      }
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) {
      resetComboRotation(prev.name);
      // Clean up combo-level pricing so deleted combos don't leave orphan prices.
      await resetComboPricing(prev.name);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
