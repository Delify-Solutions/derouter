import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { updateComboPricing } from "@/lib/db/repos/comboPricingRepo.js";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind, pricing, capabilities } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    // Capabilities live in the combo's JSON `meta` blob (no schema change).
    // Null/undefined → no entry → /v1/models auto-resolves from the first model.
    const meta = capabilities ? { capabilities } : {};
    const combo = await createCombo({ name, models: models || [], kind: kind || null, meta });

    // Optional combo-level pricing (5 fields). Save after the combo exists so the
    // pricing key (combo name) is valid even if the combo were to fail downstream.
    if (pricing && typeof pricing === "object" && Object.keys(pricing).length > 0) {
      await updateComboPricing({ [name]: pricing });
    }

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
